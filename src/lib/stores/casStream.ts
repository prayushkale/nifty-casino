/**
 * The SSE-first live CAS feed for the browser (PLAN §2, §5 T12).
 *
 * Division of labour, mirroring how `$lib/stores/game.ts` splits its halves:
 *
 *  1. A PURE REDUCER (`applyStreamEvent` + the pure helpers around it) that turns
 *     one wire frame into the next state. No fetch, no clock, no `EventSource` —
 *     every instant it needs arrives as an argument, so `./casStream.test.ts` can
 *     pin the dedupe/monotonic/staleness/gap rules in plain node.
 *  2. A THIN WIRE (`startCasStream`) that owns the real `EventSource`, the
 *     snapshot fetches and the sessionStorage cursor, and feeds the reducer.
 *     Everything a test needs to reach is injected: the `EventSource`
 *     constructor, `fetch`, the storage and the clock — DI, never global stubbing.
 *
 * ── The wire contract this implements ─────────────────────────────────────────
 *
 * `/api/stream` sends three kinds of frame, and the shapes matter:
 *
 *   `event: hello`     id = newest tick ts   data = a snapshot (same shape as
 *                                            GET /api/cas/all: ticks per
 *                                            underlying, latest, serverNow,
 *                                            bufferedFrom, stale)
 *   `message`          id = newest tick ts   data = the new ticks for ONE IST day
 *   `event: heartbeat` (no id!)              data = { ts }
 *
 * Heartbeats carry no id on purpose — EventSource adopts ANY frame id as its
 * reconnect cursor, and a heartbeat id would invent a gap. The client side of
 * that contract is: a heartbeat advances nothing but `lastHeartbeatAt`.
 *
 * `EventSource` resends `Last-Event-ID` on every reconnect and the server answers
 * with a `hello` carrying exactly the ticks we missed, out of its RAM ring buffer.
 * That makes a dropped socket nearly free, which is why the polling fallback below
 * is a last resort rather than a default.
 *
 * ── The state machine ─────────────────────────────────────────────────────────
 *
 *   idle ──startCasStream()──► connecting ──snapshot + hello──► live ◄─┐
 *             │                   │                                    │ open
 *             │                   │ (no EventSource in this runtime)   │
 *             │                   ▼                                    │
 *             │               polling ◄──(2 errors / 30s)── reconnecting
 *             │                   │                                    ▲
 *             │                   └── stop() ──► down                  │ error
 *             └────────────────────────────────────────────────────────┘
 *
 * `reconnecting` is EventSource's own retry loop (we never close the socket for
 * it); we take over only when it has failed twice inside
 * {@link SSE_FALLBACK_WINDOW_MS}, and then the feed stays on the 8s REST poll for
 * the life of the page — the plan's Tier-3 shape, kept client-side as the escape
 * hatch from a proxy that eats `text/event-stream`.
 */
import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import {
	AUCTION_END_HMS,
	AUCTION_START_HMS,
	CAS_FALLBACK_POLL_MS,
	CAS_STALE_MS,
	SSE_FALLBACK_WINDOW_MS
} from '$lib/config/app';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { hmsToSeconds, isBetweenHMS, isWeekend, istDateStr, secOfDayIst } from '$lib/time/ist';
import { type CasPoint } from '$lib/game/chart';
import {
	casLatest,
	nowIst,
	startCasPolling,
	syncServerClock,
	type CasLiveValue
} from '$lib/stores/game';

// ---------------------------------------------------------------------------
// wire shapes — the JSON the two endpoints send, read tolerantly
// ---------------------------------------------------------------------------

/** The `latest` entry for one index: the display payload the cards render. */
export type StreamLatest = {
	value: number;
	changePts: number;
	changePct: number;
	prevClose: number | null;
	ts: number;
	source?: string;
};

/** Body of a `hello` frame — also the body of GET /api/cas/all (`truncated` aside). */
export type StreamSnapshot = {
	tradeDate: string;
	serverNow: number;
	bufferedFrom: number | null;
	ticks?: Partial<Record<LadderUnderlying, CasPoint[]>>;
	latest?: Partial<Record<LadderUnderlying, StreamLatest>>;
	stale?: boolean;
	truncated?: boolean;
};

