/**
 * The ladder service (PLAN §5 T8) — turns `index_closes` rows into the day's
 * bettable options and validates a pick against them.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *  • {@link getLadderForDate} resolves the ANCHOR for each index: the previous
 *    trading day's close, read out of `index_closes` (the poller seeds it as
 *    `live_approx` during the auction, the settlement engine (T9) lands the
 *    exchange-official close). Cached per process for the day — the anchors of a
 *    trade date are immutable once known, so a per-request DB walk is pure waste.
 *  • {@link resolveLadderOption} is THE server-side validation used by bet
 *    placement: the client sends `(underlying, targetKind, deltaPoints)` and gets
 *    back the configured odds, or null. **Odds are never accepted from a client**
 *    — a tampered `odds` field would be a money printer (T7 service, PLAN §5 T7
 *    step 2).
 *
 * Anchor semantics, because `index_closes` carries two meanings under one roof:
 *   source = 'official'    → `close` is that day's own close (written ~15:43 by T9)
 *   source = 'live_approx' → `close` is the PREVIOUS day's close (the poller's
 *                            anchor write for that day, PLAN §2 "prevClose")
 * Both are "the previous day's close" from the ladder's point of view, so the
 * search prefers the nearest `official` row and falls back to the nearest
 * `live_approx` row (today's own included). A ladder built before any official
 * close exists — the first day of a fresh deployment, or 15:00 before the
 * 15:13:30 poll — still works off the feed's prevClose.
 */
import {
	generateLadderOptions,
	LADDER_UNDERLYINGS,
	type LadderForDate,
	type LadderOption,
	type LadderTargetKind,
	type LadderUnderlying
} from '$lib/config/ladder';
import { isWeekend, shiftIstDate } from '$lib/time/ist';
import { getStore, type GameStore } from '$lib/server/db';
import type { IndexClose, Underlying } from '$lib/server/db/types';

/** How many calendar days back the anchor hunt walks before giving up. */
export const LADDER_MAX_LOOKBACK_DAYS = 10;

/**
 * Ten days skips two full weekends plus the longest run of back-to-back market
 * holidays; beyond that there is no honest anchor to bet against and an index
 * simply has no ladder that day.
 */

/** Compile-time guard: the config's index union and the DB's must never drift. */
const UNDERLYING_PARITY: Record<Underlying, LadderUnderlying> = {
	nifty: 'nifty',
	banknifty: 'banknifty',
	sensex: 'sensex'
};
void UNDERLYING_PARITY;

/** `date` → `underlying` → row, accumulated over the walk-back window. */
type CloseIndex = Map<string, Map<Underlying, IndexClose>>;

/** A close only anchors a ladder when it is a positive real number. */
function usableClose(row: IndexClose): number | null {
	return Number.isFinite(row.close) && row.close > 0 ? row.close : null;
}

/**
 * Read every close the ladder might need in as few queries as possible: today's
 * own row (the `live_approx` fallback) plus each non-weekend day going back,
 * stopping the walk early once all three indices have an official close.
 */
async function loadCloseIndex(store: GameStore, tradeDate: string): Promise<CloseIndex> {
	const index: CloseIndex = new Map();

	const hasOfficialFor = (underlying: LadderUnderlying): boolean => {
		for (const byUnderlying of index.values()) {
			if (byUnderlying.get(underlying as Underlying)?.source === 'official') return true;
		}
		return false;
	};

	const read = async (date: string): Promise<void> => {
		if (index.has(date)) return;
		const byUnderlying = new Map<Underlying, IndexClose>();
		for (const row of await store.closes.getIndexCloses(date)) {
			byUnderlying.set(row.underlying, row);
		}
		index.set(date, byUnderlying);
	};

	await read(tradeDate);

	// Nearest previous trading day first — weekends are skipped, not terminal.
	for (let back = 1; back <= LADDER_MAX_LOOKBACK_DAYS; back += 1) {
		if (LADDER_UNDERLYINGS.every(hasOfficialFor)) break;
		const date = shiftIstDate(tradeDate, -back);
		if (isWeekend(date)) continue; // no session, no close
		await read(date);
	}
	return index;
}

/**
 * The anchor for one index: the nearest `official` close in the walk-back window,
 * else the nearest `live_approx` row (today's own feed-carried prevClose is the
 * first fallback), else null — "no anchor, no bets on this index today".
 */
function pickAnchor(
	index: CloseIndex,
	tradeDate: string,
	underlying: LadderUnderlying
): number | null {
	let fallback: IndexClose | null = index.get(tradeDate)?.get(underlying as Underlying) ?? null;

	for (const [date, byUnderlying] of index) {
		// Today's own row is not "the previous day's close" — it is only ever a
		// fallback, so it stays out of the hunt for an official one.
		if (date === tradeDate) continue;
		const row = byUnderlying.get(underlying as Underlying);
		if (!row) continue;
		if (row.source === 'official') return usableClose(row);
		if (fallback === null) fallback = row;
	}
	return fallback === null ? null : usableClose(fallback);
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

/** Per-process ladder cache, keyed by IST trade date (see `invalidateLadderCache`). */
const ladderCache = new Map<string, LadderForDate>();

/** Bounded cache: a server that runs for weeks must not remember every day. */
const CACHE_MAX_DAYS = 4;

/**
 * The day's ladder, cached per process for the trade date.
 *
 * `store` is an explicit parameter (not a default) because tests build throwaway
 * stores: call {@link invalidateLadderCache} whenever the anchors under a given
 * trade date change behind this module's back.
 */
export async function getLadderForDate(
	store: GameStore,
	tradeDate: string
): Promise<LadderForDate> {
	const cached = ladderCache.get(tradeDate);
	if (cached) return cached;

	const index = await loadCloseIndex(store, tradeDate);
	const anchors: Record<LadderUnderlying, number | null> = {
		nifty: pickAnchor(index, tradeDate, 'nifty'),
		banknifty: pickAnchor(index, tradeDate, 'banknifty'),
		sensex: pickAnchor(index, tradeDate, 'sensex')
	};

	const ladder: LadderForDate = {
		tradeDate,
		anchors,
		options: generateLadderOptions(anchors),
		generatedAt: Date.now()
	};

	if (ladderCache.size >= CACHE_MAX_DAYS) {
		// Drop the stalest date. Keys are ISO dates, so string order is time order.
		const stalest = [...ladderCache.keys()].sort()[0];
		if (stalest !== undefined) ladderCache.delete(stalest);
	}
	ladderCache.set(tradeDate, ladder);
	return ladder;
}

/** Forget every cached ladder. Test-only (and after a manual `index_closes` fix). */
export function invalidateLadderCache(): void {
	ladderCache.clear();
}

/**
 * Validate a pick against today's ladder and return it with its configured odds —
 * or null when it is not on the ladder, which the bet service maps to
 * `INVALID_TARGET` (400).
 *
 * `store` defaults to the process store so the T7 call site stays short; tests
 * pass one explicitly.
 */
export async function resolveLadderOption(
	tradeDate: string,
	underlying: LadderUnderlying,
	targetKind: LadderTargetKind,
	deltaPoints: number,
	store: GameStore = getStore()
): Promise<LadderOption | null> {
	const ladder = await getLadderForDate(store, tradeDate);
	return (
		ladder.options.find(
			(option) =>
				option.underlying === underlying &&
				option.targetKind === targetKind &&
				option.deltaPoints === deltaPoints
		) ?? null
	);
}
