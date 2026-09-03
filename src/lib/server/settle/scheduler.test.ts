/**
 * The settlement scheduler (PLAN §5 T9) — the clock around the engine.
 *
 * The decision surface is pure ({@link planSettleCycle}, {@link nextDelayMs}), so
 * the whole "when does settlement fire" table is tested without a timer. The loop
 * itself runs on Vitest fake timers with injected stores and fetchers, exactly like
 * the CAS poller's tests: the one thing these tests must never do is move money on
 * a wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_IDLE_RECHECK_MS, SETTLE_RETRY_MS } from '$lib/config/app';
import { LADDER_UNDERLYINGS } from '$lib/config/ladder';
import { istAt, SATURDAY, THURSDAY, WEDNESDAY } from '$lib/server/cas/test-clock';
import {
	buildBseSensexRow,
	buildNseIndexDataResponse,
	buildNseIndexQuote
} from '$lib/server/cas/test-fixtures';
import { MemoryStore } from '$lib/server/db';
import type { LadderUnderlying } from '$lib/config/ladder';
import { invalidateLadderCache } from '$lib/server/ladder';
import {
	isSettleSchedulerRunning,
	nextDelayMs,
	planSettleCycle,
	runSettleCycle,
	settleDisabled,
	settleNow,
	startSettleScheduler,
	stopSettleScheduler,
	type SettleDeps
} from './scheduler';

const ANCHORS: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

/** Thursday 15:30:00 IST — the first instant the window is open (market close). */
const WINDOW_START = new Date(istAt(THURSDAY, 15, 30, 0));
const WINDOW_END = new Date(istAt(THURSDAY, 17, 0, 0));
const AFTER_WINDOW = new Date(istAt(THURSDAY, 17, 0, 1));
const BEFORE_WINDOW = new Date(istAt(THURSDAY, 15, 29, 59));

const cutoffOf = (tradeDate: string): number => istAt(tradeDate, 15, 20, 0);
const duringBetting = (tradeDate: string): number => istAt(tradeDate, 15, 5, 0);

type World = {
	store: MemoryStore;
	deps: SettleDeps;
	log: {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	};
	nse: ReturnType<typeof vi.fn>;
	bse: ReturnType<typeof vi.fn>;
	/** A user with a funded wallet, and a bet placed through the real money path. */
	place: (userId: string, underlying: LadderUnderlying, stake?: number) => Promise<void>;
	/**
	 * Make SENSEX look unpublished: the BSE feed goes back to its out-of-window "-"
	 * shape and today's official row is replaced by the poller's live anchor, which
	 * the engine correctly refuses to settle against.
	 */
	withholdSensex: () => Promise<void>;
	/**
	 * Drop only today's official SENSEX row, leaving the feed publishing — the shape
	 * of a capture that has not run yet.
	 */
	dropSensexClose: () => Promise<void>;
};

const BET_DAY = THURSDAY;

async function world(): Promise<World> {
	const store = new MemoryStore({ now: () => WINDOW_START.getTime() });
	await store.sessions.ensureSession(THURSDAY, cutoffOf(THURSDAY));
	for (const underlying of LADDER_UNDERLYINGS) {
		await store.closes.upsertIndexClose({
			tradeDate: WEDNESDAY,
			underlying,
			close: ANCHORS[underlying],
			source: 'official'
		});
		await store.closes.upsertIndexClose({
			tradeDate: THURSDAY,
			underlying,
			close: ANCHORS[underlying] + 50,
			source: 'official'
		});
	}
	invalidateLadderCache();

	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const nse = vi.fn(async () =>
		buildNseIndexDataResponse([
			buildNseIndexQuote({ indexName: 'NIFTY 50', indicativeClose: ANCHORS.nifty + 50 }),
			buildNseIndexQuote({ indexName: 'NIFTY BANK', indicativeClose: ANCHORS.banknifty + 50 })
		])
	);
	const bse = vi.fn(async () => [buildBseSensexRow()]);

	const place = async (
		userId: string,
		underlying: LadderUnderlying,
		stake = 100
	): Promise<void> => {
		if (!(await store.profiles.getProfile(userId))) {
			await store.profiles.insertProfile({
				userId,
				handle: userId,
				email: `${userId}@test.dev`,
				balance: 1000
			});
		}
		await store.placeBet({
			userId,
			tradeDate: BET_DAY,
			underlying,
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake,
			cutoffAtMs: cutoffOf(BET_DAY),
			nowMs: duringBetting(BET_DAY)
		});
	};

	const dropSensexClose = async (): Promise<void> => {
		// What the table looks like before the capture has run: the poller's live
		// anchor only, never an official close.
		await store.closes.upsertIndexClose({
			tradeDate: THURSDAY,
			underlying: 'sensex',
			close: ANCHORS.sensex,
			source: 'live_approx'
		});
		invalidateLadderCache();
	};

	return {
		store,
		nse,
		bse,
		log,
		deps: {
			store,
			log,
			fetchers: { fetchNseIndexData: nse, fetchNseMarketStatus: vi.fn(), fetchBseSensexRows: bse }
		},
		place,
		withholdSensex: async () => {
			// Nothing usable for SENSEX at all: neither the indicative nor the frozen
			// closing LTP (the empty array is the upstream failure shape too).
			bse.mockResolvedValue([]);
			await dropSensexClose();
		},
		dropSensexClose
	};
}

