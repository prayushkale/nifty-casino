/**
 * ltp — the last-traded-price service (the pre-auction display + the betting anchor).
 *
 * The game's reference price changed: bets are NOT measured against yesterday's
 * close any more, they are measured against the LAST TRADED PRICE at 15:15:01 IST
 * — the instant the spot market's final print is frozen, one second before the
 * participation window opens and five minutes before the cash (CAS) session
 * starts ticking. This module owns that price end to end:
 *
 *  • {@link fetchLiveLtp}     — the live LTP per index, best-effort, cached for
 *    {@link LTP_SERVER_CACHE_MS} so N open tabs cost NSE one fetch per TTL.
 *  • {@link persistLtpAnchors}— the 15:15:01 capture: `index_closes` rows with
 *    `source = 'ltp_anchor'`, written first-wins and never over an official close.
 *  • {@link ensureLtpAnchors} — fetch + persist for the paths that only notice
 *    the anchor is missing at 15:15+ (a bet placed the second the window opens).
 *  • {@link ltpAnchorCloses}  — the persisted anchors, read back for /api/ltp.
 *
 * After 15:15:01 the LTP is STATIC by definition (the spot session is over), so
 * a value fetched later is the same value the 15:15:01 capture saw — which is
 * why `ensureLtpAnchors` is safe to run late and why a page that loads at 15:40
 * still shows the frozen anchor.
 */
import { LTP_ANCHOR_HMS, LTP_SERVER_CACHE_MS } from '$lib/config/app';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { hmsToSeconds, isWeekend, istDateStr, secOfDayIst } from '$lib/time/ist';
import { fetchBseSensexRows } from './cas/bse-api';
import { fetchIndexData } from './cas/nse-api';
import { extractBseLtp, extractNseLtp, type LtpQuote } from './cas/types';
import { invalidateLadderCache } from './ladder';
import type { GameStore } from './db';
import type { Underlying } from './db/types';

/** Injectable fetchers so tests never touch the real feeds. */
export type LtpDeps = {
	fetchNseIndexData?: () => Promise<unknown>;
	fetchBseSensexRows?: () => Promise<unknown[]>;
};

/** Per-index LTP quotes, `null` wherever the feed had nothing usable. */
export type LtpQuotes = Record<LadderUnderlying, LtpQuote | null>;

const NULL_QUOTES: LtpQuotes = { nifty: null, banknifty: null, sensex: null };

// ---------------------------------------------------------------------------
// the live fetch + its short cache
// ---------------------------------------------------------------------------

let cachedQuotes: LtpQuotes | null = null;
let cachedAtMs = 0;

/** Test-only: drop the cached live quotes (and only the cache — not the DB). */
export function invalidateLtpCache(): void {
	cachedQuotes = null;
	cachedAtMs = 0;
}

/**
 * The live LTP per index. Never throws — a blocked or empty upstream leaves that
 * index null and the caller keeps whatever it had. The 20s cache is deliberately
 * shared by every caller (routes, poller, ladder fallback): the LTP moves at the
 * exchange's tick rate, not at ours, and Akamai throttles bursts.
 */
export async function fetchLiveLtp(deps: LtpDeps = {}): Promise<LtpQuotes> {
	if (
		Object.keys(deps).length === 0 &&
		cachedQuotes !== null &&
		Date.now() - cachedAtMs < LTP_SERVER_CACHE_MS
	) {
		return cachedQuotes;
	}
	const ts = Date.now();
	const out: LtpQuotes = { ...NULL_QUOTES };
	const [nse, bse] = await Promise.allSettled([
		deps.fetchNseIndexData ? deps.fetchNseIndexData() : fetchIndexData(),
		deps.fetchBseSensexRows ? deps.fetchBseSensexRows() : fetchBseSensexRows()
	]);
	if (nse.status === 'fulfilled') {
		out.nifty = extractNseLtp(nse.value, 'nifty', ts);
		out.banknifty = extractNseLtp(nse.value, 'banknifty', ts);
	}
	if (bse.status === 'fulfilled') {
		out.sensex = extractBseLtp(bse.value, ts);
	}
	if (Object.keys(deps).length === 0) {
		cachedQuotes = out;
		cachedAtMs = ts;
	}
	return out;
}

// ---------------------------------------------------------------------------
// the 15:15:01 anchor — persist, ensure, read back
// ---------------------------------------------------------------------------

/** True when `now` is at or past the LTP anchor instant on a trading day. */
export function isLtpAnchorDue(now: Date): boolean {
	if (isWeekend(istDateStr(now))) return false;
	return secOfDayIst(now) >= hmsToSeconds(LTP_ANCHOR_HMS);
}

