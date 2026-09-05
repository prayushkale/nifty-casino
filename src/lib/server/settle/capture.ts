/**
 * Official-close capture (PLAN §5 T9) — the step that turns a live CAS indicative
 * into the number we settle against.
 *
 * WHY A SEPARATE STEP: the ladder's anchors and the poller's ticks are all
 * approximations of a market in motion; a payout needs the exchange's own closing
 * number. `index_closes` carries both under one roof (`source = 'live_approx'` is
 * the poller's previous-day anchor, `source = 'official'` is a real close), and
 * this module is the ONLY writer of `official` rows. `upsertIndexClose` overwrites,
 * so an official close replaces the live anchor it landed on top of and then wins
 * for good.
 *
 * THE ONE RULE: never write a close we are not sure of. A zero, a negative, a NaN
 * or a `'-'` from BSE means "not published yet", not "closed at zero" — writing it
 * would settle a day at an invented price. Anything doubtful is left out of the
 * report's `captured` list so the scheduler retries, and a day that never produces
 * all three closes is never settled (PLAN §6 R2: re-check, never blind-fire).
 *
 * Single-shot by design: one call = one fetch + one write pass. The re-check loop
 * lives in ../settle/scheduler, which owns the clock; keeping the two apart is what
 * lets tests inject a fetcher and a `now` without a timer in sight.
 */
import { MARKET_CLOSE_HMS } from '$lib/config/app';
import { LADDER_UNDERLYINGS, round2 } from '$lib/config/ladder';
import { istDateStr, istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import { fetchBseSensexRows } from '$lib/server/cas/bse-api';
import { fetchIndexData, fetchMarketStatus } from '$lib/server/cas/nse-api';
import {
	extractBseCasTick,
	extractBseLtp,
	extractNseCasTicks,
	extractNseLtp,
	extractNseMarketStatusIndicative
} from '$lib/server/cas/types';
import type { GameStore } from '$lib/server/db';
import type { CloseSource, Underlying } from '$lib/server/db/types';

/** Where an official close came from — provenance for a number money moves against. */
export type CloseOrigin = 'nse-e1' | 'nse-e3' | 'bse' | 'nse-e1-ltp' | 'bse-ltp';

/**
 * The three upstream reads, injectable so tests (and a dry-run script) never touch
 * NSE/BSE. Defaults to the T3 clients.
 */
export type OfficialCloseFetchers = {
	/** NSE E1 — indicative closes for NIFTY 50 + NIFTY BANK. */
	fetchNseIndexData: () => Promise<unknown>;
	/** NSE E3 — market status, carrying `indicativenifty50.closingValue`. */
	fetchNseMarketStatus: () => Promise<unknown>;
	/** BSE `GetSensexDatanew` rows — the SENSEX indicative. */
	fetchBseSensexRows: () => Promise<unknown>;
};

export const realOfficialCloseFetchers: OfficialCloseFetchers = {
	fetchNseIndexData: fetchIndexData,
	fetchNseMarketStatus: fetchMarketStatus,
	fetchBseSensexRows
};

/**
 * 15:30:00 IST of `tradeDate`, in epoch ms — the market close. From this instant
 * the final prices are frozen in the feeds, so the scheduler and a manual
 * `settleNow` may capture from here on.
 */
export function marketCloseMsFor(tradeDate: string): number {
	return istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), MARKET_CLOSE_HMS);
}

