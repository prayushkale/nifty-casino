/**
 * Snapshot assembly for `GET /api/cas/all` — the REST fallback and
 * refresh-recovery path (PLAN §2 "refresh/reconnect contract").
 *
 * Layering rule: RAM is the hot tail, `cas_ticks` is the durable record. A
 * client's `since` cursor is served from the ring buffer when it is still
 * inside the buffered horizon and from Postgres when it is not — so a player
 * who closed the tab at 15:05 and comes back at 15:38 gets the whole day's
 * line, and a server that restarted mid-auction (empty RAM, full DB) still
 * serves a complete chart.
 *
 * WHICH DAY: the board shows the most recent trading day's cash-session
 * movement while the market is closed — over a weekend, a trading holiday and
 * the pre-open morning — so a Saturday or Sunday visitor still sees Friday's
 * (or the last trading day's) 15:13–15:42 line. Only after the next trading
 * day opens at 09:15 IST does the board yield to the new day's (empty,
 * awaiting) line.
 *
 * Pure-ish by design: the merge/cap/staleness maths are exported for tests, and
 * the only I/O is the `TickRepo`/`CloseRepo` reads the caller hands in.
 */
import {
	hmsToSeconds,
	isWeekend,
	istDateStr,
	istDateStrToMidnightUtcMs,
	secOfDayIst
} from '$lib/time/ist';
import { MARKET_OPEN_HMS } from '$lib/config/app';
import type { CasTick } from './cas/cas-series';
import type { CasLatest, CasSnapshot, CasStore } from './cas-store';
import { CAS_UNDERLYINGS, isCasStale } from './cas-store';
import type { GameStore } from './db';
import type { CasTickRow, Underlying } from './db/types';

/**
 * Hard cap per underlying on one snapshot. Generous (the ring buffer is 720),
 * but finite: a client that asks for a whole week of ticks gets 2000 points and
 * a `truncated` flag rather than a 40 MB response.
 */
export const MAX_SNAPSHOT_TICKS = 2000;

export type CasAllResponse = {
	tradeDate: string;
	/** epoch ms — clients derive every countdown from this, never their own clock. */
	serverNow: number;
	/** Oldest ts in the hot RAM buffer (null when RAM holds nothing for this day). */
	bufferedFrom: number | null;
	ticks: Record<Underlying, CasTick[]>;
	latest: Partial<Record<Underlying, CasLatest>>;
	/** Feed gone quiet while the auction is live — the client staleness banner. */
	stale: boolean;
	/** A series was cut at {@link MAX_SNAPSHOT_TICKS} — the oldest rows are kept. */
	truncated: boolean;
};

/** A `CasTickRow` as a chart point (the only two fields a chart needs). */
function rowToTick(row: CasTickRow): CasTick {
	return { ts: row.ts, value: row.value };
}

/**
 * Merge the hot tail with a DB backfill: ascending by ts, deduped on ts (the
 * natural key), hot rows winning a collision, capped at `cap` from the front —
 * the oldest rows survive a cap, because a chart is drawn left-to-right and the
 * DB cursor can always fetch the rest.
 */
export function mergeCasSeries(
	hot: readonly CasTick[],
	backfill: readonly CasTickRow[],
	cap: number = MAX_SNAPSHOT_TICKS
): { ticks: CasTick[]; truncated: boolean } {
	const merged = [...hot, ...backfill.map(rowToTick)].sort((a, b) => a.ts - b.ts);
	const seen = new Set<number>();
	const ticks: CasTick[] = [];
	for (const tick of merged) {
		if (seen.has(tick.ts)) continue;
		seen.add(tick.ts);
		ticks.push(tick);
	}
	const truncated = ticks.length > cap;
	return { ticks: truncated ? ticks.slice(0, cap) : ticks, truncated };
}

export type CasSnapshotRequest = {
	hot: CasStore;
	store: GameStore;
	/** IST trade date to serve. Defaults to today; a past date reads the DB only. */
	date?: string | null;
	/** Client cursor (epoch ms). Ticks at or before it are not re-sent. */
	since?: number | null;
	now?: Date;
	cap?: number;
};

/**
 * Which trading day's line a visitor should see at `now`.
 *
 * A weekday after the market opens (09:15 IST) is that day's own board — empty
 * until its 15:13:30 CAS window — even if it currently has no ticks. Weekends,
 * trading holidays and the pre-open morning keep showing the most recent
 * trading day with actual tick rows, so Friday's movement survives Saturday,
 * Sunday and the pre-open stretch of Monday.
 *
 * `latestCasTradeDate` (a MAX over the `cas_ticks` partition, never newer than
 * today) is the ground truth for "the last day we have data".
 */
async function effectiveTradeDate(store: GameStore, now: Date): Promise<string> {
	const calendarToday = istDateStr(now);
	if (!isWeekend(calendarToday) && secOfDayIst(now) >= hmsToSeconds(MARKET_OPEN_HMS)) {
		return calendarToday;
	}
	const latest = await store.ticks.latestCasTradeDate(calendarToday);
	return latest ?? calendarToday;
}

/**
 * Build the `/api/cas/all` payload: the hot snapshot for today, plus a
 * `cas_ticks` backfill whenever the requested window reaches past what RAM
 * still holds (or RAM is empty — the mid-auction restart case, and every
 * weekend/holiday/pre-open replay of the last trading day).
 */
