/**
 * `/leaderboard` — the page's server load.
 *
 * The load is one line over the service, so what is worth pinning at the route
 * level is the CONTRACT: the payload shape the page renders, that it is public
 * (no `locals` anywhere in the path), and that it is the cached singleton —
 * two loads inside 30s must not read the store twice.
 *
 * Privacy is a string search over the SERIALIZED payload, not a field list: the
 * board is public by construction, so the only way a private value could appear
 * is a field somebody adds later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { invalidateLeaderboardCache } from '$lib/server/leaderboard';
import { istAt, THURSDAY } from '$lib/server/cas/test-clock';

const DAY = THURSDAY;
const NOW = istAt(DAY, 16, 0, 0);
const EMAIL = 'whale@example.com';
const USER_ID = '00000000-0000-4000-8000-000000000001';

type LoadEvent = Parameters<typeof load>[0];

const event = (): LoadEvent =>
	({ url: new URL('http://localhost:5173/leaderboard') }) as unknown as LoadEvent;

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

async function seedWhale(): Promise<void> {
	const store = getStore();
	await store.sessions.ensureSession(DAY, istAt(DAY, 15, 20, 0));
	await store.profiles.insertProfile({
		userId: USER_ID,
		handle: 'whale',
		email: EMAIL,
		balance: 42_000
	});
	await store.profiles.applyProfileProgress(USER_ID, {
		xpDelta: 1_500,
		streakDays: 5,
		lastBetDate: DAY
	});
	await store.stats.applyStatsDelta(USER_ID, { betsPlaced: 10, betsWon: 4 });
}

describe('/leaderboard load', () => {
	it('serves the three sections under `board`, all empty on a fresh instance', async () => {
		const payload = (await load(event())) as { board: Record<string, unknown> };
		expect(Object.keys(payload.board).sort()).toEqual([
			'balances',
			'generatedAt',
			'streaks',
			'topWins',
			'tradeDate'
		]);
		expect(payload.board.balances).toEqual([]);
		expect(payload.board.streaks).toEqual([]);
		expect(payload.board.topWins).toEqual([]);
		expect(payload.board.tradeDate).toBe(DAY);
	});

	it('serves the populated board once players exist', async () => {
		await seedWhale();

		const payload = (await load(event())) as {
			board: { balances: unknown[]; streaks: unknown[]; topWins: unknown[] };
		};
		expect(payload.board.balances).toHaveLength(1);
		expect(payload.board.streaks).toHaveLength(1);
		// The whale's bet is LIVE — no settled call on the board yet.
		expect(payload.board.topWins).toEqual([]);
	});

	it('carries no email and no user id anywhere in the serialized payload', async () => {
		await seedWhale();

		const text = JSON.stringify(await load(event())).toLowerCase();
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain('whale@');
		expect(text).not.toContain('example.com');
		expect(text).not.toContain(USER_ID);
		expect(text).not.toContain('email');
		expect(text).not.toContain('user_id');
		expect(text).not.toContain('userid');
	});

	it('needs no identity: a request without locals is the same board', async () => {
		await seedWhale();
		const anonymous = { url: new URL('http://localhost:5173/leaderboard') } as unknown as LoadEvent;

		const payload = (await load(anonymous)) as { board: { balances: { handle: string }[] } };
		expect(payload.board.balances.map((row) => row.handle)).toEqual(['whale']);
	});

	it('serves the cached singleton: two loads inside 30s read the store once', async () => {
		await seedWhale();

		const first = (await load(event())) as { board: unknown };
		const second = (await load(event())) as { board: unknown };

		expect(second).toEqual(first);
		// The second load is the cached object, not a rebuild of it.
		expect(second.board).toBe(first.board);
	});
});
