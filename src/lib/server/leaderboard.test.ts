/**
 * `buildLeaderboard` + its 30s cache — the service behind `/leaderboard`.
 *
 * The payload is the whole privacy surface for the page (nothing else touches
 * these reads), so the deep-search test here string-matches the SERIALIZED board,
 * not the fields a reader thinks are in it — the same paranoia
 * `/api/state`'s tests apply, because a field added tomorrow leaks the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LEADERBOARD_ROWS } from '$lib/config/app';
import { getStore, resetStoreForTests, type GameStore } from '$lib/server/db';
import {
	buildLeaderboard,
	createLeaderboardReader,
	invalidateLeaderboardCache,
	type LeaderboardPayload
} from './leaderboard';
import { istAt, THURSDAY } from '$lib/server/cas/test-clock';
import { shiftIstDate } from '$lib/time/ist';

const DAY = THURSDAY;
const PREV = shiftIstDate(DAY, -1);
const NOW = istAt(DAY, 16, 0, 0);

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Player = {
	id: string;
	handle: string;
	email: string;
	balance: number;
	xp: number;
	streak: number;
	placed: number;
	won: number;
};

const PLAYERS: Player[] = [
	{
		id: uuid(1),
		handle: 'whale',
		email: 'w@example.com',
		balance: 90_000,
		xp: 10_000,
		streak: 4,
		placed: 90,
		won: 40
	},
	{
		id: uuid(2),
		handle: 'streaker',
		email: 's@example.com',
		balance: 5_000,
		xp: 1_500,
		streak: 9,
		placed: 20,
		won: 9
	},
	{
		id: uuid(3),
		handle: 'rookie',
		email: 'r@example.com',
		balance: 1_000,
		xp: 0,
		streak: 0,
		placed: 0,
		won: 0
	}
];

/** The day's settled calls, seeded through the store the way settlement would leave them. */
async function seedBoard(store: GameStore): Promise<void> {
	await store.sessions.ensureSession(DAY, istAt(DAY, 15, 20, 0));
	await store.sessions.ensureSession(PREV, istAt(PREV, 15, 20, 0));

	for (const player of PLAYERS) {
		await store.profiles.insertProfile({
			userId: player.id,
			handle: player.handle,
			email: player.email,
			balance: player.balance
		});
		await store.profiles.applyProfileProgress(player.id, {
			xpDelta: player.xp,
			streakDays: player.streak,
			lastBetDate: player.streak > 0 ? DAY : PREV
		});
		await store.stats.applyStatsDelta(player.id, {
			betsPlaced: player.placed,
			betsWon: player.won,
			totalStaked: player.placed * 100,
			totalWon: player.won * 220,
			bestPayout: player.won > 0 ? 1_350 : 0
		});
	}

	const call = async (
		userId: string,
		underlying: 'nifty' | 'banknifty' | 'sensex',
		payout: number,
		day: string
	): Promise<void> => {
		const session = await store.sessions.getSessionByDate(day);
		const bet = await store.bets.upsertBet({
			userId,
			sessionId: session?.id ?? 0,
			underlying,
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake: 100
		});
		await store.bets.setBetOutcome(bet.id, payout > 0 ? 'hit' : 'miss', payout, istAt(day, 15, 45));
	};

	await call(PLAYERS[0].id, 'nifty', 1_350, DAY);
	await call(PLAYERS[1].id, 'banknifty', 900, DAY);
	await call(PLAYERS[0].id, 'banknifty', 5_000, PREV); // yesterday — must not appear today
	// A live bet: on the board of nobody's "biggest calls".
	const session = await store.sessions.getSessionByDate(DAY);
	const live = await store.bets.upsertBet({
		userId: PLAYERS[2].id,
		sessionId: session?.id ?? 0,
		underlying: 'sensex',
		targetKind: 'down',
		deltaPoints: 250,
		odds: 4.5,
		stake: 100
	});
	void live;
}

beforeEach(() => {
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLeaderboardCache();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLeaderboardCache();
});