export async function buildCasSnapshot(req: CasSnapshotRequest): Promise<CasAllResponse> {
	const now = req.now ?? new Date();
	const cap = req.cap ?? MAX_SNAPSHOT_TICKS;
	const calendarToday = req.hot.snapshot(undefined, now).tradeDate;
	// An explicit `?date=` (history replay) always wins; otherwise show the most
	// recent trading day until the next one opens.
	const tradeDate = req.date ?? (await effectiveTradeDate(req.store, now));
	const isToday = tradeDate === calendarToday;
	const since = req.since ?? null;

	// The hot store only ever holds `now`'s IST date; a past-day replay (a
	// weekend showing Friday) has nothing in RAM and goes straight to the DB.
	const hotSnapshot: CasSnapshot | null = isToday
		? req.hot.snapshot(since ?? undefined, now)
		: null;

	const ticks: Record<Underlying, CasTick[]> = { nifty: [], banknifty: [], sensex: [] };
	let truncated = false;

	for (const underlying of CAS_UNDERLYINGS) {
		const hotTicks = hotSnapshot?.ticks[underlying] ?? [];
		const backfill = await backfillRows(req.store, {
			tradeDate,
			underlying,
			since,
			horizon: hotSnapshot?.bufferedFrom ?? null,
			now,
			cap
		});
		if (backfill.rows.length > 0 || backfill.truncated) {
			const merged = mergeCasSeries(hotTicks, backfill.rows, cap);
			ticks[underlying] = merged.ticks;
			truncated = truncated || merged.truncated || backfill.truncated;
		} else {
			ticks[underlying] = [...hotTicks];
		}
	}

	// Display state: the hot store's freshest payloads, plus a rebuild from the
	// archive for any index RAM knows nothing about (the mid-auction restart, and
	// every past-day replay).
	const latest = await completeLatest(req.store, tradeDate, ticks, hotSnapshot?.latest ?? {});

	return {
		tradeDate,
		serverNow: now.getTime(),
		bufferedFrom: hotSnapshot?.bufferedFrom ?? null,
		ticks,
		latest,
		stale: isToday ? isCasStale(newestTs(ticks), now) : false,
		truncated
	};
}

/**
 * Read `cas_ticks` for the part of the request the hot buffer cannot answer.
 * Empty when RAM covers the whole window — the common case, and the reason a
 * reconnecting client costs one Map slice instead of three queries.
 */
async function backfillRows(
	store: GameStore,
	opts: {
		tradeDate: string;
		underlying: Underlying;
		since: number | null;
		horizon: number | null;
		now: Date;
		cap: number;
	}
): Promise<{ rows: CasTickRow[]; truncated: boolean }> {
	const { tradeDate, underlying, since, horizon, now, cap } = opts;

	let fromTs: number;
	let toTs: number;
	if (since !== null && horizon !== null && since >= horizon) {
		return { rows: [], truncated: false }; // RAM covers [since, now]
	}
	if (since !== null) {
		// `getCasTicksRange` is inclusive at fromTs, and `since` is the ts of the last
		// tick the client already has — so step past it. One millisecond is exact:
		// ticks within a series are unique and 4s apart.
		fromTs = since + 1;
		// RAM (when it holds anything) owns everything from the horizon onward.
		toTs = horizon ?? now.getTime() + 1;
	} else {
		// A full snapshot (no cursor): always read the whole archived day from the
		// DB, then overlay the hot tail on it. This is what keeps a board that has
		// been open through the whole live session complete after the day is over —
		// the ring buffer trims its head during 30 minutes of 2s polling, so a
		// refresh that only served RAM would silently drop the first stretch of the
		// movement. The same path serves every past-day/weekend replay.
		fromTs = istDateStrToMidnightUtcMs(tradeDate);
		toTs = now.getTime() + 1;
	}

	// toTs must be strictly after fromTs for a non-empty window.
	if (toTs <= fromTs) return { rows: [], truncated: false };

	// cap + 1 so "there is more" is detectable instead of silently dropped.
	const rows = await store.ticks.getCasTicksRange(tradeDate, underlying, fromTs, toTs, cap + 1);
	if (rows.length > cap) return { rows: rows.slice(0, cap), truncated: true };
	return { rows, truncated: false };
}

/**
 * Fill in the display payload for any index whose series we have but whose live
 * display state we do not — the restarted-server case and every past-day replay.
 *
 * `changePts` is recomputed against the anchor the ladder itself would use
 * (`index_closes` of the previous trading day), which is the same arithmetic the
 * feed's `icChange` performs; `source` is `'archive'` so a client can tell a
 * rebuilt payload from a polled one.
 */
async function completeLatest(
	store: GameStore,
	tradeDate: string,
	ticks: Record<Underlying, CasTick[]>,
	existing: Partial<Record<Underlying, CasLatest>>
): Promise<Partial<Record<Underlying, CasLatest>>> {
	const latest: Partial<Record<Underlying, CasLatest>> = { ...existing };
	for (const underlying of CAS_UNDERLYINGS) {
		if (latest[underlying]) continue;
		const series = ticks[underlying];
		if (series.length === 0) continue;
		const last = series[series.length - 1];
		const anchor = await store.closes.getLatestCloseBefore(tradeDate, underlying);
		const prevClose = anchor?.close ?? null;
		const changePts = prevClose === null ? 0 : last.value - prevClose;
		latest[underlying] = {
			value: last.value,
			changePts,
			changePct: prevClose ? (changePts / prevClose) * 100 : 0,
			prevClose,
			ts: last.ts,
			// Archive rows persist only ts/value — no upstream timestamp survives.
			upstreamTs: null,
			source: 'archive'
		};
	}
	return latest;
}

function newestTs(ticks: Record<Underlying, CasTick[]>): number | null {
	let newest: number | null = null;
	for (const underlying of CAS_UNDERLYINGS) {
		const series = ticks[underlying];
		if (series.length === 0) continue;
		const ts = series[series.length - 1].ts;
		if (newest === null || ts > newest) newest = ts;
	}
	return newest;
}
