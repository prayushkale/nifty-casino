/**
 * The live-feed tables (PLAN §5 T12, test plan D).
 *
 * Two layers, tested separately the way the module is split:
 *
 *  1. THE REDUCER — `applyStreamEvent` and the pure helpers around it. These decide
 *     what a player sees on the chart, so the tables pin the boundaries: a duplicate
 *     tick, an out-of-order tick, a malformed frame, a freeze past the auction end.
 *  2. THE GAP/RESUME MATHS — the sessionStorage cursor and the two decisions that
 *     turn a dropped socket into either one cheap delta or one DB-backed backfill.
 *
 *  3. THE WIRE, driven end-to-end by a fake `EventSource` (injected, never stubbed
 *     globally) and a fake `fetch`, in plain node — no jsdom, no real socket.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { CAS_STALE_MS } from '$lib/config/app';
import { istDateStrToMidnightUtcMs } from '$lib/time/ist';
import type { CasPoint } from '$lib/game/chart';
import {
	applyStreamEvent,
	casStream,
	emptyCursor,
	CLIENT_SERIES_CAP,
	feedStatus,
	hasAnyTicks,
	initialCasStreamState,
	isAuctionLiveAt,
	isFeedStale,
	isPostAuction,
	mergePoints,
	mountFetchDecision,
	newestTsOf,
	oldestLastTs,
	readResumeCursor,
	reconnectGapDecision,
	SS_LAST_TS_KEY,
	SS_SINCE_TS_KEY,
	startCasStream,
	type CasStreamState,
	type EventSourceLike,
	type SessionCursor,
	type StorageLike,
	type StreamSnapshot,
	writeResumeCursor
} from './casStream';

/** A weekday to test against. */
const DAY = '2026-08-26';
const MIDNIGHT = istDateStrToMidnightUtcMs(DAY);

/** Epoch ms of IST {h,m,s} on `DAY`. */
const at = (h: number, m: number, s: number, ms = 0): number =>
	MIDNIGHT + ((h * 60 + m) * 60 + s) * 1000 + ms;

const tick = (ts: number, value = 25000): CasPoint => ({ ts, value });