/** A number a payout may be computed from. Everything else means "not yet". */
function usableClose(value: number | null | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export type CaptureReport = {
	tradeDate: string;
	/** False when the auction-end guard refused: nothing was fetched, nothing written. */
	attempted: boolean;
	/** Set only when {@link attempted} is false. */
	reason?: 'BEFORE_AUCTION_END';
	/** Underlyings with a usable official close after this call (written or already there). */
	captured: Underlying[];
	/** Underlyings still missing — the scheduler's retry list. */
	missing: Underlying[];
	/** Underlyings whose `index_closes` row was written by THIS call. */
	written: Underlying[];
	/** Provenance of each close this call saw. */
	origins: Partial<Record<Underlying, CloseOrigin>>;
	/** Upstream reads that failed. Never thrown — a blocked exchange is a retry, not a crash. */
	errors: string[];
	/** Cross-check disagreements (E1 vs E3 for NIFTY). The E1 value still wins. */
	warnings: string[];
};

/** The E1-vs-E3 divergence (as a fraction of the level) above which we say so. */
const CROSS_CHECK_TOLERANCE = 0.001;

/**
 * Fetch the official closes for `now`'s IST trade date and land them in
 * `index_closes` as `source: 'official'`.
 *
 * Guarantees, in order of importance:
 *  • refuses outright before 15:30:00 IST of the trade date (the market is still
 *    open; a close captured now would be wrong, and we do not get to redo it)
 *  • writes ONLY positive finite values, and only the ones it actually extracted
 *  • never overwrites a row that is already `official` (a re-run is a no-op, not a
 *    revision), but still counts such an underlying as captured
 *  • one upstream failure degrades to "that index is missing" — the other two
 *    still land
 */
export async function captureOfficialCloses(
	store: GameStore,
	now: Date = new Date(),
	fetchers: OfficialCloseFetchers = realOfficialCloseFetchers
): Promise<CaptureReport> {
	const tradeDate = istDateStr(now);
	const report: CaptureReport = {
		tradeDate,
		attempted: false,
		captured: [],
		missing: [],
		written: [],
		origins: {},
		errors: [],
		warnings: []
	};

	// The guard is "has the auction finished", not "am I inside a window": a call at
	// 03:00 IST is past the auction end of ITS trade date and may legitimately
	// re-read the closes (that is the manual `settleNow` path), while a call at
	// 15:41:59 must not.
	if (now.getTime() < marketCloseMsFor(tradeDate)) {
		return { ...report, reason: 'BEFORE_AUCTION_END' };
	}
	report.attempted = true;

	// What we saw, best candidate per underlying. E1 outranks E3 (it carries both
	// NSE indices and the exchange's own indicative close field).
	const seen = new Map<Underlying, { close: number; origin: CloseOrigin }>();
	const offer = (underlying: Underlying, close: number, origin: CloseOrigin): void => {
		if (!usableClose(close)) return; // 0 / NaN / negative = "not published yet"
		if (seen.has(underlying)) return; // the earlier (indicative) read wins
		seen.set(underlying, { close: round2(close), origin });
	};

	const ts = now.getTime();

	// E1 — the primary read for NIFTY 50 and NIFTY BANK (kept for the LTP fallback).
	let nseRaw: unknown = null;
	try {
		nseRaw = await fetchers.fetchNseIndexData();
		for (const tick of extractNseCasTicks(nseRaw, ts)) {
			offer(tick.underlying, tick.value, 'nse-e1');
		}
	} catch (err: unknown) {
		report.errors.push(`nse-e1: ${errorMessage(err)}`);
	}

	// E3 — cross-check for NIFTY, and the fallback when E1 has not started publishing.
	try {
		const raw = await fetchers.fetchNseMarketStatus();
		const indicative = extractNseMarketStatusIndicative(raw);
		if (indicative && usableClose(indicative.closingValue)) {
			const fromE1 = seen.get('nifty');
			if (fromE1) {
				const drift = Math.abs(fromE1.close - indicative.closingValue) / fromE1.close;
				if (drift > CROSS_CHECK_TOLERANCE) {
					report.warnings.push(
						`nifty cross-check drift: E1 ${fromE1.close} vs E3 ${indicative.closingValue} ` +
							`(${(drift * 100).toFixed(3)}%) — keeping E1`
					);
				}
			} else {
				offer('nifty', indicative.closingValue, 'nse-e3');
			}
		}
	} catch (err: unknown) {
		report.errors.push(`nse-e3: ${errorMessage(err)}`);
	}

	// BSE — the only source for SENSEX (kept for the LTP fallback).
	let bseRaw: unknown = null;
	try {
		bseRaw = await fetchers.fetchBseSensexRows();
		const tick = extractBseCasTick(bseRaw, ts);
		if (tick) offer('sensex', tick.value, 'bse');
	} catch (err: unknown) {
		report.errors.push(`bse: ${errorMessage(err)}`);
	}

	// Closing-LTP fallback: the indicative-close fields are zeroed out by both
	// exchanges within minutes of the CAS window ending, but the last-traded price
	// freezes at the 15:30 close and stays in the feed. It IS the final price —
	// use it for anything the indicatives did not provide.
	if (nseRaw !== null) {
		for (const underlying of ['nifty', 'banknifty'] as const) {
			if (seen.has(underlying)) continue;
			const quote = extractNseLtp(nseRaw, underlying, ts);
			if (quote) offer(underlying, quote.value, 'nse-e1-ltp');
		}
	}
	if (bseRaw !== null) {
		const quote = extractBseLtp(bseRaw, ts);
		if (quote) offer('sensex', quote.value, 'bse-ltp');
	}

	// What is already official stays official: `upsertIndexClose` would overwrite it
	// with the same number, but re-writing a settled fact on every retry is churn
	// the poller's `IfAbsent` path specifically avoids.
	let alreadyOfficial: Partial<Record<Underlying, boolean>> = {};
	try {
		const rows = await store.closes.getIndexCloses(tradeDate);
		alreadyOfficial = Object.fromEntries(
			rows
				.filter((row) => row.source === ('official' satisfies CloseSource))
				.map((row) => [row.underlying, true])
		);
	} catch (err: unknown) {
		// Reads failing is not fatal: the write below still lands, worst case twice.
		report.errors.push(`index_closes read: ${errorMessage(err)}`);
	}

	for (const underlying of LADDER_UNDERLYINGS) {
		const candidate = seen.get(underlying);
		if (!candidate) {
			report.missing.push(underlying);
			continue;
		}
		report.origins[underlying] = candidate.origin;
		if (alreadyOfficial[underlying]) {
			report.captured.push(underlying);
			continue;
		}
		await store.closes.upsertIndexClose({
			tradeDate,
			underlying,
			close: candidate.close,
			source: 'official'
		});
		report.written.push(underlying);
		report.captured.push(underlying);
	}

	return report;
}

/** True when every tradable index has an official close — the gate on settlement. */
export function captureIsComplete(report: CaptureReport): boolean {
	return report.attempted && report.missing.length === 0;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === 'string' ? err : 'unknown error';
}
