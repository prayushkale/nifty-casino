/**
 * cas-store tests — the hot buffer + fan-out bus.
 *
 * Everything here runs on a fixed IST clock (Wednesday 2026-08-26): `ingest` and
 * `snapshot` both take `now`, so no test depends on the real time of day and the
 * IST-midnight routing is pinned explicitly (a tick belongs to the IST day its
 * `ts` falls on, which is the whole reason the store is keyed by trade date).
 */
import { describe, expect, it, vi } from 'vitest';
import { RING_BUFFER_CAP } from '$lib/config/app';
import { istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import type { CasTickPayload, Underlying } from './cas/types';
import {
	CAS_UNDERLYINGS,
	CasStore,
	getCasStore,
	heartbeatEvent,
	isAuctionWindowActive,
	isCasStale,
	resetCasStoreForTests,
	snapshotEventId,
	type StreamEvent
} from './cas-store';

const DAY = '2026-08-26'; // a Wednesday
const NEXT_DAY = '2026-08-27';

/** IST wall time on the fixed day → epoch ms. */
const at = (h: number, m: number, s = 0, ms = 0): number =>
	istHmsToUtcMs(istDateStrToMidnightUtcMs(DAY), { h, m, s }) + ms;

/** IST wall time on the day after the fixed day → epoch ms. */
const atNext = (h: number, m: number, s = 0, ms = 0): number =>
	istHmsToUtcMs(istDateStrToMidnightUtcMs(NEXT_DAY), { h, m, s }) + ms;

const inWindowNow = () => new Date(at(15, 20, 0));
const outsideWindowNow = () => new Date(at(11, 0, 0));

function payload(overrides: Partial<CasTickPayload> & { ts: number }): CasTickPayload {
	return {
		underlying: 'nifty',
		value: 25000,
		changePts: 12,
		changePct: 0.05,
		prevClose: 24988,
		upstreamTs: null,
		source: 'nse',
		...overrides
	};
}

function payloadAt(ts: number, value = 25000, underlying: Underlying = 'nifty'): CasTickPayload {
	return payload({ ts, value, underlying });
}

describe('empty store', () => {
	it('returns a well-formed, empty snapshot', () => {
		const snapshot = new CasStore().snapshot(undefined, inWindowNow());
		expect(snapshot.tradeDate).toBe(DAY);
		expect(snapshot.serverNow).toBe(at(15, 20, 0));
		expect(snapshot.bufferedFrom).toBeNull();
		expect(snapshot.ticks).toEqual({ nifty: [], banknifty: [], sensex: [] });
		expect(snapshot.latest).toEqual({});
		expect(snapshot.stale).toBe(false); // no data yet is "waiting", not "stale"
	});

	it('always emits all three underlyings as keys, in display order', () => {
		expect(CAS_UNDERLYINGS).toEqual(['nifty', 'banknifty', 'sensex']);
	});

	it('is never stale outside the auction window, whatever the data looks like', () => {
		expect(new CasStore().snapshot(undefined, outsideWindowNow()).stale).toBe(false);
	});

	it('ingesting nothing is a no-op with no events', () => {
		const store = new CasStore();
		const seen: unknown[] = [];
		store.subscribe((e) => seen.push(e));
		const result = store.ingest([], inWindowNow());
		expect(result.accepted).toEqual([]);
		expect(result.events).toEqual([]);
		expect(seen).toEqual([]);
	});
});

describe('ingest', () => {
	it('routes ticks to the IST day their ts falls on', () => {
		const store = new CasStore();
		// 22:30 IST on DAY (late evening) and 00:30 IST on NEXT_DAY: the same UTC
		// evening straddles IST midnight.
		const lateEvening = at(22, 30, 0);
		const pastMidnight = atNext(0, 30, 0);
		store.ingest([payloadAt(lateEvening, 1), payloadAt(pastMidnight, 2)], new Date(lateEvening));

		const day1 = store.snapshot(undefined, new Date(lateEvening));
		expect(day1.tradeDate).toBe(DAY);
		expect(day1.ticks.nifty.map((t) => t.value)).toEqual([1]);

		const day2 = store.snapshot(undefined, new Date(pastMidnight));
		expect(day2.tradeDate).toBe(NEXT_DAY);
		expect(day2.ticks.nifty.map((t) => t.value)).toEqual([2]);
	});

	it('fills each underlying independently in one poll', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest(
			[
				payloadAt(at(15, 14), 25000, 'nifty'),
				payloadAt(at(15, 14), 56240, 'banknifty'),
				payloadAt(at(15, 14), 82110, 'sensex')
			],
			now
		);
		const snapshot = store.snapshot(undefined, now);
		expect(snapshot.ticks.nifty).toHaveLength(1);
		expect(snapshot.ticks.banknifty[0]?.value).toBe(56240);
		expect(snapshot.ticks.sensex[0]?.value).toBe(82110);
	});

	it('drops a duplicate poll timestamp (first wins) and reports zero accepted', () => {
		const store = new CasStore();
		const ts = at(15, 14);
		const first = store.ingest([payloadAt(ts, 25000)], new Date(ts));
		expect(first.accepted).toHaveLength(1);

		const second = store.ingest([payloadAt(ts, 25999)], new Date(ts));
		expect(second.accepted).toHaveLength(0);
		expect(store.snapshot(undefined, new Date(ts)).ticks.nifty[0]?.value).toBe(25000);
	});

	it('drops a rewound timestamp from a later poll', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest([payloadAt(at(15, 14, 8))], now);
		store.ingest([payloadAt(at(15, 14, 4))], now);
		expect(store.snapshot(undefined, now).ticks.nifty.map((t) => t.ts)).toEqual([at(15, 14, 8)]);
	});

	it('caps the ring buffer at RING_BUFFER_CAP and advances bufferedFrom', () => {
		const store = new CasStore();
		const now = inWindowNow();
		const start = at(15, 0);
		const batch: CasTickPayload[] = [];
		for (let i = 0; i < RING_BUFFER_CAP + 80; i++) batch.push(payloadAt(start + i * 4000, i + 1));
		store.ingest(batch, now);

		const snapshot = store.snapshot(undefined, now);
		expect(snapshot.ticks.nifty).toHaveLength(RING_BUFFER_CAP);
		expect(snapshot.bufferedFrom).toBe(start + 80 * 4000);
		expect(snapshot.ticks.nifty[0]?.value).toBe(81); // the trimmed tail is the truth
	});

	it('tracks the freshest display payload and the previous-day close per underlying', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest(
			[
				payload({
					ts: at(15, 14),
					underlying: 'banknifty',
					value: 56240,
					changePts: 135.5,
					changePct: 0.24,
					prevClose: 56104.5,
					source: 'nse'
				})
			],
			now
		);
		const snapshot = store.snapshot(undefined, now);
		expect(snapshot.latest.banknifty).toEqual({
			value: 56240,
			changePts: 135.5,
			changePct: 0.24,
			prevClose: 56104.5,
			ts: at(15, 14),
			upstreamTs: null,
			source: 'nse'
		});
		expect(store.prevCloseFor(DAY, 'banknifty')).toBe(56104.5);
		// a payload without an anchor never clobbers a real one
		store.ingest([payload({ ts: at(15, 14, 4), underlying: 'banknifty', prevClose: null })], now);
		expect(store.prevCloseFor(DAY, 'banknifty')).toBe(56104.5);
	});
});