/** Let every microtask the snapshot fetch queued run before asserting on it. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const snapshot = (over: Partial<StreamSnapshot> = {}): StreamSnapshot => ({
	tradeDate: DAY,
	serverNow: at(15, 20, 0),
	bufferedFrom: null,
	ticks: { nifty: [tick(at(15, 13, 30), 25000)] },
	latest: {
		nifty: { value: 25000, changePts: 0, changePct: 0, prevClose: 25000, ts: at(15, 13, 30) }
	},
	stale: false,
	...over
});

// ---------------------------------------------------------------------------
// mergePoints — the tick rules
// ---------------------------------------------------------------------------

describe('mergePoints — dedupe, monotonic, cap', () => {
	it('appends a new tick', () => {
		const merged = mergePoints([tick(at(15, 13, 30))], [tick(at(15, 13, 34), 25004)]);
		expect(merged.added).toBe(1);
		expect(merged.points).toEqual([tick(at(15, 13, 30)), tick(at(15, 13, 34), 25004)]);
	});

	it('drops a duplicate ts (the same poll delivered twice)', () => {
		const merged = mergePoints([tick(at(15, 13, 30))], [tick(at(15, 13, 30), 25099)]);
		expect(merged.added).toBe(0);
		expect(merged.points).toEqual([tick(at(15, 13, 30))]);
	});

	it('drops anything at or before the newest tick held — a chart never rewrites its past', () => {
		const merged = mergePoints(
			[tick(at(15, 13, 30)), tick(at(15, 13, 34))],
			[tick(at(15, 13, 30), 1), tick(at(15, 13, 32), 2), tick(at(15, 13, 38), 3)]
		);
		expect(merged.points.map((p) => p.ts)).toEqual([
			at(15, 13, 30),
			at(15, 13, 34),
			at(15, 13, 38)
		]);
	});

	it('sorts an out-of-order batch before appending', () => {
		const merged = mergePoints([], [tick(at(15, 13, 38), 3), tick(at(15, 13, 34), 2)]);
		expect(merged.points.map((p) => p.ts)).toEqual([at(15, 13, 34), at(15, 13, 38)]);
	});

	it('drops non-positive and non-finite values (the indicative is 0 outside the window)', () => {
		const merged = mergePoints(
			[],
			[tick(at(15, 13, 30), 0), tick(at(15, 13, 34), Number.NaN), tick(at(15, 13, 38), 25010)]
		);
		expect(merged.points).toEqual([tick(at(15, 13, 38), 25010)]);
	});

	it('trims from the FRONT when over the cap, so the newest survive', () => {
		const existing: CasPoint[] = Array.from({ length: 5 }, (_, i) => tick(i + 1, 100 + i));
		const merged = mergePoints(existing, [], { cap: 3 });
		expect(merged.added).toBe(0);
		const capped = mergePoints(
			[],
			Array.from({ length: 5 }, (_, i) => tick(i + 1, 100 + i)),
			{ cap: 3 }
		);
		expect(capped.points.map((p) => p.ts)).toEqual([3, 4, 5]);
		expect(CLIENT_SERIES_CAP).toBeGreaterThan(0);
	});

	it('returns the SAME array reference when nothing was added, so a chart can skip a redraw', () => {
		const existing = [tick(at(15, 13, 30))];
		expect(mergePoints(existing, [tick(at(15, 13, 30))]).points).toBe(existing);
		expect(mergePoints(existing, []).points).toBe(existing);
	});

	it('refuses to append when frozen, and still returns the original reference', () => {
		const existing = [tick(at(15, 13, 30))];
		const merged = mergePoints(existing, [tick(at(15, 13, 34), 25004)], { allowAppend: false });
		expect(merged.added).toBe(0);
		expect(merged.points).toBe(existing);
	});
});

// ---------------------------------------------------------------------------
// applyStreamEvent — the reducer
// ---------------------------------------------------------------------------

describe('applyStreamEvent — hello seeds, message appends, heartbeat only touches the clock', () => {
	it('a hello seeds the series and the display values', () => {
		const next = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		expect(next.series.nifty).toEqual([tick(at(15, 13, 30), 25000)]);
		expect(next.lastTs.nifty).toBe(at(15, 13, 30));
		expect(next.newestTickTs).toBe(at(15, 13, 30));
		expect(next.latest.nifty?.value).toBe(25000);
		expect(next.tradeDate).toBe(DAY);
		expect(next.status).toBe('live');
	});

	it('a hello carrying an object body (a snapshot we fetched) behaves identically', () => {
		const next = applyStreamEvent(initialCasStreamState, { type: 'hello', data: snapshot() });
		expect(next.series.nifty).toHaveLength(1);
	});

	it('a message delta appends to what the hello seeded, and carries the frame id through', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		const next = applyStreamEvent(seeded, {
			type: 'message',
			data: JSON.stringify({
				tradeDate: DAY,
				ticks: { nifty: [tick(at(15, 13, 34), 25004)] },
				latest: {
					nifty: {
						value: 25004,
						changePts: 4,
						changePct: 0.016,
						prevClose: 25000,
						ts: at(15, 13, 34)
					}
				}
			}),
			id: String(at(15, 13, 34))
		});
		expect(next.series.nifty).toHaveLength(2);
		expect(next.lastEventId).toBe(String(at(15, 13, 34)));
		expect(next.latest.nifty?.value).toBe(25004);
	});

	it('a delta touching only one index leaves the other index series untouched', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(
				snapshot({
					ticks: { nifty: [tick(at(15, 13, 30))], sensex: [tick(at(15, 13, 30), 82000)] }
				})
			)
		});
		const next = applyStreamEvent(seeded, {
			type: 'message',
			data: JSON.stringify({
				tradeDate: DAY,
				ticks: { nifty: [tick(at(15, 13, 34), 25004)] }
			})
		});
		expect(next.series.nifty).toHaveLength(2);
		expect(next.series.sensex).toHaveLength(1);
		expect(next.series.sensex).toBe(seeded.series.sensex);
	});

	it('a duplicate/out-of-order delta changes nothing and returns the SAME state object', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		const replay = applyStreamEvent(seeded, {
			type: 'message',
			data: JSON.stringify({ tradeDate: DAY, ticks: { nifty: [tick(at(15, 13, 30), 25000)] } })
		});
		expect(replay).toBe(seeded);
	});

	it('a malformed JSON body is ignored, never thrown', () => {
		expect(applyStreamEvent(initialCasStreamState, { type: 'hello', data: '{"ticks": {' })).toBe(
			initialCasStreamState
		);
	});

	it('a non-object body (number, array, null) is ignored', () => {
		for (const data of ['42', '[]', 'null', '"x"', null, undefined, 42, []]) {
			expect(applyStreamEvent(initialCasStreamState, { type: 'message', data })).toBe(
				initialCasStreamState
			);
		}
	});

	it('a frame with no usable fields is ignored', () => {
		expect(
			applyStreamEvent(initialCasStreamState, {
				type: 'message',
				data: JSON.stringify({ tradeDate: DAY })
			})
		).toBe(initialCasStreamState);
	});

	it('a tick the feed got wrong (NaN value) is dropped, and the display value with it', () => {
		const next = applyStreamEvent(initialCasStreamState, {
			type: 'message',
			data: JSON.stringify({
				tradeDate: DAY,
				ticks: { nifty: [{ ts: at(15, 13, 34), value: 'oops' }] },
				latest: { nifty: { value: 'oops', ts: at(15, 13, 34) } }
			})
		});
		expect(next).toBe(initialCasStreamState);
	});

	it('a heartbeat stamps lastHeartbeatAt and nothing else', () => {
		const next = applyStreamEvent(
			initialCasStreamState,
			{
				type: 'heartbeat',
				data: JSON.stringify({ ts: 1234 })
			},
			{ now: 9999 }
		);
		expect(next.lastHeartbeatAt).toBe(9999);
		expect(next.series).toBe(initialCasStreamState.series);
		expect(next.status).toBe('idle');
		expect(next.lastEventId).toBeNull();
	});

	it('a heartbeat with a garbage body still counts as alive (it carries nothing to parse)', () => {
		const next = applyStreamEvent(
			initialCasStreamState,
			{ type: 'heartbeat', data: 'not-json' },
			{
				now: 5
			}
		);
		expect(next.lastHeartbeatAt).toBe(5);
	});

	it('a polling/down feed that receives frames keeps its status — data does not resurrect a closed socket', () => {
		const polling: CasStreamState = { ...initialCasStreamState, status: 'polling', degraded: true };
		const next = applyStreamEvent(polling, { type: 'hello', data: JSON.stringify(snapshot()) });
		expect(next.status).toBe('polling');
		expect(next.degraded).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// the freeze
// ---------------------------------------------------------------------------

describe('the post-auction freeze', () => {
	it('isPostAuction flips exactly at 15:42:00 IST', () => {
		expect(isPostAuction(at(15, 41, 59, 999))).toBe(false);
		expect(isPostAuction(at(15, 42, 0, 0))).toBe(false); // the boundary instant is still live
		expect(isPostAuction(at(15, 42, 0, 1))).toBe(true);
		expect(isPostAuction(at(9, 0, 0))).toBe(false); // a morning visit freezes nothing
		expect(isPostAuction(at(23, 0, 0))).toBe(true);
	});

	it('a live delta past the auction end does not move the line', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		const next = applyStreamEvent(
			seeded,
			{
				type: 'message',
				data: JSON.stringify({ tradeDate: DAY, ticks: { nifty: [tick(at(15, 45, 0), 25100)] } })
			},
			{ allowAppend: false }
		);
		expect(next.series.nifty).toEqual([tick(at(15, 13, 30), 25000)]);
	});

	it('a snapshot still merges past the freeze — a reload at 15:45 must draw the whole day', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		const next = applyStreamEvent(
			seeded,
			{
				type: 'hello',
				data: JSON.stringify(snapshot({ ticks: { nifty: [tick(at(15, 45, 0), 25100)] } }))
			},
			{ allowAppend: false }
		);
		expect(next.series.nifty).toHaveLength(2);
	});

	it('a live delta still refreshes the display value while frozen — "awaiting close" shows the last indicative', () => {
		const seeded = applyStreamEvent(initialCasStreamState, {
			type: 'hello',
			data: JSON.stringify(snapshot())
		});
		const next = applyStreamEvent(
			seeded,
			{
				type: 'message',
				data: JSON.stringify({
					tradeDate: DAY,
					ticks: { nifty: [tick(at(15, 45, 0), 25100)] },
					latest: {
						nifty: {
							value: 25100,
							changePts: 100,
							changePct: 0.4,
							prevClose: 25000,
							ts: at(15, 45, 0)
						}
					}
				})
			},
			{ allowAppend: false }
		);
		expect(next.series.nifty).toHaveLength(1);
		expect(next.latest.nifty?.value).toBe(25100);
	});
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

describe('isFeedStale — three missed 4s polls, and only while the auction is live', () => {
	const newest = at(15, 20, 0);

	it.each([
		['a tick 1s old', 1000, true, false],
		['a tick exactly CAS_STALE_MS old — the boundary is not stale', CAS_STALE_MS, true, false],
		['a tick 1ms past CAS_STALE_MS', CAS_STALE_MS + 1, true, true],
		['a tick 60s old while the auction is live', 60_000, true, true],
		['a tick 60s old outside the auction window', 60_000, false, false]
	])('%s', (_name, ageMs, auctionLive, expected) => {
		expect(
			isFeedStale({
				newestTickTs: newest,
				now: newest + ageMs,
				auctionLive,
				staleMs: CAS_STALE_MS
			})
		).toBe(expected);
	});

	it('no ticks at all is "waiting", not stale — there is nothing to be stale from', () => {
		expect(isFeedStale({ newestTickTs: null, now: at(15, 30, 0), auctionLive: true })).toBe(false);
	});

	it('the config default is the 12s the plan asks for', () => {
		expect(
			isFeedStale({ newestTickTs: at(15, 20, 0), now: at(15, 20, 0) + 12_001, auctionLive: true })
		).toBe(true);
		expect(
			isFeedStale({ newestTickTs: at(15, 20, 0), now: at(15, 20, 0) + 12_000, auctionLive: true })
		).toBe(false);
	});
});

describe('isAuctionLiveAt — the same gate the server poller uses', () => {
	it('is true inside 15:13:30–15:42:00 IST on a weekday', () => {
		expect(isAuctionLiveAt(at(15, 13, 29, 999))).toBe(false);
		expect(isAuctionLiveAt(at(15, 13, 30))).toBe(true);
		expect(isAuctionLiveAt(at(15, 30, 0))).toBe(true);
		expect(isAuctionLiveAt(at(15, 42, 0))).toBe(true);
		expect(isAuctionLiveAt(at(15, 42, 0, 1))).toBe(false);
		expect(isAuctionLiveAt(at(11, 0, 0))).toBe(false);
	});

	it('is false on a weekend even inside the window', () => {
		const saturdayMidnight = istDateStrToMidnightUtcMs('2026-08-29');
		const saturdayWindow = saturdayMidnight + ((15 * 60 + 20) * 60 + 0) * 1000;
		expect(isAuctionLiveAt(saturdayWindow)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// cursor + gap maths
// ---------------------------------------------------------------------------

/** An in-memory sessionStorage stand-in with the same throwing shape Safari private mode has. */
function fakeStorage(
	initial: Record<string, string> = {},
	fail = false
): StorageLike & { store: Map<string, string> } {
	const store = new Map(Object.entries(initial));
	return {
		store,
		getItem: (key) => store.get(key) ?? null,
		setItem: (key, value) => {
			if (fail) throw new Error('QuotaExceededError');
			store.set(key, value);
		}
	};
}