/** Body of a `message` frame: only the underlyings that actually moved this poll. */
export type StreamDelta = {
	tradeDate: string;
	ticks?: Partial<Record<LadderUnderlying, CasPoint[]>>;
	latest?: Partial<Record<LadderUnderlying, StreamLatest>>;
	bufferedFrom: number | null;
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/**
 * Where the connection is. `idle` is the state before the page starts the feed —
 * and the state SSR renders, which is why the banner can hide itself without a
 * hydration mismatch.
 */
export type FeedConnection = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'polling' | 'down';

export type CasStreamState = {
	/** IST trade date the series belong to, once a frame has said so. */
	tradeDate: string | null;
	/** The day's line per index: ascending ts, deduped, capped. */
	series: Record<LadderUnderlying, CasPoint[]>;
	/** Freshest display payload per index — the cards and the preview strip read this. */
	latest: Record<LadderUnderlying, CasLiveValue | null>;
	/** Newest accepted ts per index; `null` until that index has a tick. */
	lastTs: Record<LadderUnderlying, number | null>;
	/** Newest accepted ts across all indices — the staleness input. */
	newestTickTs: number | null;
	/** The `id:` of the last numbered frame — the server's resume cursor, not ours. */
	lastEventId: string | null;
	/** When the last `heartbeat` landed. A silent stream is a dying stream. */
	lastHeartbeatAt: number | null;
	status: FeedConnection;
	/**
	 * True once the auction's nominal end has passed: the live deltas stop moving
	 * the line and the chart shows "awaiting official close". Snapshot frames still
	 * merge past this point — a reload at 15:45 must still draw the whole day —
	 * only the feed pushing the line forward is held.
	 */
	frozen: boolean;
	/** True once the SSE stream was abandoned for REST polling. */
	degraded: boolean;
	/** Errors counted inside {@link SSE_FALLBACK_WINDOW_MS}; two triggers the fallback. */
	errorCount: number;
};

const emptySeries = (): Record<LadderUnderlying, CasPoint[]> => ({
	nifty: [],
	banknifty: [],
	sensex: []
});

const emptyLatest = (): Record<LadderUnderlying, CasLiveValue | null> => ({
	nifty: null,
	banknifty: null,
	sensex: null
});

const emptyLastTs = (): Record<LadderUnderlying, number | null> => ({
	nifty: null,
	banknifty: null,
	sensex: null
});

export const initialCasStreamState: CasStreamState = {
	tradeDate: null,
	series: emptySeries(),
	latest: emptyLatest(),
	lastTs: emptyLastTs(),
	newestTickTs: null,
	lastEventId: null,
	lastHeartbeatAt: null,
	status: 'idle',
	frozen: false,
	degraded: false,
	errorCount: 0
};

/**
 * Client-side cap per index. The server caps a snapshot at 2000 and its ring
 * buffer holds 720; a full CAS session is ~430 ticks, so this is a memory guard
 * against a pathological day rather than a working limit.
 */
export const CLIENT_SERIES_CAP = 4000;

// ---------------------------------------------------------------------------
// the pure merge — every tick the client keeps passes through here
// ---------------------------------------------------------------------------

export type MergeResult = {
	/** The new series — the SAME reference when nothing was added, so a chart can skip a redraw. */
	points: CasPoint[];
	added: number;
};

/**
 * How `incoming` joins `existing`:
 *
 *   `'append'`  a live delta. Strictly monotonic: anything at or before the newest
 *               tick held is a duplicate poll or a replay, and is dropped. This is
 *               the rule that keeps a 4s feed from rewriting a line a player has
 *               been watching for 20 minutes.
 *   `'rebuild'` a snapshot (`hello`, or a `/api/cas/all` answer). Sorted-merged
 *               instead, because a backfill exists precisely to insert ticks OLDER
 *               than what we already hold — a reconnect whose ring buffer rotated
 *               past our cursor gets `[…15:14:00] + [15:15:00…]` back from RAM and
 *               the missing stretch from `cas_ticks`, and only a sort-merge puts
 *               them back in order. On a ts collision the INCOMING value wins: the
 *               server is the source of truth.
 */
export type MergeStrategy = 'append' | 'rebuild';

/**
 * Merge `incoming` into `existing`: ascending, deduped on `ts`, non-positive values
 * dropped (the indicative reads 0 outside the window), trimmed from the FRONT when
 * over the cap so the newest survive.
 *
 * `allowAppend: false` is the post-auction freeze: the frame is still parsed and its
 * display values still land, but the line does not move.
 */
export function mergePoints(
	existing: readonly CasPoint[],
	incoming: readonly CasPoint[],
	opts: { allowAppend?: boolean; cap?: number; strategy?: MergeStrategy } = {}
): MergeResult {
	const cap = opts.cap ?? CLIENT_SERIES_CAP;
	if (opts.allowAppend === false || incoming.length === 0) {
		return { points: existing as CasPoint[], added: 0 };
	}

	const usable = (tick: CasPoint): boolean =>
		Number.isFinite(tick.ts) && Number.isFinite(tick.value) && tick.value > 0;

	if (opts.strategy === 'rebuild') {
		const byTs = new Map<number, CasPoint>();
		let changed = 0;
		for (const tick of existing) {
			if (!usable(tick)) continue;
			byTs.set(tick.ts, tick);
		}
		for (const tick of incoming) {
			if (!usable(tick)) continue;
			if (!byTs.has(tick.ts)) changed += 1;
			byTs.set(tick.ts, tick); // incoming wins a collision
		}
		if (changed === 0) return { points: existing as CasPoint[], added: 0 };
		const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts);
		return {
			points: merged.length > cap ? merged.slice(merged.length - cap) : merged,
			added: changed
		};
	}

	const newest = existing.length > 0 ? existing[existing.length - 1].ts : -Infinity;
	const seen = new Set<number>();
	const fresh: CasPoint[] = [];
	for (const tick of incoming) {
		if (!usable(tick)) continue;
		if (tick.ts <= newest) continue; // monotonic: never rewrite the past
		if (seen.has(tick.ts)) continue;
		seen.add(tick.ts);
		fresh.push({ ts: tick.ts, value: tick.value });
	}
	if (fresh.length === 0) return { points: existing as CasPoint[], added: 0 };

	fresh.sort((a, b) => a.ts - b.ts);
	const merged = [...existing, ...fresh];
	return {
		points: merged.length > cap ? merged.slice(merged.length - cap) : merged,
		added: fresh.length
	};
}

