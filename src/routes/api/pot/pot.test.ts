/**
 * GET /api/pot — the ticker's numbers.
 *
 * Route-level tests against the memory store and a pinned clock, in the same
 * stub-the-RequestEvent style as ./api/cas/all. The two properties under test
 * are the interesting ones: an absent day reads as ZERO rather than as a missing
 * field, and reading never writes — a ticker polling every second must not mint
 * `daily_pots` rows for a day nobody has bet on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { istAt, THURSDAY, WEDNESDAY } from '$lib/server/cas/test-clock';
import { invalidateLadderCache } from '$lib/server/ladder';

const DAY = THURSDAY;
const BEFORE = WEDNESDAY; // the IST day before DAY
const NOW = istAt(DAY, 15, 12, 0);

type HandlerEvent = Parameters<typeof GET>[0];
const event = (): HandlerEvent =>
	({ url: new URL('http://localhost:5173/api/pot') }) as unknown as HandlerEvent;

beforeEach(() => {
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();
});

const get = async (): Promise<{
	status: number;
	headers: Headers;
	body: Record<string, unknown>;
}> => {
	const response = await GET(event());
	return { status: response.status, headers: response.headers, body: await response.json() };
};

describe('GET /api/pot', () => {
	it('serves a zeroed today and a null yesterday when nobody has bet yet', async () => {
		const { status, headers, body } = await get();
		expect(status).toBe(200);
		// Public room-wide data, but it moves constantly — nothing may cache it.
		expect(headers.get('cache-control')).toBe('no-store');
		expect(body.serverNow).toBe(NOW);
		expect(body.tradeDate).toBe(DAY);

		expect(body.today).toEqual({
			tradeDate: DAY,
			totalBets: 0,
			totalStaked: 0,
			totalPaidOut: 0,
			playersCount: 0,
			updatedAt: 0
		});
		expect(body.yesterday).toBeNull();
	});

	it('a GET creates no pot rows', async () => {
		await get();

		const store = getStore();
		// The rows the endpoint would most plausibly have "helpfully" created.
		expect(await store.pots.getDailyPot(DAY)).toBeNull();
		expect(await store.pots.getDailyPot(BEFORE)).toBeNull();
		// …and a second read is exactly as cheap and exactly as inert.
		await get();
		expect(await store.pots.getDailyPot(DAY)).toBeNull();
	});

	it('reports today and yesterday from the counters the money path wrote', async () => {
		const store = getStore();
		// What placeBet/settleBets write — deltas, never a SUM over bets.
		await store.pots.applyPotDelta(BEFORE, {
			totalBets: 5,
			totalStaked: 1_250,
			totalPaidOut: 700,
			playersCount: 3
		});
		await store.pots.applyPotDelta(DAY, {
			totalBets: 2,
			totalStaked: 400,
			playersCount: 1
		});
		await store.pots.applyPotDelta(DAY, { totalPaidOut: 600 });

		const { body } = await get();
		expect(body.today).toEqual({
			tradeDate: DAY,
			totalBets: 2,
			totalStaked: 400,
			totalPaidOut: 600,
			playersCount: 1,
			updatedAt: NOW
		});
		expect(body.yesterday).toEqual({
			tradeDate: BEFORE,
			totalBets: 5,
			totalStaked: 1_250,
			totalPaidOut: 700,
			playersCount: 3,
			updatedAt: NOW
		});
	});

	it('reads the pot only — betting, not the ticker, is what moves the counters', async () => {
		const store = getStore();
		await store.pots.applyPotDelta(DAY, { totalBets: 1, totalStaked: 10, playersCount: 1 });
		await get();
		expect(await store.pots.getDailyPot(DAY)).toMatchObject({
			totalBets: 1,
			totalStaked: 10,
			playersCount: 1
		});
	});

	it('keeps the two days apart: yesterday never answers for today', async () => {
		const store = getStore();
		await store.pots.applyPotDelta(BEFORE, { totalBets: 9, totalStaked: 900, playersCount: 9 });

		const { body } = await get();
		expect(body.today).toMatchObject({ tradeDate: DAY, totalBets: 0 });
		expect(body.yesterday).toMatchObject({ tradeDate: BEFORE, totalBets: 9 });
		// And the store itself is unchanged by the read.
		expect(await store.pots.getDailyPot(DAY)).toBeNull();
	});
});