/** Which of the quotes are usable anchor values (a positive real price). */
function usableQuotes(quotes: LtpQuotes): LtpQuote[] {
	return LADDER_UNDERLYINGS.map((u) => quotes[u]).filter(
		(q): q is LtpQuote => q !== null && Number.isFinite(q.value) && q.value > 0
	);
}

/**
 * Persist the anchor rows for the quotes given. First write per (day, underlying)
 * wins at the DB level; a row that already holds the official close is never
 * touched. Returns the underlyings whose anchor was newly written this call.
 * The ladder cache is invalidated so the next read re-resolves onto the anchor.
 */
export async function persistLtpAnchors(
	store: GameStore,
	tradeDate: string,
	quotes: LtpQuotes
): Promise<LadderUnderlying[]> {
	const written: LadderUnderlying[] = [];
	for (const quote of usableQuotes(quotes)) {
		try {
			const inserted = await store.closes.upsertIndexLtpAnchor({
				tradeDate,
				underlying: quote.underlying as Underlying,
				close: quote.value
			});
			if (inserted) written.push(quote.underlying);
		} catch {
			// One index's DB hiccup must not stop the others; the next caller retries.
		}
	}
	if (written.length > 0) invalidateLadderCache();
	return written;
}

/**
 * Make sure the day's anchor exists for every index we can price, and return the
 * effective quotes. `fetchLtp` supplies the live quotes when the DB is missing
 * them (injected in tests). At/after 15:15:01 the LTP is frozen, so a late fetch
 * IS the anchor — first writer wins, everyone else converges on the same number.
 * Before 15:15:01 this is a no-op read: the anchor is not due yet.
 */
export async function ensureLtpAnchors(
	store: GameStore,
	tradeDate: string,
	now: Date,
	fetchLtp: (deps?: LtpDeps) => Promise<LtpQuotes> = fetchLiveLtp
): Promise<LtpQuotes> {
	const existing = await readLtpAnchors(store, tradeDate);
	if (LADDER_UNDERLYINGS.every((u) => existing[u] !== null)) return existing;
	if (!isLtpAnchorDue(now)) return existing;
	const live = await fetchLtp();
	const merged: LtpQuotes = { ...live };
	for (const u of LADDER_UNDERLYINGS) {
		// A row that is already anchored (by the poller, or an earlier request) wins.
		if (existing[u] !== null) merged[u] = existing[u];
	}
	await persistLtpAnchors(store, tradeDate, merged);
	return merged;
}

/**
 * Fill the holes in a DB anchor set with the LIVE last traded price — the same
 * number the chart's first point shows on first load.
 *
 * The ladder's anchor is "the last traded price" by game rule, but before the
 * 15:15:01 LTP anchor freezes (or when its DB row is missing) the DB walk
 * resolves to the previous trading day's close. A player staring at a chart
 * whose first point is today's LTP must not see a ladder anchored on
 * yesterday's close: the live LTP WINS here, with the DB anchor kept only as
 * the fallback for an index the feeds could not price. Best-effort and never
 * throwing, exactly like {@link fetchLiveLtp}.
 */
export async function fillAnchorsFromLtp(
	anchors: Record<LadderUnderlying, number | null>,
	deps: LtpDeps = {},
	fetchLtp: (deps?: LtpDeps) => Promise<LtpQuotes> = fetchLiveLtp
): Promise<Record<LadderUnderlying, number | null>> {
	const live = await fetchLtp(deps);
	return {
		nifty: live.nifty?.value ?? anchors.nifty,
		banknifty: live.banknifty?.value ?? anchors.banknifty,
		sensex: live.sensex?.value ?? anchors.sensex
	};
}

/**
 * The day's persisted `ltp_anchor` rows, as quotes. `prevClose`/`changePts` are
 * unknown to the anchor row itself (it stores only the price), so they read as
 * null/0 — the anchor's job is the LEVEL, not the move.
 */
export async function readLtpAnchors(store: GameStore, tradeDate: string): Promise<LtpQuotes> {
	const out: LtpQuotes = { ...NULL_QUOTES };
	try {
		const rows = await store.closes.getIndexCloses(tradeDate);
		for (const row of rows) {
			if (row.source !== 'ltp_anchor') continue;
			if (!(Number.isFinite(row.close) && row.close > 0)) continue;
			const underlying = row.underlying as LadderUnderlying;
			if (!LADDER_UNDERLYINGS.includes(underlying)) continue;
			out[underlying] = {
				underlying,
				value: row.close,
				changePts: 0,
				changePct: 0,
				prevClose: null,
				ts: 0,
				source: 'nse'
			};
		}
	} catch {
		// A DB hiccup reads as "no anchors yet" — callers fall back to the live fetch.
	}
	return out;
}
