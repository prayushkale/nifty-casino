/**
 * cas-poller tests.
 *
 * No network and no real timers: the upstream fetchers are injected fakes and the
 * loop runs on Vitest fake timers, so the whole scrape → ingest → persist →
 * anchor cycle is exercised deterministically. The suite also proves the two
 * guards that keep this code out of trouble: `VITEST` disables the loop entirely
 * (these tests would otherwise poll NSE every 4 seconds), and a failing
 * upstream/DB write is a warning, never a crash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_MS } from '$lib/config/app';
import { istDateStr } from '$lib/time/ist';
import { buildBseSensexRow, buildNseIndexDataResponse } from './cas/test-fixtures';
import { istAt, SATURDAY, THURSDAY, WEDNESDAY } from './cas/test-clock';
import { CasStore } from './cas-store';
import type { CasTickPayload, Underlying } from './cas/types';
import { MemoryStore } from './db';
import type { DayAnchorBook } from './cas-poller';
import {
	isCasPollerRunning,
	logFreshness,
	needsAnchor,
	pollOnce,
	pollerDisabled,
	shouldPollNow,
	startCasPoller,
	stopCasPoller,
	ticksToDbRows
} from './cas-poller';

const DAY = WEDNESDAY;

/** A payload with a positive prevClose, the shape the feed produces in-window. */
function payload(overrides: Partial<CasTickPayload> = {}): CasTickPayload {
	return {
		underlying: 'nifty',
		value: 25000,
		changePts: 12,
		changePct: 0.05,
		prevClose: 24988,
		ts: istAt(DAY, 15, 14, 0),
		upstreamTs: null,
		source: 'nse',
		...overrides
	};
}

const allRows = (store: MemoryStore, underlying: 'nifty' | 'banknifty' | 'sensex') =>
	store.ticks.getCasTicksRange(DAY, underlying, 0, Number.MAX_SAFE_INTEGER, 1000);

describe('shouldPollNow — the only gate on upstream traffic', () => {
	it.each([
		['one ms before the window opens', istAt(WEDNESDAY, 15, 13, 29, 999), false],
		['the window opening second (inclusive)', istAt(WEDNESDAY, 15, 13, 30), true],
		['mid-window', istAt(WEDNESDAY, 15, 20, 0), true],
		['the last second of the window (inclusive)', istAt(WEDNESDAY, 15, 42, 0), true],
		['one ms after the window closes', istAt(WEDNESDAY, 15, 42, 0, 1), false],
		['Saturday mid-window (market closed)', istAt(SATURDAY, 15, 20, 0), false],
		['Saturday before the window', istAt(SATURDAY, 15, 0, 0), false],
		['Wednesday morning (pre-market)', istAt(WEDNESDAY, 9, 15, 0), false],
		['Wednesday night', istAt(WEDNESDAY, 23, 0, 0), false]
	])('%s → %p', (_name, ts, expected) => {
		expect(shouldPollNow(new Date(ts))).toBe(expected);
	});

	it('is the poller alias of the hot store window predicate', () => {
		// One definition, two names: the poller and the staleness banner must never
		// be able to disagree about whether the auction is live.
		expect(shouldPollNow(new Date(istAt(THURSDAY, 15, 13, 30)))).toBe(true);
	});
});

describe('ticksToDbRows', () => {
	it('maps a payload onto the cas_ticks column shape', () => {
		const rows = ticksToDbRows([payload({ ts: 1724700000000 })], '2026-08-26');
		expect(rows).toEqual([
			{
				tradeDate: '2026-08-26',
				underlying: 'nifty',
				ts: 1724700000000,
				value: 25000,
				changePts: 12,
				changePct: 0.05
			}
		]);
	});

	it('stamps each tick with its own IST date when no trade date is given', () => {
		const rows = ticksToDbRows([
			payload({ ts: istAt(DAY, 15, 14), underlying: 'nifty' }),
			payload({ ts: istAt(THURSDAY, 0, 1), underlying: 'sensex' })
		]);
		expect(rows.map((r) => r.tradeDate)).toEqual([DAY, THURSDAY]);
	});

	it('maps an empty poll to no rows', () => {
		expect(ticksToDbRows([])).toEqual([]);
	});
});