describe('planSettleCycle — when settlement may fire', () => {
	const plan = (now: Date, status: 'open' | 'locked' | 'settling' | 'settled' | null): string => {
		const session = status ? { status } : null;
		const result = planSettleCycle(now, session);
		return `${result.action}:${result.reason}`;
	};

	it.each([
		['one second before the window', BEFORE_WINDOW, 'open', 'idle:BEFORE_WINDOW'],
		['mid-window, session open', new Date(istAt(THURSDAY, 16, 30, 0)), 'open', 'run:SESSION_OPEN'],
		[
			'mid-window, session locked',
			new Date(istAt(THURSDAY, 16, 30, 0)),
			'locked',
			'run:SESSION_LOCKED'
		],
		// A `settling` row still runs: settleSession backs off (busy) if the owner is
		// alive, and takes over if it died. Retrying beats a day stuck forever.
		[
			'mid-window, session mid-settle',
			new Date(istAt(THURSDAY, 16, 30, 0)),
			'settling',
			'run:SESSION_SETTLING'
		],
		['the first instant of the window', WINDOW_START, 'open', 'run:SESSION_OPEN'],
		['the last instant of the window', WINDOW_END, 'open', 'run:SESSION_OPEN'],
		['one second past the window', AFTER_WINDOW, 'open', 'idle:AFTER_WINDOW'],
		['late evening', new Date(istAt(THURSDAY, 23, 0, 0)), 'open', 'idle:AFTER_WINDOW'],
		[
			'Saturday in the window (market closed)',
			new Date(istAt(SATURDAY, 16, 0, 0)),
			'open',
			'idle:WEEKEND'
		],
		['Sunday before the window', new Date(istAt('2026-08-30', 9, 0, 0)), 'open', 'idle:WEEKEND']
	])('%s → %s', (_name, now, status, expected) => {
		// `it.each` widens the row to string[]; the literal union is what matters.
		expect(plan(now, status as 'open' | 'locked' | 'settling' | 'settled')).toBe(expected);
	});

	it('skips the window entirely when there is nothing to settle', () => {
		expect(plan(WINDOW_START, null)).toBe('skip:NO_SESSION');
		expect(plan(WINDOW_START, 'settled')).toBe('skip:ALREADY_SETTLED');
	});

	it('never fires on a weekend, whatever the session says', () => {
		expect(plan(new Date(istAt(SATURDAY, 16, 0, 0)), 'open')).toBe('idle:WEEKEND');
	});
});

describe('nextDelayMs', () => {
	it('uses the retry cadence inside the window', () => {
		expect(nextDelayMs(WINDOW_START, { action: 'run', reason: 'SESSION_OPEN' })).toBe(
			SETTLE_RETRY_MS
		);
		expect(nextDelayMs(WINDOW_START, { action: 'skip', reason: 'NO_SESSION' })).toBe(
			SETTLE_RETRY_MS
		);
	});

	it('idles on the coarse cadence outside the window', () => {
		expect(nextDelayMs(AFTER_WINDOW, { action: 'idle', reason: 'AFTER_WINDOW' })).toBe(
			SETTLE_IDLE_RECHECK_MS
		);
		expect(
			nextDelayMs(new Date(istAt(SATURDAY, 16, 0, 0)), { action: 'idle', reason: 'WEEKEND' })
		).toBe(SETTLE_IDLE_RECHECK_MS);
	});

	it('never sleeps past the moment the window opens', () => {
		// 15:20 is 10 minutes before the window; the idle cap wins.
		expect(
			nextDelayMs(new Date(istAt(THURSDAY, 15, 20, 0)), { action: 'idle', reason: 'BEFORE_WINDOW' })
		).toBe(SETTLE_IDLE_RECHECK_MS);
		// 15:29:59.5 is half a second away — wake up for it.
		expect(
			nextDelayMs(new Date(istAt(THURSDAY, 15, 29, 59, 500)), {
				action: 'idle',
				reason: 'BEFORE_WINDOW'
			})
		).toBe(500);
	});
});