/**
 * The newest ts across a per-index series map, or `null` when nothing has arrived.
 * `null` deliberately means "waiting", not "stale" — a board at 15:13:29 with no
 * ticks has nothing to be stale *from*.
 */
export function newestTsOf(series: Record<LadderUnderlying, CasPoint[]>): number | null {
	let newest: number | null = null;
	for (const underlying of LADDER_UNDERLYINGS) {
		const points = series[underlying];
		if (points.length === 0) continue;
		const ts = points[points.length - 1].ts;
		if (newest === null || ts > newest) newest = ts;
	}
	return newest;
}

/** The oldest ts we would need the server to fill from: the minimum across indices. */
export function oldestLastTs(lastTs: Record<LadderUnderlying, number | null>): number | null {
	let oldest: number | null = null;
	for (const underlying of LADDER_UNDERLYINGS) {
		const ts = lastTs[underlying];
		if (ts === null) continue;
		if (oldest === null || ts < oldest) oldest = ts;
	}
	return oldest;
}

/** Whether ANY index still holds a tick — "top up what I have" vs "I have nothing". */
export function hasAnyTicks(series: Record<LadderUnderlying, CasPoint[]>): boolean {
	return LADDER_UNDERLYINGS.some((underlying) => series[underlying].length > 0);
}

/** Refresh `lastTs`/`newestTickTs` from the series — the reducer's only bookkeeping. */
function recomputeLastTs(
	series: Record<LadderUnderlying, CasPoint[]>,
	previous: Record<LadderUnderlying, number | null>
): Record<LadderUnderlying, number | null> {
	const next: Record<LadderUnderlying, number | null> = { ...previous };
	for (const underlying of LADDER_UNDERLYINGS) {
		const points = series[underlying];
		const ts = points.length > 0 ? points[points.length - 1].ts : null;
		const prev = previous[underlying];
		next[underlying] = ts !== null && (prev === null || ts > prev) ? ts : prev;
	}
	return next;
}