describe('needsAnchor — the previous-day close is written once, and never over an official row', () => {
	const state = (anchored: Underlying[] = [], official: Underlying[] = []) => ({
		anchored: new Set(anchored),
		official: new Set(official)
	});

	it('anchors the first positive prevClose of the day', () => {
		expect(needsAnchor(state(), payload({ prevClose: 24988 }))).toBe(true);
	});

	it('anchors each underlying independently', () => {
		expect(needsAnchor(state(['nifty']), payload({ underlying: 'sensex', prevClose: 78581 }))).toBe(
			true
		);
	});

	it('never anchors twice for the same underlying', () => {
		expect(needsAnchor(state(['nifty']), payload())).toBe(false);
	});

	it('never anchors when the row is already the official close', () => {
		expect(needsAnchor(state([], ['nifty']), payload())).toBe(false);
	});

	it('ignores a missing or non-positive anchor (0 means "the feed has no prevClose")', () => {
		expect(needsAnchor(state(), payload({ prevClose: null }))).toBe(false);
		expect(needsAnchor(state(), payload({ prevClose: 0 }))).toBe(false);
		expect(needsAnchor(state(), payload({ prevClose: -1 }))).toBe(false);
	});
});

describe('disabling the poller', () => {
	it('is disabled when VITEST is set — no test run may scrape NSE/BSE', () => {
		expect(pollerDisabled({ VITEST: 'true' })).toBe(true);
		expect(pollerDisabled({ VITEST: '1' })).toBe(true);
	});

	it('is disabled by CAS_POLLER_DISABLED=1 (and tolerates true/whitespace)', () => {
		expect(pollerDisabled({})).toBe(false);
		expect(pollerDisabled({ CAS_POLLER_DISABLED: '1' })).toBe(true);
		expect(pollerDisabled({ CAS_POLLER_DISABLED: 'true' })).toBe(true);
		expect(pollerDisabled({ CAS_POLLER_DISABLED: ' 0 ' })).toBe(false);
	});

	it('startCasPoller refuses to run under VITEST and leaves no timer behind', () => {
		expect(startCasPoller()).toBe(false);
		expect(isCasPollerRunning()).toBe(false);
		expect(startCasPoller({ env: { CAS_POLLER_DISABLED: '1' } })).toBe(false);
		expect(isCasPollerRunning()).toBe(false);
	});
});