describe('settleDisabled', () => {
	it('is disabled under VITEST and by SETTLE_DISABLED', () => {
		expect(settleDisabled({ VITEST: 'true' })).toBe(true);
		expect(settleDisabled({ SETTLE_DISABLED: '1' })).toBe(true);
		expect(settleDisabled({ SETTLE_DISABLED: 'true' })).toBe(true);
		expect(settleDisabled({ SETTLE_DISABLED: ' 0 ' })).toBe(false);
		expect(settleDisabled({})).toBe(false);
	});
});

describe('runSettleCycle', () => {
	let w: World;

	beforeEach(async () => {
		w = await world();
	});

	it('captures and settles a ready day in one cycle', async () => {
		await w.place('priya', 'nifty');

		const report = await runSettleCycle(w.deps, WINDOW_START);

		expect(report.plan).toEqual({ action: 'run', reason: 'SESSION_OPEN' });
		expect(report.retry).toBe(false);
		expect(report.capture?.captured).toEqual(['nifty', 'banknifty', 'sensex']);
		expect(report.settle?.status).toBe('settled');
		expect(report.settle?.paidOut).toBe(600);
		expect((await w.store.profiles.getProfile('priya'))?.balance).toBe(1_500);
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('settled');
	});

	it('captures nothing and asks for a retry when the closes are missing', async () => {
		await w.place('priya', 'sensex');
		await w.withholdSensex();

		const report = await runSettleCycle(w.deps, WINDOW_START);

		expect(report.capture?.missing).toContain('sensex');
		expect(report.settle).toBeUndefined();
		expect(report.retry).toBe(true);
		expect(w.log.warn).toHaveBeenCalledWith(expect.stringContaining('not ready'));
		// The day is untouched — still open, nothing settled, nobody paid.
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('open');
		expect((await w.store.profiles.getProfile('priya'))?.balance).toBe(900);
	});

	it('does not settle a partially-captured day: it waits for all three closes', async () => {
		await w.place('priya', 'nifty');
		await w.place('priya', 'sensex');
		await w.withholdSensex();

		const report = await runSettleCycle(w.deps, WINDOW_START);

		// NIFTY alone would be settleable, but the engine runs on the whole day: the
		// cycle comes back in SETTLE_RETRY_MS rather than paying half of it early.
		expect(report.settle).toBeUndefined();
		expect(report.capture?.missing).toEqual(['sensex']);
		expect(report.retry).toBe(true);
		expect((await w.store.profiles.getProfile('priya'))?.balance).toBe(800); // both stakes held
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('open');
	});

	it('does nothing at all outside the window', async () => {
		const report = await runSettleCycle(w.deps, BEFORE_WINDOW);
		expect(report.plan).toEqual({ action: 'idle', reason: 'BEFORE_WINDOW' });
		expect(report.capture).toBeUndefined();
		expect(w.nse).not.toHaveBeenCalled();
	});

	it('never invents a session: no row, no settlement, no upstream calls', async () => {
		const fresh = new MemoryStore({ now: () => WINDOW_START.getTime() });
		const report = await runSettleCycle({ ...w.deps, store: fresh }, WINDOW_START);

		expect(report.plan).toEqual({ action: 'skip', reason: 'NO_SESSION' });
		expect(w.nse).not.toHaveBeenCalled();
		expect(await fresh.closes.getIndexCloses(THURSDAY)).toHaveLength(0);
	});

	it('leaves a settled day alone', async () => {
		await runSettleCycle(w.deps, WINDOW_START);
		w.nse.mockClear();
		const report = await runSettleCycle(w.deps, WINDOW_START);

		expect(report.plan).toEqual({ action: 'skip', reason: 'ALREADY_SETTLED' });
		expect(w.nse).not.toHaveBeenCalled();
	});
});