/** Read one `latest` entry defensively — a NaN from the feed must not reach the DOM. */
function toLiveValue(entry: unknown): CasLiveValue | null {
	if (!isRecord(entry)) return null;
	const { value, changePts, changePct, prevClose, ts } = entry as StreamLatest;
	if (!Number.isFinite(value) || !Number.isFinite(ts)) return null;
	return {
		value,
		changePts: Number.isFinite(changePts) ? changePts : 0,
		changePct: Number.isFinite(changePct) ? changePct : 0,
		prevClose: prevClose !== null && Number.isFinite(prevClose) ? prevClose : null,
		ts
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse a frame body. `null` for anything that is not an object — malformed JSON is ignored, never thrown. */
function parseFrameData(data: unknown): Record<string, unknown> | null {
	if (typeof data !== 'string') return isRecord(data) ? data : null;
	try {
		const parsed: unknown = JSON.parse(data);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// the reducer
// ---------------------------------------------------------------------------

/** One frame, exactly as the wire delivered it. */
export type StreamFrame = {
	type: 'hello' | 'message' | 'heartbeat';
	/** The body: raw JSON text, or an already-parsed object (a snapshot we fetched). */
	data: unknown;
	/** The SSE `id:` of the frame, if it carried one. */
	id?: string | null;
};

export type ApplyOptions = {
	/** "Now", for the heartbeat stamp. Tests pass a fixed one. */
	now?: number;
	/**
	 * Whether live deltas may extend the series — `false` once the auction's
	 * nominal end has passed. Snapshots ignore this: a deliberate fetch is a
	 * rebuild, not the feed pushing the line forward.
	 */
	allowAppend?: boolean;
	/**
	 * Leave `status` exactly as it was. The snapshot fetch passes this: data has
	 * arrived, but that says nothing about the SOCKET, and a banner that reads
	 * "live" while EventSource is still retrying would be a lie.
	 */
	preserveStatus?: boolean;
};

/**
 * Apply one frame and return the next state. PURE: it never mutates `state` and
 * shares every part of it the frame did not touch, so a Svelte store can diff by
 * reference and a chart can skip a redraw.
 *
 * A feed glitch is data here, not an exception — a malformed body, a frame with
 * the wrong shape or a duplicate tick all yield the SAME state object back,
 * because "nothing changed" is the correct answer and the one thing a live chart
 * must never do is blank out 20 minutes of drawn history over it.
 */
export function applyStreamEvent(
	state: CasStreamState,
	frame: StreamFrame,
	opts: ApplyOptions = {}
): CasStreamState {
	if (frame.type === 'heartbeat') {
		// Alive, and nothing else. Deliberately not a status change: a heartbeat
		// says the server is up, not that THIS socket is (EventSource may be mid-
		// reconnect while a queued heartbeat is still being dispatched).
		return { ...state, lastHeartbeatAt: opts.now ?? 0 };
	}

	const body = parseFrameData(frame.data);
	if (body === null) return state;

	const ticks = isRecord(body.ticks) ? (body.ticks as StreamSnapshot['ticks']) : undefined;
	const latestBody = isRecord(body.latest) ? (body.latest as StreamSnapshot['latest']) : undefined;
	if (!ticks && !latestBody) return state;

	const allowAppend = opts.allowAppend ?? true;
	const isSnapshot = frame.type === 'hello';
	const tradeDate = typeof body.tradeDate === 'string' ? body.tradeDate : state.tradeDate;

	const series: Record<LadderUnderlying, CasPoint[]> = { ...state.series };
	let changed = false;

	if (ticks) {
		for (const underlying of LADDER_UNDERLYINGS) {
			const incoming = ticks[underlying];
			if (!Array.isArray(incoming) || incoming.length === 0) continue;
			const merge = mergePoints(series[underlying], incoming as CasPoint[], {
				// A snapshot must sort-merge (a backfill exists to insert ticks older than
				// what we hold) and may rewrite history (a page reload at 15:45, a server
				// restart with an emptied ring buffer); a live delta does neither.
				allowAppend: isSnapshot ? true : allowAppend,
				strategy: isSnapshot ? 'rebuild' : 'append'
			});
			if (merge.added === 0) continue;
			series[underlying] = merge.points;
			changed = true;
		}
	}

	let latest = state.latest;
	if (latestBody) {
		const nextLatest: Record<LadderUnderlying, CasLiveValue | null> = { ...state.latest };
		let latestChanged = false;
		for (const underlying of LADDER_UNDERLYINGS) {
			const value = toLiveValue(latestBody[underlying]);
			if (!value) continue;
			nextLatest[underlying] = value;
			latestChanged = true;
		}
		if (latestChanged) {
			latest = nextLatest;
			changed = true;
		}
	}

	if (!changed) return state;

	return {
		...state,
		tradeDate,
		series,
		latest,
		lastTs: recomputeLastTs(series, state.lastTs),
		lastEventId: frame.id ?? state.lastEventId,
		// A fallen-over feed that is somehow still delivering frames is not "down" and
		// not "polling" — it is delivering frames. The snapshot path opts out: data
		// arriving over REST says nothing about the socket.
		status: opts.preserveStatus
			? state.status
			: state.status === 'polling' || state.status === 'down'
				? state.status
				: 'live',
		// Data arrived: whatever the error counter was counting is no longer pending.
		errorCount: opts.preserveStatus ? state.errorCount : 0,
		newestTickTs: newestTsOf(series)
	};
}

// ---------------------------------------------------------------------------
// the freeze, and the staleness rule
// ---------------------------------------------------------------------------

/**
 * True once `now` is past the auction's nominal end (15:42:00 IST) — the point at
 * which the line stops moving and the chart switches to "awaiting official close".
 * Deliberately clock-only, so a morning visit (or an overnight tab) never freezes
 * anything: the freeze is about *after*, not "not during".
 */
export function isPostAuction(
	now: number,
	endHms: { h: number; m: number; s: number } = AUCTION_END_HMS
): boolean {
	return secOfDayIst(new Date(now)) > hmsToSeconds(endHms);
}

/**
 * The auction could be producing ticks right now: a trading day inside
 * 15:13:30–15:42:00 IST. The SAME gate the server's poller uses, re-derived from
 * the shared pure helpers — a client must not be able to call a feed stale while
 * the server is not even polling, and must not poll a board that cannot move.
 */
export function isAuctionLiveAt(now: number): boolean {
	const date = new Date(now);
	return !isWeekend(istDateStr(date)) && isBetweenHMS(date, AUCTION_START_HMS, AUCTION_END_HMS);
}

export type StalenessArgs = {
	newestTickTs: number | null;
	now: number;
	/** Whether the auction could be producing ticks (see {@link isAuctionLiveAt}). */
	auctionLive: boolean;
	staleMs?: number;
};

/**
 * The staleness banner's verdict. Three rules, in the order they matter:
 *
 *  1. Nothing yet is "waiting", not "stale" — there is no tick to be stale from.
 *  2. Outside the auction window nothing is stale, ever: an overnight tab sitting
 *     on yesterday's chart is not a feed outage.
 *  3. Otherwise a newest tick older than {@link CAS_STALE_MS} (three missed 4s
 *     polls) is a real outage, and the player is told.
 */
export function isFeedStale({
	newestTickTs,
	now,
	auctionLive,
	staleMs = CAS_STALE_MS
}: StalenessArgs): boolean {
	if (newestTickTs === null || !auctionLive) return false;
	return now - newestTickTs > staleMs;
}

// ---------------------------------------------------------------------------
// the resume cursor (sessionStorage) — PLAN §2 "refresh/reconnect contract"
// ---------------------------------------------------------------------------

export type StorageLike = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
};

/** The last tick ts this browser processed — the EventSource-side resume cursor. */
export const SS_LAST_TS_KEY = 'nc_last_ts';
/** The ts to ask `/api/cas/all?since=` for on the next mount — the REST-side cursor. */
export const SS_SINCE_TS_KEY = 'nc_since_ts';

export type SessionCursor = {
	lastTs: number | null;
	sinceTs: number | null;
	/** When the cursor was written; `null` when the storage did not record it. */
	savedAt: number | null;
};

export const emptyCursor: SessionCursor = { lastTs: null, sinceTs: null, savedAt: null };

const numeric = (raw: string | null): number | null => {
	if (raw === null) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : null;
};

/** Read the cursor, tolerating a missing storage (private mode) and any junk in it. */
export function readResumeCursor(storage: StorageLike | null): SessionCursor {
	if (!storage) return emptyCursor;
	try {
		const lastTs = numeric(storage.getItem(SS_LAST_TS_KEY));
		const sinceTs = numeric(storage.getItem(SS_SINCE_TS_KEY));
		if (lastTs === null && sinceTs === null) return emptyCursor;
		return { lastTs, sinceTs, savedAt: null };
	} catch {
		return emptyCursor;
	}
}

/**
 * Persist the cursor. Every failure is swallowed on purpose: Safari private mode
 * throws on `setItem`, and a cursor we could not save costs one extra snapshot on
 * the next load — never an error surfaced to a player mid-auction.
 */
export function writeResumeCursor(
	storage: StorageLike | null,
	cursor: { lastTs: number | null; sinceTs: number | null; savedAt: number }
): void {
	if (!storage) return;
	try {
		if (cursor.lastTs !== null) storage.setItem(SS_LAST_TS_KEY, String(cursor.lastTs));
		if (cursor.sinceTs !== null) storage.setItem(SS_SINCE_TS_KEY, String(cursor.sinceTs));
	} catch {
		/* storage unavailable — the feed still works, it just re-downloads */
	}
}

export type MountFetch = {
	/** The `?since=` to send; `null` means a full snapshot. */
	since: number | null;
	/** True when we hold nothing and need the server to rebuild the day. */
	fullSnapshot: boolean;
	/** Why — logged, and pinned in the tests. */
	why: string;
};

/**
 * What to ask `/api/cas/all` for when the feed starts: a page load, or a
 * client-side navigation back to `/` where this module's store survived.
 *
 * The rule that matters: a cursor is only worth sending if we still HOLD the ticks
 * before it. sessionStorage survives a reload but the series does not, so a cold
 * load must take a FULL snapshot — asking `?since=<yesterday's cursor>` with an
 * empty chart would paint a line that starts at the reconnect point and quietly
 * lose the 25 minutes before it. The full path is still the plan's backfill path:
 * the server answers a full snapshot out of `cas_ticks` whenever its own ring
 * buffer has rotated, which is what rebuilds a whole day after a server restart.
 *
 * When we DO hold ticks, the saved cursor tightens the bound: taking the *older* of
 * "oldest ts we might be missing" and "what we last recorded" can only mean
 * re-reading a few ticks that the merge dedupes, while taking the newer could open
 * a gap no fetch would ever close.
 */
export function mountFetchDecision(args: {
	hasTicks: boolean;
	/** Oldest ts we might be missing (min across indices); `null` when we hold none. */
	oldest: number | null;
	cursor: SessionCursor;
}): MountFetch {
	if (!args.hasTicks || args.oldest === null) {
		return { since: null, fullSnapshot: true, why: 'no local series — full snapshot' };
	}
	const since =
		args.cursor.sinceTs !== null ? Math.min(args.oldest, args.cursor.sinceTs) : args.oldest;
	return { since, fullSnapshot: false, why: 'topping up the series we already hold' };
}

export type GapDecision = {
	/** Whether a `/api/cas/all?since=` fetch is warranted. */
	needed: boolean;
	/** The `?since=` to send when {@link needed}. */
	since: number | null;
	why: string;
};

/**
 * Whether the `hello` we just received actually filled the gap the drop opened.
 *
 * The stream's `hello` answers `Last-Event-ID` out of the RAM ring buffer ONLY —
 * it never queries Postgres. So when our cursor is older than `bufferedFrom` (the
 * ring has rotated past where we were), or the buffer is empty outright (a server
 * restart mid-auction), the hello has silently skipped the stretch we missed and
 * only `/api/cas/all` can backfill it from `cas_ticks`. That fetch is the plan's
 * "refresh-recovery path"; this decision is what keeps it from firing on every
 * ordinary reconnect.
 */
export function reconnectGapDecision(args: {
	/** Newest ts we held before the drop (min across indices); `null` if we had none. */
	cursorBeforeDrop: number | null;
	/** The hello's `bufferedFrom`: oldest ts the server's RAM still holds. */
	bufferedFrom: number | null;
}): GapDecision {
	const { cursorBeforeDrop, bufferedFrom } = args;
	if (cursorBeforeDrop === null) {
		return {
			needed: false,
			since: null,
			why: 'nothing held before the drop — the hello is the whole day'
		};
	}
	if (bufferedFrom === null) {
		return { needed: true, since: cursorBeforeDrop, why: 'server RAM holds nothing for this day' };
	}
	if (cursorBeforeDrop < bufferedFrom) {
		return {
			needed: true,
			since: cursorBeforeDrop,
			why: 'the ring buffer rotated past our cursor — cas_ticks has the stretch'
		};
	}
	return { needed: false, since: null, why: 'the hello covered the gap out of RAM' };
}

// ---------------------------------------------------------------------------
// the derived views the page renders
// ---------------------------------------------------------------------------

/** The feed's state, live. SSR-safe: it just sits at {@link initialCasStreamState}. */
export const casStream: Writable<CasStreamState> = writable(initialCasStreamState);

export type FeedStatus = {
	status: FeedConnection;
	stale: boolean;
	degraded: boolean;
	/** Newest tick across the indices (epoch ms), or `null` while we wait for the first. */
	newestTickTs: number | null;
};

/**
 * The banner's single input: connection state + staleness, joined with the
 * drift-corrected clock from `$lib/stores/game` so "12s old" is measured on the
 * server's time and not on a phone that has drifted 40 seconds. (`startClock`
 * runs the clock; the game page starts it before anything reads this.)
 */
export const feedStatus: Readable<FeedStatus> = derived(
	[casStream, nowIst],
	([state, now]): FeedStatus => ({
		status: state.status,
		stale: isFeedStale({
			newestTickTs: state.newestTickTs,
			now,
			auctionLive: isAuctionLiveAt(now)
		}),
		degraded: state.degraded,
		newestTickTs: state.newestTickTs
	})
);

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

/** The slice of `EventSource` the wire touches — injectable so tests need no browser. */
export type EventSourceLike = {
	close(): void;
	readonly readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data?: unknown; lastEventId?: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	addEventListener(
		type: string,
		listener: (ev: { data?: unknown; lastEventId?: string }) => void
	): void;
};

export type EventSourceCtor = new (url: string) => EventSourceLike;

export type CasStreamOptions = {
	/** Defaults to `globalThis.EventSource`; pass `null` to force the polling path (tests, SSR). */
	EventSourceCtor?: EventSourceCtor | null;
	fetchImpl?: typeof fetch;
	/** Defaults to `globalThis.sessionStorage`; pass `null` to run without a cursor. */
	storage?: StorageLike | null;
	now?: () => number;
	/** Fallback poll cadence. */
	pollMs?: number;
	/** The window the fallback counts errors inside. */
	errorWindowMs?: number;
	/** Errors inside the window that trigger the fallback (2 = "twice within 30s"). */
	maxErrors?: number;
	/** The stream URL; overridable only for tests. */
	url?: string;
};

/** The one stream this module will run. A second `startCasStream()` reuses it, so a page and a component cannot open two sockets. */
let running: (() => void) | null = null;

/**
 * Start the feed and return the stop function.
 *
 * Ordering on start: the snapshot fetch goes out FIRST (it paints the chart before
 * the stream answers, and it is the only path that can read `cas_ticks`), then the
 * socket opens. Both feed the same reducer, so their ticks dedupe on arrival.
 */
export function startCasStream(options: CasStreamOptions = {}): () => void {
	if (running) return running;

	const now = options.now ?? (() => Date.now());
	const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const pollMs = options.pollMs ?? CAS_FALLBACK_POLL_MS;
	const errorWindowMs = options.errorWindowMs ?? SSE_FALLBACK_WINDOW_MS;
	const maxErrors = options.maxErrors ?? 2;
	const url = options.url ?? '/api/stream';

	const storage: StorageLike | null =
		options.storage !== undefined
			? options.storage
			: typeof globalThis.sessionStorage !== 'undefined'
				? globalThis.sessionStorage
				: null;

	let es: EventSourceLike | null = null;
	let stopPoll: (() => void) | null = null;
	let stopped = false;
	/** Whether this socket has ever delivered an open — a later `open` is a reconnect. */
	let sawOpen = false;
	/** True from `openStream()` until the connection's first hello lands. */
	let awaitingHello = false;
	/** Newest ts held when the drop began; consumed by the reconnect gap fill. */
	let cursorBeforeDrop: number | null = null;
	let lastErrorAt = 0;

	/** The `latest` object the cards last saw, so a heartbeat can not re-render the page. */
	let publishedLatest = get(casStream).latest;

	const publish = (next: CasStreamState): void => {
		casStream.set(next);
		// ONE store for the whole page: the index cards and the bets strip read
		// `casLatest` (T11's shape) and must not learn a second source of truth. Only
		// published when it actually changed — a 15s heartbeat would otherwise churn
		// every card on the page for no new information.
		if (next.latest !== publishedLatest) {
			publishedLatest = next.latest;
			casLatest.set(next.latest);
		}
	};

	/** The freeze, re-checked whenever anything arrives — a tab opened before 15:42 must freeze on time. */
	const allowAppend = (): boolean => !isPostAuction(now());

	/** Apply a frame, publish it, and persist the cursor the next mount will want. */
	const accept = (frame: StreamFrame, opts: { preserveStatus?: boolean } = {}): void => {
		if (stopped) return;
		const current = get(casStream);
		const applied = applyStreamEvent(current, frame, {
			now: now(),
			allowAppend: allowAppend(),
			preserveStatus: opts.preserveStatus
		});
		// The freeze is the wire's judgement call (it owns the clock), so it is
		// stamped here rather than computed inside the pure reducer.
		const next = applied.frozen || !isPostAuction(now()) ? applied : { ...applied, frozen: true };
		if (next !== current) publish(next);
		if (frame.type === 'heartbeat') return;
		writeResumeCursor(storage, {
			lastTs: next.newestTickTs,
			sinceTs: oldestLastTs(next.lastTs),
			savedAt: now()
		});
	};

	/** GET /api/cas/all — the mount snapshot, or a reconnect's DB-backed gap fill. */
	const fetchSnapshot = async (since: number | null, why: string): Promise<void> => {
		try {
			const res = await fetchImpl(`/api/cas/all${since !== null ? `?since=${since}` : ''}`, {
				headers: { accept: 'application/json' }
			});
			if (!res.ok) return;
			// `preserveStatus`: this frame arrived over REST, so it must not turn the
			// banner "live" while EventSource is still trying to connect.
			accept({ type: 'hello', data: await res.json(), id: null }, { preserveStatus: true });
		} catch {
			// The snapshot is an optimisation; the SSE hello is the real seed. A failed
			// one is worth a console line and nothing more.
			console.debug(`[casStream] snapshot fetch failed (${why})`);
		}
	};

	/** The reconnect path: only when the hello provably skipped the stretch we missed. */
	const fillGap = (bufferedFrom: number | null): void => {
		const decision = reconnectGapDecision({ cursorBeforeDrop, bufferedFrom });
		cursorBeforeDrop = null;
		if (!decision.needed) return;
		void fetchSnapshot(decision.since, decision.why);
	};

	function fallBackToPolling(errors: number): void {
		if (stopped) return;
		es?.close();
		es = null;
		stopPoll?.();
		// T11's 8s poll, kept alive for exactly this. Gated on the auction window so
		// a degraded tab left open overnight does not tick all night.
		stopPoll = startCasPolling(pollMs, () => !stopped && isAuctionLiveAt(now()));
		publish({ ...get(casStream), status: 'polling', degraded: true, errorCount: errors });
	}

	const handleError = (): void => {
		if (stopped || !es) return;
		cursorBeforeDrop = oldestLastTs(get(casStream).lastTs);
		const at = now();
		const withinWindow = at - lastErrorAt <= errorWindowMs;
		lastErrorAt = at;
		const count = withinWindow ? get(casStream).errorCount + 1 : 1;

		if (count >= maxErrors) {
			fallBackToPolling(count);
			return;
		}
		publish({ ...get(casStream), status: 'reconnecting', errorCount: count });
	};

	const openStream = (): void => {
		const Ctor =
			options.EventSourceCtor !== undefined
				? options.EventSourceCtor
				: ((globalThis as { EventSource?: EventSourceCtor }).EventSource ?? null);
		if (!Ctor) {
			// No EventSource in this runtime (SSR, a very old browser): the plan's
			// Tier-3 shape — snapshot plus poll — is the correct and only answer.
			fallBackToPolling(maxErrors);
			return;
		}

		es = new Ctor(url);
		awaitingHello = true;
		publish({ ...get(casStream), status: sawOpen ? 'reconnecting' : 'connecting', errorCount: 0 });

		es.onopen = () => {
			sawOpen = true;
			publish({ ...get(casStream), status: 'live', errorCount: 0 });
		};
		es.onmessage = (ev) => accept({ type: 'message', data: ev.data, id: ev.lastEventId ?? null });
		es.onerror = () => handleError();
		es.addEventListener('hello', (ev) => {
			accept({ type: 'hello', data: ev.data, id: ev.lastEventId ?? null });
			const body = parseFrameData(ev.data) as StreamSnapshot | null;
			// A hello carries the server's clock: refresh the drift correction so the
			// countdown and the staleness maths stay on the server's time.
			if (body && typeof body.serverNow === 'number') syncServerClock(body.serverNow);
			const firstHelloOfThisConnection = awaitingHello;
			awaitingHello = false;
			// The gap decision needs the hello's own `bufferedFrom`, which is why it
			// lives here and not in `onopen` — the hello is what knows the buffer.
			if (!firstHelloOfThisConnection) fillGap(body?.bufferedFrom ?? null);
		});
		es.addEventListener('heartbeat', (ev) =>
			accept({ type: 'heartbeat', data: ev.data, id: null })
		);
	};

	// 1. Snapshot first (see the doc block above).
	const start = get(casStream);
	const decision = mountFetchDecision({
		hasTicks: hasAnyTicks(start.series),
		oldest: oldestLastTs(start.lastTs),
		cursor: readResumeCursor(storage)
	});
	void fetchSnapshot(decision.since, decision.why);

	// 2. Then the socket.
	openStream();

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		es?.close();
		es = null;
		stopPoll?.();
		stopPoll = null;
		if (running === stop) running = null;
		publish({ ...get(casStream), status: 'down' });
	};

	running = stop;
	return stop;
}

/**
 * One `?since=` re-sync, for the moments a socket cannot cover: the tab becoming
 * visible again after the server dropped it, or a player coming back from another
 * tab. PLAN §2: "on visible, one snapshot fetch re-syncs".
 */
export async function resyncCasStream(fetchImpl?: typeof fetch): Promise<void> {
	const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
	const since = oldestLastTs(get(casStream).lastTs);
	try {
		const res = await doFetch(`/api/cas/all${since !== null ? `?since=${since}` : ''}`, {
			headers: { accept: 'application/json' }
		});
		if (!res.ok) return;
		casStream.set(
			applyStreamEvent(
				get(casStream),
				{ type: 'hello', data: await res.json(), id: null },
				{ now: Date.now(), preserveStatus: true }
			)
		);
	} catch {
		/* the stream heals it, or the next visible event will */
	}
}