describe('the sessionStorage cursor', () => {
	it('round-trips both keys', () => {
		const storage = fakeStorage();
		writeResumeCursor(storage, { lastTs: 1724700000000, sinceTs: 1724699988000, savedAt: 1 });
		expect(storage.store.get(SS_LAST_TS_KEY)).toBe('1724700000000');
		expect(storage.store.get(SS_SINCE_TS_KEY)).toBe('1724699988000');
		expect(readResumeCursor(storage)).toEqual({
			lastTs: 1724700000000,
			sinceTs: 1724699988000,
			savedAt: null
		});
	});

	it('reads a cursor written by a previous page load', () => {
		const storage = fakeStorage({
			[SS_LAST_TS_KEY]: '1724700000000',
			[SS_SINCE_TS_KEY]: '1724699988000'
		});
		const cursor = readResumeCursor(storage);
		expect(cursor.lastTs).toBe(1724700000000);
		expect(cursor.sinceTs).toBe(1724699988000);
	});

	it('tolerates junk, an empty storage, and a missing storage', () => {
		expect(readResumeCursor(fakeStorage({ [SS_LAST_TS_KEY]: 'yesterday-ish' }))).toEqual(
			emptyCursor
		);
		expect(readResumeCursor(fakeStorage())).toEqual(emptyCursor);
		expect(readResumeCursor(null)).toEqual(emptyCursor);
		const partial = readResumeCursor(fakeStorage({ [SS_SINCE_TS_KEY]: '1724700000000' }));
		expect(partial).toEqual({ lastTs: null, sinceTs: 1724700000000, savedAt: null });
	});

	it('swallows a throwing storage instead of breaking the feed', () => {
		const storage = fakeStorage({}, true);
		expect(() =>
			writeResumeCursor(storage, { lastTs: 1724700000000, sinceTs: 1724700000000, savedAt: 1 })
		).not.toThrow();
		expect(storage.store.size).toBe(0);
	});

	it('does not write a null value over a good one', () => {
		const storage = fakeStorage({ [SS_LAST_TS_KEY]: '1724700000000' });
		writeResumeCursor(storage, { lastTs: null, sinceTs: null, savedAt: 1 });
		expect(storage.store.get(SS_LAST_TS_KEY)).toBe('1724700000000');
	});
});

