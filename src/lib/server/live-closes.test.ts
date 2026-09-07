/**
 * Live previous-close fallback — the "No ladder … previous close has not landed
 * yet" fix.
 *
 * When `index_closes` has no anchor (fresh deploy, or before the 15:15:01 LTP
 * anchor lands), the ladder, the `/api/state` payload and bet validation all
 * fall back to the LAST TRADED PRICE the NSE/BSE feeds carry right now — the
 * same number the chart's first point shows, never yesterday's close — so a
 * logged-in player sees bettable ladders instead of an empty card. Every test
 * here injects the feeds; the real network is never touched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SIGNUP_BONUS } from '$lib/config/app';
import { MemoryStore, type GameStore } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { istAt } from '$lib/server/cas/test-clock';
import {
	fetchLivePrevCloses,
	fillAnchorsFromLive,
	invalidateLiveClosesCache,
	type LiveCloseDeps
} from './live-closes';
import {
	getLadderForDate,
	getLadderForDateWithLiveFallback,
	invalidateLadderCache,
	resolveLadderOption
} from './ladder';
import { buildStatePayload } from './state';
import { BetError, placeBet } from './bets';

// A Thursday trading day; the participation window is 15:15–15:20 IST.
const THURSDAY = '2026-08-27';
const at = (h: number, m = 0, s = 0): Date => new Date(istAt(THURSDAY, h, m, s));

const NIFTY_CLOSE = 25_000;
const BANK_CLOSE = 56_000;
const SENSEX_CLOSE = 82_000;

/** The feeds as they look outside the CAS window: no indicatives, prev closes present. */
const LIVE_DEPS: LiveCloseDeps = {
	fetchNseIndexData: async () => ({
		data: [
			{ indexName: 'NIFTY 50', previousClose: NIFTY_CLOSE, indicativeClose: 0, last: NIFTY_CLOSE },
			{ indexName: 'NIFTY BANK', previousClose: BANK_CLOSE, indicativeClose: 0, last: BANK_CLOSE }
		]
	}),
	fetchBseSensexRows: async () => [
		{ indxnm: 'BSE SENSEX', Prev_Close: '82,000', iclsprice: '-', ltp: '82,000' }
	]
};

const USER = '00000000-0000-4000-8000-00000000u009';

/** Fresh store with a funded player and deliberately NO closes — the bug's setup. */
async function emptyStore(): Promise<GameStore> {
	invalidateLadderCache();
	invalidateLiveClosesCache();
	const store = new MemoryStore({ now: () => istAt(THURSDAY, 12, 0, 0) });
	await store.profiles.insertProfile({
		userId: USER,
		handle: 'meera',
		email: 'm@x.dev',
		balance: SIGNUP_BONUS
	});
	return store;
}

beforeEach(() => {
	invalidateLadderCache();
	invalidateLiveClosesCache();
});

describe('fetchLivePrevCloses', () => {
	it('reads previousClose / Prev_Close, tolerating comma strings', async () => {
		expect(
			await fetchLivePrevCloses({ nifty: true, banknifty: true, sensex: true }, LIVE_DEPS)
		).toEqual({ nifty: NIFTY_CLOSE, banknifty: BANK_CLOSE, sensex: SENSEX_CLOSE });
	});

	it('only hits the feeds it needs', async () => {
		let nseCalls = 0;
		let bseCalls = 0;
		const deps: LiveCloseDeps = {
			fetchNseIndexData: async () => {
				nseCalls += 1;
				return { data: [] };
			},
			fetchBseSensexRows: async () => {
				bseCalls += 1;
				return [];
			}
		};
		await fetchLivePrevCloses({ nifty: false, banknifty: false, sensex: true }, deps);
		expect(nseCalls).toBe(0);
		expect(bseCalls).toBe(1);
	});

	it('never throws: a dead upstream resolves to nulls', async () => {
		const deps: LiveCloseDeps = {
			fetchNseIndexData: async () => {
				throw new Error('blocked');
			},
			fetchBseSensexRows: async () => {
				throw new Error('blocked');
			}
		};
		await expect(
			fetchLivePrevCloses({ nifty: true, banknifty: true, sensex: true }, deps)
		).resolves.toEqual({ nifty: null, banknifty: null, sensex: null });
	});

	it('ignores non-positive closes rather than anchoring at zero', async () => {
		const deps: LiveCloseDeps = {
			fetchNseIndexData: async () => ({
				data: [
					{ indexName: 'NIFTY 50', previousClose: 0 },
					{ indexName: 'NIFTY BANK', previousClose: -5 }
				]
			}),
			fetchBseSensexRows: async () => [{ indxnm: 'BSE SENSEX', Prev_Close: '-' }]
		};
		await expect(
			fetchLivePrevCloses({ nifty: true, banknifty: true, sensex: true }, deps)
		).resolves.toEqual({ nifty: null, banknifty: null, sensex: null });
	});
});

describe('fillAnchorsFromLive', () => {
	it('keeps DB anchors and fills only the holes', async () => {
		await expect(
			fillAnchorsFromLive({ nifty: 24_900, banknifty: null, sensex: null }, LIVE_DEPS)
		).resolves.toEqual({ nifty: 24_900, banknifty: BANK_CLOSE, sensex: SENSEX_CLOSE });
	});
});

describe('the reported bug: empty DB, logged-in player', () => {
	it('getLadderForDate stays DB-only (nulls), the live wrapper builds the full ladder', async () => {
		const store = await emptyStore();
		expect((await getLadderForDate(store, THURSDAY)).options).toHaveLength(0);

		const ladder = await getLadderForDateWithLiveFallback(store, THURSDAY, LIVE_DEPS);
		expect(ladder.anchors).toEqual({
			nifty: NIFTY_CLOSE,
			banknifty: BANK_CLOSE,
			sensex: SENSEX_CLOSE
		});
		expect(ladder.options).toHaveLength(110);
	});

	it('the state payload carries bettable ladders instead of an empty card', async () => {
		const store = await emptyStore();
		const payload = await buildStatePayload({
			store,
			now: at(15, 18),
			userId: USER,
			authSource: 'dev',
			live: LIVE_DEPS
		});
		expect(payload.user?.handle).toBe('meera');
		expect(payload.ladder.anchors.nifty).toBe(NIFTY_CLOSE);
		expect(payload.ladder.options).toHaveLength(110);
	});

	it('a rung the player could SEE is a rung they can BET', async () => {
		const store = await emptyStore();
		const bet = await placeBet(
			USER,
			{ underlying: 'nifty', targetKind: 'up', deltaPoints: 50, stake: 100 },
			{ now: at(15, 16), store, live: LIVE_DEPS }
		);
		expect(bet.odds).toBe(28);
		expect(bet.deltaPoints).toBe(50);
	});

	it('resolveLadderOption still rejects off-ladder steps, even with live anchors', async () => {
		const store = await emptyStore();
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 75, store, LIVE_DEPS)).toBeNull();
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 50, store, LIVE_DEPS)).toMatchObject({
			odds: 28
		});
	});

	it('DB-only callers are unaffected: empty DB still rejects without live', async () => {
		const store = await emptyStore();
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 50, store)).toBeNull();
		await expect(
			placeBet(
				USER,
				{ underlying: 'nifty' as Underlying, targetKind: 'up', deltaPoints: 50, stake: 100 },
				{ now: at(15, 16), store, live: false }
			)
		).rejects.toBeInstanceOf(BetError);
	});
});