describe('buildLeaderboard', () => {
	it('assembles all three sections from one trade date', async () => {
		const store = getStore();
		await seedBoard(store);

		const board = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW) });

		expect(board.tradeDate).toBe(DAY);
		expect(board.generatedAt).toBe(NOW);
		expect(board.balances.map((row) => row.handle)).toEqual(['whale', 'streaker', 'rookie']);
		expect(board.streaks.map((row) => row.handle)).toEqual(['streaker', 'whale']);
		// Today only, and the live bet is nowhere on it.
		expect(board.topWins.map((row) => row.handle)).toEqual(['whale', 'streaker']);
		expect(board.topWins[0]).toEqual({
			handle: 'whale',
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			stake: 100,
			payout: 1_350,
			odds: 6,
			tier: 'hit'
		});
	});

	it('derives the win rate, and leaves it null for a player who has never settled', async () => {
		const store = getStore();
		await seedBoard(store);

		const board = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW) });

		expect(board.balances.map((row) => row.winRate)).toEqual([40 / 90, 9 / 20, null]);
	});

	it('caps each section at the caller limit, inside the hard cap', async () => {
		const store = getStore();
		for (let i = 0; i < MAX_LEADERBOARD_ROWS + 10; i += 1) {
			await store.profiles.insertProfile({
				userId: uuid(100 + i),
				handle: `board${String(i).padStart(3, '0')}`,
				email: `b${i}@example.com`,
				balance: 10_000 - i
			});
		}

		const board = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW), limit: 5 });
		expect(board.balances).toHaveLength(5);
		expect(board.streaks).toEqual([]);
		// Asking for more than the product cap is clamped by the driver, not served.
		const greedy = await buildLeaderboard({
			store,
			tradeDate: DAY,
			now: new Date(NOW),
			limit: MAX_LEADERBOARD_ROWS * 10
		});
		expect(greedy.balances.length).toBeLessThanOrEqual(MAX_LEADERBOARD_ROWS);
	});

	it('renders an empty board on a fresh instance — sections present, nothing in them', async () => {
		const board = await buildLeaderboard({
			store: getStore(),
			tradeDate: DAY,
			now: new Date(NOW)
		});
		expect(board).toEqual({
			tradeDate: DAY,
			generatedAt: NOW,
			balances: [],
			streaks: [],
			topWins: []
		});
	});

	it('carries no email, no user id and no bet id anywhere in the serialized payload', async () => {
		const store = getStore();
		await seedBoard(store);

		const board = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW) });
		const text = JSON.stringify(board).toLowerCase();

		for (const player of PLAYERS) {
			expect(text).not.toContain(player.email);
			expect(text).not.toContain(player.id);
		}
		expect(text).not.toContain('email');
		expect(text).not.toContain('example.com');
		expect(text).not.toContain('user_id');
		expect(text).not.toContain('userid');
		expect(text).not.toContain('settlementtier');
		expect(text).not.toContain('"id"');
	});
});

describe('the 30s leaderboard cache', () => {
	it('serves the same payload within the TTL and rebuilds after it', async () => {
		const store = getStore();
		await seedBoard(store);

		let time = NOW;
		const cache = new Map<string, { value: LeaderboardPayload; expiresAt: number }>();
		const reader = createLeaderboardReader({
			store,
			now: () => time,
			cache,
			ttlMs: 30_000
		});

		const first = await reader(DAY);
		const second = await reader(DAY);
		expect(second).toBe(first); // the same object — no rebuild
		expect(cache.size).toBe(1);

		time += 29_999;
		await expect(reader(DAY)).resolves.toBe(first);

		time += 1;
		const rebuilt = await reader(DAY);
		expect(rebuilt).not.toBe(first);
		// …and the rebuild is the same board, stamped with the newer instant.
		expect(rebuilt.balances).toEqual(first.balances);
		expect(rebuilt.topWins).toEqual(first.topWins);
		expect(rebuilt.generatedAt).toBe(time);
	});

	it('keys on the trade date, so yesterday and today are two entries', async () => {
		const store = getStore();
		await seedBoard(store);

		const cache = new Map<string, { value: LeaderboardPayload; expiresAt: number }>();
		const reader = createLeaderboardReader({
			store,
			now: () => NOW,
			cache,
			ttlMs: 30_000
		});

		await reader(DAY);
		await reader(DAY);
		await reader(PREV);
		expect(cache.size).toBe(2);
	});

	it('defaults the trade date to today on the IST clock', async () => {
		const store = getStore();
		await seedBoard(store);
		const reader = createLeaderboardReader({ store, now: () => NOW, ttlMs: 30_000 });
		await expect(reader()).resolves.toMatchObject({ tradeDate: DAY });
	});

	it('the process singleton forgets everything on invalidateLeaderboardCache', async () => {
		const store = getStore();
		await seedBoard(store);

		const first = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW) });
		invalidateLeaderboardCache();
		const second = await buildLeaderboard({ store, tradeDate: DAY, now: new Date(NOW) });
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});