describe('oldestLastTs / hasAnyTicks', () => {
	it('takes the minimum across indices — one index lagging is the gap that matters', () => {
		expect(
			oldestLastTs({ nifty: at(15, 20, 8), banknifty: at(15, 20, 0), sensex: at(15, 20, 4) })
		).toBe(at(15, 20, 0));
	});

	it('ignores indices with nothing yet, and is null when everything is empty', () => {
		expect(oldestLastTs({ nifty: null, banknifty: at(15, 20, 0), sensex: null })).toBe(
			at(15, 20, 0)
		);
		expect(oldestLastTs({ nifty: null, banknifty: null, sensex: null })).toBeNull();
	});

	it('hasAnyTicks is the "I hold something" test the mount decision starts from', () => {
		expect(hasAnyTicks(initialCasStreamState.series)).toBe(false);
		expect(hasAnyTicks({ nifty: [], banknifty: [tick(1)], sensex: [] })).toBe(true);
	});

	it('newestTsOf takes the maximum across indices', () => {
		expect(newestTsOf({ nifty: [tick(1), tick(9)], banknifty: [], sensex: [tick(5)] })).toBe(9);
		expect(newestTsOf({ nifty: [], banknifty: [], sensex: [] })).toBeNull();
	});
});

describe('mountFetchDecision — what to ask /api/cas/all for when the feed starts', () => {
	const cursor: SessionCursor = { lastTs: at(15, 20, 8), sinceTs: at(15, 19, 0), savedAt: null };

	it('a cold load (nothing held) takes a FULL snapshot, even with a fresh cursor', () => {
		// sessionStorage survives a reload; the series does not. Sending `since` here
		// would paint a line starting at the reconnect point and lose the 25 minutes
		// before it.
		const decision = mountFetchDecision({ hasTicks: false, oldest: null, cursor });
		expect(decision).toEqual({
			since: null,
			fullSnapshot: true,
			why: 'no local series — full snapshot'
		});
	});

	it('a first-ever visit takes a full snapshot too', () => {
		const decision = mountFetchDecision({ hasTicks: false, oldest: null, cursor: emptyCursor });
		expect(decision.fullSnapshot).toBe(true);
		expect(decision.since).toBeNull();
	});

	it('an in-page return to `/` (the store survived) tops up from the older bound', () => {
		const decision = mountFetchDecision({
			hasTicks: true,
			oldest: at(15, 19, 30),
			cursor
		});
		// The saved cursor (15:19:00) is older than the oldest ts we might be missing
		// (15:19:30) — taking it can only mean re-reading a few ticks, never a gap.
		expect(decision.since).toBe(at(15, 19, 0));
		expect(decision.fullSnapshot).toBe(false);
	});

	it('when we hold ticks but have no cursor, the oldest held ts is the bound', () => {
		const decision = mountFetchDecision({
			hasTicks: true,
			oldest: at(15, 19, 30),
			cursor: emptyCursor
		});
		expect(decision.since).toBe(at(15, 19, 30));
	});

	it('when we hold MORE than the cursor recorded, the cursor still bounds it (dedupe is free)', () => {
		const decision = mountFetchDecision({
			hasTicks: true,
			oldest: at(15, 18, 0), // older than the saved cursor
			cursor
		});
		expect(decision.since).toBe(at(15, 18, 0));
	});
});