describe('snapshot with a since cursor', () => {
	it('returns only ticks newer than the cursor, but the full display state', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest(
			[
				payloadAt(at(15, 14), 1),
				payloadAt(at(15, 14, 4), 2),
				payloadAt(at(15, 14, 8), 3, 'sensex')
			],
			now
		);

		const delta = store.snapshot(at(15, 14, 4), now);
		expect(delta.ticks.nifty).toHaveLength(0);
		expect(delta.ticks.sensex.map((t) => t.value)).toEqual([3]);
		expect(delta.latest.nifty?.value).toBe(2);
		expect(delta.bufferedFrom).toBe(at(15, 14)); // unaffected by the cursor
	});

	it('returns everything when since is 0', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest([payloadAt(at(15, 14), 1), payloadAt(at(15, 14, 4), 2)], now);
		expect(store.snapshot(0, now).ticks.nifty).toHaveLength(2);
	});

	it('returns nothing when the cursor is at or after the newest tick', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest([payloadAt(at(15, 14), 1)], now);
		expect(store.snapshot(at(15, 14), now).ticks.nifty).toHaveLength(0);
		expect(store.snapshot(at(15, 14, 4), now).ticks.nifty).toHaveLength(0);
	});

	it('does not leak internal arrays', () => {
		const store = new CasStore();
		const now = inWindowNow();
		store.ingest([payloadAt(at(15, 14), 1)], now);
		const snapshot = store.snapshot(undefined, now);
		snapshot.ticks.nifty.push({ ts: 1, value: 999 });
		expect(store.snapshot(undefined, now).ticks.nifty).toHaveLength(1);
	});
});