describe('the loop (fake timers, fake upstreams, memory store)', () => {
	const log = { info: vi.fn(), warn: vi.fn() };
	let store: MemoryStore;
	let hot: CasStore;
	let nse: ReturnType<typeof vi.fn>;
	let bse: ReturnType<typeof vi.fn>;
	let anchors: Map<string, DayAnchorBook>;

	const start = (): void => {
		expect(
			startCasPoller({ store, hot, fetchNse: nse, fetchBse: bse, anchors, log, env: {} })
		).toBe(true);
	};

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		store = new MemoryStore();
		hot = new CasStore();
		nse = vi.fn(async () => buildNseIndexDataResponse());
		bse = vi.fn(async () => [buildBseSensexRow()]);
		anchors = new Map();
		log.info.mockClear();
		log.warn.mockClear();
	});

	afterEach(() => {
		stopCasPoller();
		vi.useRealTimers();
		expect(isCasPollerRunning()).toBe(false);
	});

	it('polls both exchanges, fills the hot buffer, archives the ticks and anchors the day', async () => {
		vi.setSystemTime(new Date(istAt(DAY, 15, 14, 0)));
		start();

		await vi.advanceTimersByTimeAsync(1);

		expect(nse).toHaveBeenCalledTimes(1);
		expect(bse).toHaveBeenCalledTimes(1);

		const snapshot = hot.snapshot(undefined, new Date(istAt(DAY, 15, 14, 1)));
		expect(snapshot.ticks.nifty.map((t) => t.value)).toEqual([24624.65]);
		expect(snapshot.ticks.banknifty.map((t) => t.value)).toEqual([56240.3]);
		expect(snapshot.ticks.sensex.map((t) => t.value)).toEqual([78845.12]);
		expect(snapshot.latest.nifty?.prevClose).toBe(24586.15);

		// the durable record — one row per underlying, with the move columns
		await expect(allRows(store, 'nifty')).resolves.toHaveLength(1);
		const rows = await allRows(store, 'banknifty');
		expect(rows[0]).toMatchObject({
			tradeDate: DAY,
			underlying: 'banknifty',
			value: 56240.3,
			changePts: 135.5,
			changePct: 0.24
		});

		// the previous-day anchor, written once per underlying as live_approx
		const closes = await store.closes.getIndexCloses(DAY);
		expect(closes).toHaveLength(3);
		expect(closes).toEqual(
			expect.arrayContaining([
				{ tradeDate: DAY, underlying: 'nifty', close: 24586.15, source: 'live_approx' },
				{ tradeDate: DAY, underlying: 'banknifty', close: 56104.8, source: 'live_approx' },
				{ tradeDate: DAY, underlying: 'sensex', close: 78581, source: 'live_approx' }
			])
		);
	});

	it('never rewrites the anchor on later polls of the same day', async () => {
		vi.setSystemTime(new Date(istAt(DAY, 15, 14, 0)));
		start();
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await vi.advanceTimersByTimeAsync(POLL_MS);

		// three polls, three ticks, one anchor per underlying
		expect(nse).toHaveBeenCalledTimes(3);
		expect(await allRows(store, 'nifty')).toHaveLength(3);
		const closes = await store.closes.getIndexCloses(DAY);
		expect(closes.filter((c) => c.underlying === 'nifty')).toHaveLength(1);
	});

	it('stops polling the instant the window closes, then resumes cadence inside it', async () => {
		vi.setSystemTime(new Date(istAt(DAY, 15, 41, 58)));
		start();
		await vi.advanceTimersByTimeAsync(1);
		const inWindowCalls = nse.mock.calls.length;

		// past 15:42:00 the cycle re-checks every 30s and fetches nothing
		vi.setSystemTime(new Date(istAt(DAY, 15, 45, 0)));
		await vi.advanceTimersByTimeAsync(31_000);
		expect(nse).toHaveBeenCalledTimes(inWindowCalls);

		// ... and the next trading day's window polls again
		vi.setSystemTime(new Date(istAt(THURSDAY, 15, 13, 30)));
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(nse.mock.calls.length).toBeGreaterThan(inWindowCalls);
	});

	it('never polls on a weekend', async () => {
		vi.setSystemTime(new Date(istAt(SATURDAY, 15, 14, 0)));
		start();
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(nse).not.toHaveBeenCalled();
		expect(bse).not.toHaveBeenCalled();
		expect(await allRows(store, 'nifty')).toHaveLength(0);
	});

	it('is idempotent across repeated starts (dev HMR must not spawn a second scraper)', () => {
		vi.setSystemTime(new Date(istAt(DAY, 15, 14, 0)));
		start();
		expect(startCasPoller({ store, hot, fetchNse: nse, fetchBse: bse, log, env: {} })).toBe(false);
		expect(isCasPollerRunning()).toBe(true);
	});

	it('a second start after a stop is a fresh loop', async () => {
		vi.setSystemTime(new Date(istAt(DAY, 15, 14, 0)));
		start();
		stopCasPoller();
		expect(isCasPollerRunning()).toBe(false);
		start();
		expect(isCasPollerRunning()).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(nse).toHaveBeenCalledTimes(1);
	});
});