describe('reconnectGapDecision — did the hello actually fill the drop?', () => {
	it('an ordinary reconnect is free: the ring buffer still covers our cursor', () => {
		const decision = reconnectGapDecision({
			cursorBeforeDrop: at(15, 20, 0),
			bufferedFrom: at(15, 13, 30)
		});
		expect(decision.needed).toBe(false);
		expect(decision.since).toBeNull();
	});

	it('a cursor older than the buffer horizon needs the DB: the hello silently skipped the stretch', () => {
		const decision = reconnectGapDecision({
			cursorBeforeDrop: at(15, 14, 0),
			bufferedFrom: at(15, 15, 0) // the ring rotated past 15:14
		});
		expect(decision.needed).toBe(true);
		expect(decision.since).toBe(at(15, 14, 0));
	});

	it('an empty buffer (server restart mid-auction) always needs the DB', () => {
		const decision = reconnectGapDecision({ cursorBeforeDrop: at(15, 20, 0), bufferedFrom: null });
		expect(decision.needed).toBe(true);
		expect(decision.since).toBe(at(15, 20, 0));
	});

	it('nothing held before the drop means nothing to fill', () => {
		const decision = reconnectGapDecision({ cursorBeforeDrop: null, bufferedFrom: at(15, 20, 0) });
		expect(decision.needed).toBe(false);
		expect(decision.since).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// the wire — driven by a fake EventSource and a fake fetch, in plain node
// ---------------------------------------------------------------------------

/** The module under test, driven through its injected collaborators. */
type Listener = (ev: { data?: unknown; lastEventId?: string }) => void;

/** The smallest EventSource that can carry the three frame kinds the server sends. */
class FakeEventSource implements EventSourceLike {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data?: unknown; lastEventId?: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	closed = false;
	private readonly listeners = new Map<string, Listener[]>();

	constructor(public url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	close(): void {
		this.closed = true;
		this.readyState = 2;
	}

	emit(type: 'hello' | 'heartbeat', data: unknown, id?: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId: id });
	}

	emitMessage(data: unknown, id?: string): void {
		for (const listener of this.listeners.get('message') ?? []) listener({ data, lastEventId: id });
		this.onmessage?.({ data, lastEventId: id });
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.(null);
	}

	fail(): void {
		this.onerror?.(null);
	}
}

/** A `fetch` that answers /api/cas/all from a canned snapshot and records its URLs. */
function fakeFetch(snapshots: StreamSnapshot[] = []) {
	const calls: string[] = [];
	const fn = (async (input: unknown) => {
		calls.push(String(input));
		const body = snapshots[calls.length - 1] ?? snapshot();
		return { ok: true, json: async () => body } as unknown as Response;
	}) as typeof fetch;
	return { fetch: fn, calls };
}

const tickFrame = (ts: number, value: number): Record<string, unknown> => ({
	tradeDate: DAY,
	ticks: { nifty: [tick(ts, value)] },
	latest: { nifty: { value, changePts: value - 25000, changePct: 0, prevClose: 25000, ts } },
	bufferedFrom: at(15, 13, 30)
});

describe('startCasStream end-to-end (fake EventSource + fake fetch)', () => {
	beforeEach(() => {
		FakeEventSource.instances = [];
		casStream.set(initialCasStreamState);
	});

	it('fetches a snapshot, opens the socket, and lets the hello seed the series', async () => {
		const { fetch, calls } = fakeFetch([snapshot()]);
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null,
				now: () => at(15, 20, 0)
			});
			await flush();
			expect(calls).toEqual(['/api/cas/all']); // a cold load: full snapshot, no since

			expect(get(casStream).status).toBe('connecting');
			const es = FakeEventSource.instances[0];
			expect(es.url).toBe('/api/stream');
			es.open();
			expect(get(casStream).status).toBe('live');
			expect(get(feedStatus).status).toBe('live');

			es.emit('hello', snapshot(), String(at(15, 13, 30)));
			const state = get(casStream);
			expect(state.series.nifty).toEqual([tick(at(15, 13, 30), 25000)]);
			expect(state.lastEventId).toBe(String(at(15, 13, 30)));
		} finally {
			stop?.();
		}
	});

	it('applies message deltas and dedupes the duplicate poll', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null,
				now: () => at(15, 20, 0)
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot(), String(at(15, 13, 30)));
			es.emitMessage(tickFrame(at(15, 13, 34), 25004), String(at(15, 13, 34)));
			es.emitMessage(tickFrame(at(15, 13, 34), 25004), String(at(15, 13, 34))); // duplicate poll
			es.emit('heartbeat', { ts: 1 });

			const state = get(casStream);
			expect(state.series.nifty).toHaveLength(2);
			expect(state.newestTickTs).toBe(at(15, 13, 34));
			expect(state.lastHeartbeatAt).toBe(at(15, 20, 0));
		} finally {
			stop?.();
		}
	});

	it('writes the cursor to sessionStorage as frames land', async () => {
		const { fetch } = fakeFetch();
		const storage = fakeStorage();
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage,
				now: () => at(15, 20, 0)
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emitMessage(tickFrame(at(15, 13, 34), 25004), String(at(15, 13, 34)));
			expect(storage.store.get(SS_LAST_TS_KEY)).toBe(String(at(15, 13, 34)));
			expect(storage.store.get(SS_SINCE_TS_KEY)).toBe(String(at(15, 13, 34)));
		} finally {
			stop?.();
		}
	});

	it('a second call while one is running returns the SAME stopper instead of opening a second socket', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			const first = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null
			});
			const second = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null
			});
			expect(second).toBe(first);
			expect(FakeEventSource.instances).toHaveLength(1);
			stop = first;
		} finally {
			stop?.();
		}
	});

	it('stop() closes the socket and reports down', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null
			});
			const es = FakeEventSource.instances[0];
			stop();
			stop = null;
			expect(es.closed).toBe(true);
			expect(get(casStream).status).toBe('down');
			// Frames after stop are ignored, not applied.
			es.emitMessage(tickFrame(at(15, 13, 34), 25004));
			expect(get(casStream).series.nifty).toEqual([]);
		} finally {
			stop?.();
		}
	});

	it('publishes into the ONE store the index cards read (casLatest)', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({
				EventSourceCtor: FakeEventSource as unknown as new (url: string) => EventSourceLike,
				fetchImpl: fetch,
				storage: null
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot(), '1724700000000');
			expect(get(casStream).latest.nifty?.value).toBe(25000);
		} finally {
			stop?.();
		}
	});

	it('with no EventSource in the runtime it degrades to the snapshot + polling path', async () => {
		const { fetch, calls } = fakeFetch([snapshot()]);
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({ EventSourceCtor: null, fetchImpl: fetch, storage: null, pollMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(FakeEventSource.instances).toHaveLength(0);
			expect(get(casStream).status).toBe('polling');
			expect(get(casStream).degraded).toBe(true);
			expect(calls[0]).toBe('/api/cas/all');
		} finally {
			stop?.();
		}
	});
});