describe('subscribe', () => {
	it('fans out one ticks event per poll, with the newest ts as the id', () => {
		const store = new CasStore();
		const now = inWindowNow();
		const events: StreamEvent[] = [];
		store.subscribe((e) => events.push(e));

		store.ingest([payloadAt(at(15, 14), 1), payloadAt(at(15, 14, 4), 2, 'sensex')], now);

		expect(events).toHaveLength(1);
		const event = events[0] as { id: string; type: string; payload: Record<string, unknown> };
		expect(event.id).toBe(String(at(15, 14, 4)));
		expect(event.type).toBe('ticks');
		expect(event.payload.tradeDate).toBe(DAY);
		expect(event.payload.bufferedFrom).toBe(at(15, 14));
		// only underlyings that actually moved are in the delta
		expect(Object.keys(event.payload.ticks as object)).toEqual(['nifty', 'sensex']);
		// every underlying the poll carried is in the display state
		expect(Object.keys(event.payload.latest as object)).toEqual(['nifty', 'sensex']);
	});

	it('emits two events when one poll straddles IST midnight', () => {
		const store = new CasStore();
		const events: { id: string; payload: { tradeDate: string } }[] = [];
		store.subscribe((e) => events.push(e as { id: string; payload: { tradeDate: string } }));
		store.ingest([payloadAt(at(23, 59), 1), payloadAt(atNext(0, 1), 2)], new Date(at(23, 59)));
		expect(events.map((e) => e.payload.tradeDate)).toEqual([DAY, NEXT_DAY]);
	});

	it('stops fanning out after unsubscribe', () => {
		const store = new CasStore();
		const now = inWindowNow();
		let count = 0;
		const unsubscribe = store.subscribe(() => {
			count += 1;
		});
		expect(store.listenerCount()).toBe(1);
		store.ingest([payloadAt(at(15, 14), 1)], now);
		expect(count).toBe(1);
		expect(unsubscribe()).toBeUndefined();
		expect(store.listenerCount()).toBe(0);
		store.ingest([payloadAt(at(15, 14, 4), 2)], now);
		expect(count).toBe(1);
	});

	it('fans out to every listener, in registration order', () => {
		const store = new CasStore();
		const now = inWindowNow();
		const order: string[] = [];
		store.subscribe(() => order.push('a'));
		store.subscribe(() => order.push('b'));
		store.ingest([payloadAt(at(15, 14), 1)], now);
		expect(order).toEqual(['a', 'b']);
	});

	it('drops a listener that throws instead of poisoning the poller', () => {
		const store = new CasStore();
		const now = inWindowNow();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		store.subscribe(() => {
			throw new Error('broken client');
		});
		let good = 0;
		store.subscribe(() => {
			good += 1;
		});

		store.ingest([payloadAt(at(15, 14), 1)], now);
		store.ingest([payloadAt(at(15, 14, 4), 2)], now);

		expect(good).toBe(2);
		expect(store.listenerCount()).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe('heartbeat + snapshot id', () => {
	it('builds a heartbeat event that carries no tick cursor', () => {
		const event = heartbeatEvent(1234);
		expect(event).toEqual({ id: 'hb-1234', type: 'heartbeat', payload: { ts: 1234 } });
		expect(event.id).not.toBe('1234');
	});

	it('derives the reconnect cursor from the newest tick, or 0 when empty', () => {
		const store = new CasStore();
		const now = inWindowNow();
		expect(snapshotEventId(store.snapshot(undefined, now))).toBe('0');
		store.ingest([payloadAt(at(15, 14), 1), payloadAt(at(15, 14, 4), 2, 'sensex')], now);
		expect(snapshotEventId(store.snapshot(undefined, now))).toBe(String(at(15, 14, 4)));
	});
});

describe('window gating + staleness', () => {
	it.each([
		['start boundary', at(15, 13, 30), true],
		['one ms before the start', at(15, 13, 29, 999), false],
		['inside the window', at(15, 20, 0), true],
		['end boundary (inclusive)', at(15, 42, 0), true],
		['one ms after the end', at(15, 42, 0, 1), false],
		[
			'Saturday',
			istHmsToUtcMs(istDateStrToMidnightUtcMs('2026-08-29'), { h: 15, m: 20, s: 0 }),
			false
		]
	])('isAuctionWindowActive: %s', (_name, ts, expected) => {
		expect(isAuctionWindowActive(new Date(ts))).toBe(expected);
	});

	it('is stale only inside the window and only after four missed polls', () => {
		const newest = at(15, 20, 0);
		expect(isCasStale(newest, new Date(newest + 4_000))).toBe(false);
		expect(isCasStale(newest, new Date(newest + 8_000))).toBe(false);
		expect(isCasStale(newest, new Date(newest + 8_001))).toBe(true);
		// outside the window an old tick is just... yesterday's data
		expect(isCasStale(at(15, 14), new Date(at(18, 0)))).toBe(false);
		expect(isCasStale(null, new Date(at(15, 20)))).toBe(false);
	});

	it('marks a snapshot stale when the feed is quiet mid-auction', () => {
		const store = new CasStore();
		const tickTs = at(15, 20, 0);
		store.ingest([payloadAt(tickTs)], new Date(tickTs));
		expect(store.snapshot(undefined, new Date(tickTs + 12_001)).stale).toBe(true);
		expect(store.snapshot(undefined, new Date(tickTs + 4_000)).stale).toBe(false);
		expect(store.snapshot(undefined, new Date(atNext(9, 0))).stale).toBe(false);
	});
});

describe('retention + singleton', () => {
	it('keeps only the newest two IST days in RAM', () => {
		const store = new CasStore();
		const day1 = at(15, 14); // 2026-08-26
		const day2 = atNext(15, 14); // 2026-08-27
		const day3 = istHmsToUtcMs(istDateStrToMidnightUtcMs('2026-08-28'), { h: 15, m: 14, s: 0 });
		store.ingest([payloadAt(day1, 1)], new Date(day1));
		store.ingest([payloadAt(day2, 2)], new Date(day2));
		store.ingest([payloadAt(day3, 3)], new Date(day3));

		// today + yesterday survive; the oldest day is DB-only from here on
		expect(store.snapshot(undefined, new Date(day3)).ticks.nifty).toHaveLength(1);
		expect(store.snapshot(undefined, new Date(day2)).ticks.nifty).toHaveLength(1);
		expect(store.snapshot(undefined, new Date(day1)).ticks.nifty).toHaveLength(0);
	});

	it('never drops today, even when many stray-dated days pile up', () => {
		const store = new CasStore();
		const today = inWindowNow();
		for (let i = 1; i <= 5; i++) {
			const stray = istHmsToUtcMs(istDateStrToMidnightUtcMs('2020-01-01'), { h: 15, m: 14, s: 0 });
			store.ingest([payloadAt(stray + i, i)], new Date(stray + i));
		}
		store.ingest([payloadAt(at(15, 14), 42)], today);
		expect(store.snapshot(undefined, today).ticks.nifty.map((t) => t.value)).toEqual([42]);
	});

	it('hands out one process-wide store, and can be reset for tests', () => {
		resetCasStoreForTests();
		const a = getCasStore();
		expect(getCasStore()).toBe(a);
		resetCasStoreForTests();
		expect(getCasStore()).not.toBe(a);
		resetCasStoreForTests();
	});
});