describe('pollOnce — failure tolerance', () => {
	const baseDeps = () => ({
		store: new MemoryStore(),
		hot: new CasStore(),
		log: { info: vi.fn(), warn: vi.fn() }
	});

	it('keeps the survivors when one exchange fails', async () => {
		const deps = baseDeps();
		const result = await pollOnce(
			{
				...deps,
				fetchNse: async () => {
					throw new Error('NSE blocked (Akamai)');
				},
				fetchBse: async () => [buildBseSensexRow()],
				env: {}
			},
			new Date(istAt(DAY, 15, 14, 0))
		);

		expect(result.polled).toBe(1);
		expect(result.accepted).toBe(1);
		expect(result.persisted).toBe(1);
		expect(result.anchored).toEqual(['sensex']);
		expect(deps.hot.snapshot(undefined, new Date(istAt(DAY, 15, 14, 1))).ticks.sensex).toHaveLength(
			1
		);
		// The NSE-failure warn, plus (with these fixtures) the freshness warn — the
		// fixture's dttm is far from the poll instant, which IS the stale-upstream case.
		const warns = (deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(warns.some((w) => w.includes('NSE E1 failed'))).toBe(true);
	});

	it('does nothing harmful when both feeds come back empty (outside the window upstream)', async () => {
		const deps = baseDeps();
		const result = await pollOnce(
			{ ...deps, fetchNse: async () => ({ data: [] }), fetchBse: async () => [], env: {} },
			new Date(istAt(DAY, 15, 14, 0))
		);
		expect(result).toEqual({ polled: 0, accepted: 0, persisted: 0, anchored: [] });
		expect(deps.log.warn).not.toHaveBeenCalled();
	});

	it('warns and continues when the archive write fails', async () => {
		const hot = new CasStore();
		const store = new MemoryStore();
		store.ticks.insertCasTicks = async () => {
			throw new Error('connection refused');
		};
		const log = { info: vi.fn(), warn: vi.fn() };

		const result = await pollOnce(
			{
				store,
				hot,
				log,
				fetchNse: async () => buildNseIndexDataResponse(),
				fetchBse: async () => [buildBseSensexRow()],
				env: {}
			},
			new Date(istAt(DAY, 15, 14, 0))
		);

		// the tick is in RAM and SSE is live even though the archive write failed
		expect(result.persisted).toBe(0);
		expect(result.accepted).toBe(3);
		expect(hot.snapshot(undefined, new Date(istAt(DAY, 15, 14, 1))).ticks.nifty).toHaveLength(1);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cas_ticks insert failed'));
	});

	it('skips the anchor write when the feed carries no previous-day close', async () => {
		const deps = baseDeps();
		const result = await pollOnce(
			{
				...deps,
				fetchNse: async () =>
					buildNseIndexDataResponse([
						// indicative present, previousClose absent → no anchor to write
						{ indexName: 'NIFTY 50', previousClose: 0, indicativeClose: 24600 } as never
					]),
				fetchBse: async () => [],
				env: {}
			},
			new Date(istAt(DAY, 15, 14, 0))
		);
		expect(result.anchored).toEqual([]);
		expect(await deps.store.closes.getIndexCloses(DAY)).toHaveLength(0);
	});

	it('anchors off the real IST date of the poll, not the wall clock of the test', async () => {
		const deps = baseDeps();
		const now = new Date(istAt(THURSDAY, 15, 14, 0));
		await pollOnce(
			{
				...deps,
				fetchNse: async () => buildNseIndexDataResponse(),
				fetchBse: async () => [buildBseSensexRow()],
				env: {}
			},
			now
		);
		expect(istDateStr(now)).toBe(THURSDAY);
		expect(await deps.store.closes.getIndexCloses(THURSDAY)).toHaveLength(3);
		expect(await deps.store.closes.getIndexCloses(DAY)).toHaveLength(0);
	});
});

describe('logFreshness — exchange-side age reporting', () => {
	it('logs info when the oldest upstream payload is fresh, warn when stale', () => {
		const now = istAt(DAY, 15, 22, 0);
		const log = { info: vi.fn(), warn: vi.fn() };
		logFreshness(
			log,
			[
				payload({ ts: now, upstreamTs: now - 1_000 }),
				payload({ ts: now, underlying: 'sensex', upstreamTs: now - 3_000 })
			],
			now
		);
		expect(log.info).toHaveBeenCalledTimes(1);
		expect(String(log.info.mock.calls[0]?.[0])).toContain('sensex upstream age 3.0s');

		logFreshness(log, [payload({ ts: now, upstreamTs: now - 25_000 })], now);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(String(log.warn.mock.calls[0]?.[0])).toContain('arrived stale');
	});

	it('stays silent when the feed carried no timestamps', () => {
		const log = { info: vi.fn(), warn: vi.fn() };
		logFreshness(log, [payload({ ts: 0, upstreamTs: null })], 1000);
		expect(log.info).not.toHaveBeenCalled();
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe('pollOnce — the 15:15:01 LTP anchor', () => {
	const baseDeps = () => ({
		store: new MemoryStore(),
		hot: new CasStore(),
		log: { info: vi.fn(), warn: vi.fn() }
	});

	it('writes source=ltp_anchor rows on the first poll at/after 15:15:01', async () => {
		const deps = baseDeps();
		const result = await pollOnce(
			{
				...deps,
				fetchNse: async () => buildNseIndexDataResponse(),
				fetchBse: async () => [buildBseSensexRow()],
				env: {}
			},
			new Date(istAt(DAY, 15, 15, 1))
		);
		const rows = await deps.store.closes.getIndexCloses(DAY);
		const byUnderlying = new Map(rows.map((r) => [r.underlying, r]));
		expect(byUnderlying.get('nifty')).toMatchObject({ close: 24630.2, source: 'ltp_anchor' });
		expect(byUnderlying.get('banknifty')).toMatchObject({ close: 56210.4, source: 'ltp_anchor' });
		expect(byUnderlying.get('sensex')).toMatchObject({ close: 78831.32, source: 'ltp_anchor' });
		// The CAS ticks still flow as usual on the same poll.
		expect(result.polled).toBe(3);
	});

	it('does not touch index_closes before 15:15:01', async () => {
		const deps = baseDeps();
		await pollOnce(
			{
				...deps,
				fetchNse: async () => buildNseIndexDataResponse(),
				fetchBse: async () => [buildBseSensexRow()],
				env: {}
			},
			new Date(istAt(DAY, 15, 15, 0))
		);
		// Only the live_approx prev-close seeds, no LTP anchor row.
		const rows = await deps.store.closes.getIndexCloses(DAY);
		expect(rows.find((r) => r.source === 'ltp_anchor')).toBeUndefined();
	});

	it('attempts the anchor exactly once per day, even across polls', async () => {
		const deps = baseDeps();
		const anchors = new Map<string, DayAnchorBook>();
		const pollAt = (ms: number, feedWorks: boolean): Promise<unknown> =>
			pollOnce(
				{
					...deps,
					anchors,
					fetchNse: feedWorks
						? async () => buildNseIndexDataResponse()
						: async () => {
								throw new Error('blocked');
							},
					fetchBse: feedWorks
						? async () => [buildBseSensexRow()]
						: async () => {
								throw new Error('blocked');
							},
					env: {}
				},
				new Date(ms)
			);
		await pollAt(istAt(DAY, 15, 15, 1), true);
		// Simulate the feed dying after the anchor: a second poll must not retry.
		await pollAt(istAt(DAY, 15, 15, 5), false);
		const rows = await deps.store.closes.getIndexCloses(DAY);
		expect(rows.filter((r) => r.source === 'ltp_anchor')).toHaveLength(3);
		expect(deps.log.warn.mock.calls.some((c) => String(c[0]).includes('ltp anchor'))).toBe(false);
	});
});