describe('the loop', () => {
	let w: World;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(WINDOW_START);
		w = await world();
	});

	afterEach(() => {
		stopSettleScheduler();
		vi.useRealTimers();
		expect(isSettleSchedulerRunning()).toBe(false);
	});

	it('starts once per process, refuses under VITEST, and stops cleanly', async () => {
		expect(startSettleScheduler()).toBe(false); // VITEST is set in this run
		expect(isSettleSchedulerRunning()).toBe(false);
		expect(startSettleScheduler({ ...w.deps, env: { SETTLE_DISABLED: '1' } })).toBe(false);
		expect(isSettleSchedulerRunning()).toBe(false);
	});

	it('gives up loudly once the window closes on an unsettled day', async () => {
		await w.place('priya', 'sensex');
		await w.withholdSensex();

		vi.setSystemTime(WINDOW_START);
		expect(startSettleScheduler({ ...w.deps, env: {} })).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		// Retry twice more inside the window: still no SENSEX close.
		await vi.advanceTimersByTimeAsync(SETTLE_RETRY_MS);
		await vi.advanceTimersByTimeAsync(SETTLE_RETRY_MS);
		expect(w.log.error).not.toHaveBeenCalled();

		// 17:00:01 — the window closes on an open session.
		vi.setSystemTime(AFTER_WINDOW);
		await vi.advanceTimersByTimeAsync(SETTLE_RETRY_MS);
		expect(w.log.error).toHaveBeenCalledTimes(1);
		expect(String(w.log.error.mock.calls[0]?.[0])).toContain('GIVING UP');
		expect(String(w.log.error.mock.calls[0]?.[0])).toContain(THURSDAY);
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('open');
		// ...and nobody was paid on a guess.
		expect((await w.store.profiles.getProfile('priya'))?.balance).toBe(900);

		// …and it says so once, not once a cycle.
		await vi.advanceTimersByTimeAsync(SETTLE_IDLE_RECHECK_MS);
		expect(w.log.error).toHaveBeenCalledTimes(1);
	});

	it('does not give up loudly on a day that settled cleanly', async () => {
		expect(startSettleScheduler({ ...w.deps, env: {} })).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('settled');

		vi.setSystemTime(AFTER_WINDOW);
		await vi.advanceTimersByTimeAsync(SETTLE_IDLE_RECHECK_MS);
		expect(w.log.error).not.toHaveBeenCalled();
	});
});

describe('settleNow — the manual escape hatch', () => {
	let w: World;

	beforeEach(async () => {
		w = await world();
		await w.place('priya', 'nifty');
	});

	it('settles outside the 15:30–17:00 window', async () => {
		const { settle } = await settleNow(w.store, THURSDAY, {
			...w.deps,
			capture: false,
			now: new Date(istAt(THURSDAY, 22, 0, 0))
		});

		expect(settle.status).toBe('settled');
		expect((await w.store.profiles.getProfile('priya'))?.balance).toBe(1_500);
	});

	it('captures when it is today and the auction has finished', async () => {
		// SENSEX's close never landed but the feed is publishing: capture refills it.
		await w.place('devi', 'sensex');
		await w.dropSensexClose();
		const { capture, settle } = await settleNow(w.store, THURSDAY, {
			...w.deps,
			now: WINDOW_START
		});

		expect(capture?.written).toContain('sensex');
		expect(settle.status).toBe('settled');
	});

	it('never invents a close for a past date', async () => {
		await w.place('devi', 'sensex');
		await w.withholdSensex();
		const { capture, settle } = await settleNow(w.store, THURSDAY, {
			...w.deps,
			now: new Date(istAt('2026-09-04', 15, 50, 0)) // the following Friday
		});

		// Not today's date → no capture attempt, and the missing close is not invented.
		expect(capture).toBeUndefined();
		expect(settle.status).toBe('incomplete');
		expect(settle.incomplete).toEqual(['sensex']);
		expect((await w.store.sessions.getSessionByDate(THURSDAY))?.status).toBe('open');
		expect((await w.store.profiles.getProfile('devi'))?.balance).toBe(900);
	});
});