describe('reconnect + fallback behaviour', () => {
	beforeEach(() => {
		FakeEventSource.instances = [];
		casStream.set(initialCasStreamState);
	});

	const ctor = FakeEventSource as unknown as new (url: string) => EventSourceLike;

	it('one error reconnects (EventSource keeps the socket); two inside the window fall back to polling', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			let now = at(15, 20, 0);
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage: null,
				now: () => now
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emitMessage(tickFrame(at(15, 13, 34), 25004));

			es.fail();
			expect(get(casStream).status).toBe('reconnecting');
			expect(get(casStream).errorCount).toBe(1);
			expect(es.closed).toBe(false); // still trying

			now += 1000; // second error, inside the 30s window
			es.fail();
			expect(get(casStream).status).toBe('polling');
			expect(get(casStream).degraded).toBe(true);
			expect(es.closed).toBe(true); // the socket was abandoned
		} finally {
			stop?.();
		}
	});

	it('an error a full window later starts the count again instead of falling back', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			let now = at(15, 20, 0);
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage: null,
				now: () => now
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.fail();
			now += 31_000; // outside the window
			es.fail();
			expect(get(casStream).status).toBe('reconnecting');
			expect(get(casStream).degraded).toBe(false);
		} finally {
			stop?.();
		}
	});

	it('data arriving between errors resets the count — a stream that works is not hostile', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			let now = at(15, 20, 0);
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage: null,
				now: () => now
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.fail();
			now += 1000;
			es.open(); // EventSource reconnected on its own
			es.emitMessage(tickFrame(at(15, 13, 38), 25008)); // data → errorCount back to 0
			expect(get(casStream).errorCount).toBe(0);
			now += 1000;
			es.fail();
			expect(get(casStream).status).toBe('reconnecting'); // one error, not two
			expect(get(casStream).degraded).toBe(false);
		} finally {
			stop?.();
		}
	});

	it('a reconnect whose hello provably skipped the stretch triggers ONE ?since= backfill', async () => {
		// The DB answer for [15:14:00, 15:15:00) — the stretch the ring rotated past.
		const backfilled = snapshot({
			ticks: { nifty: [tick(at(15, 14, 4), 25012)] },
			bufferedFrom: at(15, 15, 0)
		});
		const { fetch, calls } = fakeFetch([snapshot(), backfilled]);
		let stop: (() => void) | null = null;
		try {
			// Clock injection: `now` must sit inside the DAY auction window or the wire
			// layer's post-auction freeze swallows the reconnect deltas (wall-clock bug
			// — these two passed only when vitest ran during 15:13:30–15:42 IST).
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage: null,
				now: () => at(15, 14, 30)
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot({ bufferedFrom: at(15, 13, 30) }), String(at(15, 13, 30)));
			// Our cursor ends up at 15:14:00; the tick before the drop is the one that matters.
			es.emitMessage(tickFrame(at(15, 14, 0), 25008), String(at(15, 14, 0)));
			expect(calls).toEqual(['/api/cas/all']);

			// The drop, then a reconnect whose hello can only reach back to 15:15 — the
			// ring rotated past our cursor, so [15:14:00, 15:15) is missing and the DB
			// is the only thing that has it.
			es.fail();
			es.open();
			es.emit(
				'hello',
				snapshot({ ticks: { nifty: [tick(at(15, 15, 0), 25020)] }, bufferedFrom: at(15, 15, 0) }),
				String(at(15, 15, 0))
			);
			await flush();
			expect(calls).toEqual(['/api/cas/all', `/api/cas/all?since=${at(15, 14, 0)}`]);
			// The merge kept the DB stretch AND the hello's newer ticks, in order.
			expect(get(casStream).series.nifty.map((p) => p.ts)).toEqual([
				at(15, 13, 30),
				at(15, 14, 0),
				at(15, 14, 4),
				at(15, 15, 0)
			]);
		} finally {
			stop?.();
		}
	});

	it('a reconnect the hello DID cover triggers no fetch at all', async () => {
		const { fetch, calls } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			stop = startCasStream({ EventSourceCtor: ctor, fetchImpl: fetch, storage: null });
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot({ bufferedFrom: at(15, 13, 30) }), String(at(15, 13, 30)));
			es.emitMessage(tickFrame(at(15, 20, 0), 25040), String(at(15, 20, 0)));
			es.fail();
			es.open();
			es.emit(
				'hello',
				snapshot({ bufferedFrom: at(15, 13, 30) }), // ring still holds from the start
				String(at(15, 20, 4))
			);
			await flush();
			expect(calls).toEqual(['/api/cas/all']); // only the mount snapshot
		} finally {
			stop?.();
		}
	});

	it('a frozen feed drops live deltas but the cursor still advances with the last accepted tick', async () => {
		const { fetch } = fakeFetch();
		const storage = fakeStorage();
		let stop: (() => void) | null = null;
		try {
			const pastAuction = at(15, 45, 0);
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage,
				now: () => pastAuction
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot(), String(at(15, 13, 30)));
			expect(get(casStream).frozen).toBe(true);
			es.emitMessage(tickFrame(at(15, 46, 0), 25100));
			expect(get(casStream).series.nifty).toHaveLength(1); // frozen: the line did not move
			expect(storage.store.get(SS_LAST_TS_KEY)).toBe(String(at(15, 13, 30)));
		} finally {
			stop?.();
		}
	});

	it('a delta for an index the feed never opened leaves the other series untouched', async () => {
		const { fetch } = fakeFetch();
		let stop: (() => void) | null = null;
		try {
			// Fixed in-window clock — see the reconnect test above for why.
			stop = startCasStream({
				EventSourceCtor: ctor,
				fetchImpl: fetch,
				storage: null,
				now: () => at(15, 14, 30)
			});
			const es = FakeEventSource.instances[0];
			es.open();
			es.emit('hello', snapshot(), '0');
			es.emitMessage({
				tradeDate: DAY,
				ticks: { banknifty: [{ ts: at(15, 13, 34), value: 56000 }] },
				latest: {},
				bufferedFrom: at(15, 13, 30)
			});
			const state = get(casStream);
			expect(state.series.banknifty).toEqual([tick(at(15, 13, 34), 56000)]);
			expect(state.series.nifty).toEqual([tick(at(15, 13, 30), 25000)]);
			// The cursor for the NEXT resume is the OLDER of the two — the gap that matters.
			expect(oldestLastTs(state.lastTs)).toBe(at(15, 13, 30));
		} finally {
			stop?.();
		}
	});
});
