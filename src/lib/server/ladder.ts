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
 * Anchor semantics, because `index_closes` carries three meanings under one roof:
 *   source = 'ltp_anchor'  → `close` is TODAY's last traded price at 15:15:01 IST —
 *                            the game's reference price, frozen when the spot market
 *                            stopped. It outranks every walk-back row.
 *   source = 'official'    → `close` is that day's own close (written ~15:43 by T9)
 *   source = 'live_approx' → `close` is the PREVIOUS day's close (the poller's
 *                            fallback write, PLAN §2 "prevClose")
 * The search prefers today's `ltp_anchor` row, then the nearest `official` row,
 * then the nearest `live_approx` row. A ladder built before any anchor exists —
 * the first day of a fresh deployment — still resolves via the live fallbacks in
 * {@link getLadderForDateWithLiveFallback}.
 */
import {
	generateLadderOptions,
	LADDER_UNDERLYINGS,
	type LadderForDate,
	type LadderOption,
	type LadderTargetKind,
	type LadderUnderlying
} from '$lib/config/ladder';
import { ensureLtpAnchors, fetchLiveLtp, isLtpAnchorDue, readLtpAnchors } from '$lib/server/ltp';
import { fillAnchorsFromLive, type LiveCloseDeps } from '$lib/server/live-closes';
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
		for (const [date, byUnderlying] of index) {
			// Today's own row is never proof that an official close exists: after the
			// settlement engine (T9) lands today's close, that row IS today's close, and
			// treating it as an anchor would make every Δ zero. Only a previous day counts.
			if (date === tradeDate) continue;
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
 * The anchor for one index, in priority order:
 *
 *   1. TODAY's `ltp_anchor` row — the last traded price at 15:15:01 IST, frozen
 *      when the spot market stopped. This is THE game's reference price for the
 *      day, so the moment it exists it beats every walk-back row.
 *   2. the nearest `official` close from a previous day,
 *   3. the nearest `live_approx` row (today's own feed-carried prevClose) —
 *      the poller's fallback for the rare day the LTP capture failed.
 */
function pickAnchor(
	index: CloseIndex,
	tradeDate: string,
	underlying: LadderUnderlying
): number | null {
	const todayRow = index.get(tradeDate)?.get(underlying as Underlying) ?? null;

	// The 15:15:01 LTP anchor IS the day's reference price — it wins outright.
	if (todayRow?.source === 'ltp_anchor') return usableClose(todayRow);

	// Today's own non-LTP row is only ever a fallback. Once the day has an OFFICIAL
	// close of its own it is a close, not an anchor — using it would measure every
	// move against zero and refund the whole day.
	let fallback: IndexClose | null = todayRow?.source === 'official' ? null : todayRow;

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
 * The day's ladder with the live fallback.
 *
 * `getLadderForDate` is DB-only by design (pure, cacheable, hermetic in tests).
 * This wrapper layers the best-effort live fetch over it for any index whose DB
 * anchor is still null:
 *
 *  • at/after 15:15:01 IST the missing anchor is the frozen last traded price —
 *    fetched and PERSISTED (`source = 'ltp_anchor'`) right here, so the first
 *    request that notices wins and every later read finds it in the DB (see
 *    `$lib/server/ltp`);
 *  • before 15:15:01 it falls back to the last closing price the feeds carry —
 *    a preview ladder only, since the real anchor is not set yet and bets are
 *    not open.
 *
 * `liveDeps` injects the fetchers (tests) — omit it in production to hit the real
 * feeds, or pass `false` for the DB-only ladder (hermetic tests). `now` is
 * injectable for the same reason.
 */
export async function getLadderForDateWithLiveFallback(
	store: GameStore,
	tradeDate: string,
	liveDeps: LiveCloseDeps | false = {},
	now: Date = new Date()
): Promise<LadderForDate> {
	if (liveDeps === false) return getLadderForDate(store, tradeDate);

	if (isLtpAnchorDue(now)) {
		// Past 15:15:01 the LTP is the anchor — and it outranks whatever the process
		// cache holds, which may have been built BEFORE 15:15:01 from prev-close
		// rows and must never outlive the anchor landing.
		const anchored = await readLtpAnchors(store, tradeDate);
		const allAnchored = LADDER_UNDERLYINGS.every((u) => anchored[u] !== null);
		if (allAnchored) {
			// Every index has its LTP anchor in the DB — no upstream fetch may happen.
			// The only danger is a stale cache entry from before the anchor landed, so
			// re-resolve unless the cache already agrees with the rows.
			const cached = await getLadderForDate(store, tradeDate);
			const cacheAgrees = LADDER_UNDERLYINGS.every(
				(u) => cached.anchors[u] !== null && cached.anchors[u] === anchored[u]?.value
			);
			if (cacheAgrees) return cached;
			invalidateLadderCache();
			const reloaded = await getLadderForDate(store, tradeDate);
			if (
				reloaded.anchors.nifty !== null &&
				reloaded.anchors.banknifty !== null &&
				reloaded.anchors.sensex !== null
			) {
				return reloaded;
			}
		} else {
			// Missing rows: fetch + persist (first caller wins), then re-resolve so the
			// ladder and everything downstream read the same DB rows.
			await ensureLtpAnchors(store, tradeDate, now, () => fetchLiveLtp(liveDeps));
			invalidateLadderCache();
			const reloaded = await getLadderForDate(store, tradeDate);
			if (
				reloaded.anchors.nifty !== null &&
				reloaded.anchors.banknifty !== null &&
				reloaded.anchors.sensex !== null
			) {
				return reloaded;
			}
		}
		// An index the LTP could not price degrades to the prev-close preview below
		// rather than vanishing — it cannot be bet anyway while its anchor is missing.
	}

	const ladder = await getLadderForDate(store, tradeDate);
	if (
		ladder.anchors.nifty !== null &&
		ladder.anchors.banknifty !== null &&
		ladder.anchors.sensex !== null
	) {
		return ladder;
	}
	const anchors = await fillAnchorsFromLive(ladder.anchors, liveDeps);
	return {
		tradeDate: ladder.tradeDate,
		anchors,
		options: generateLadderOptions(anchors),
		generatedAt: ladder.generatedAt
	};
}

/**
 * Validate a pick against today's ladder and return it with its configured odds —
 * or null when it is not on the ladder, which the bet service maps to
 * `INVALID_TARGET` (400).
 *
 * `store` defaults to the process store so the T7 call site stays short; tests
 * pass one explicitly.
 *
 * `live` opts into the live previous-close fallback (see
 * {@link getLadderForDateWithLiveFallback}): when the DB has no anchor for the
 * bet's underlying, the pick is validated against a ladder built from the last
 * closing price the feeds carry right now. `false`/omitted (the default) keeps
 * the historical DB-only behaviour — hermetic in tests. The bet service passes
 * a live value so a ladder the player could SEE is a ladder they can BET.
 */
export async function resolveLadderOption(
	tradeDate: string,
	underlying: LadderUnderlying,
	targetKind: LadderTargetKind,
	deltaPoints: number,
	store: GameStore = getStore(),
	live: LiveCloseDeps | false = false,
	now: Date = new Date()
): Promise<LadderOption | null> {
	const ladder =
		live === false
			? await getLadderForDate(store, tradeDate)
			: await getLadderForDateWithLiveFallback(store, tradeDate, live, now);
	return (
		ladder.options.find(
			(option) =>
				option.underlying === underlying &&
				option.targetKind === targetKind &&
				option.deltaPoints === deltaPoints
		) ?? null
	);
}
