/**
 * GET /api/u/<handle> — the public profile JSON.
 *
 * Route-level test in the stub-the-RequestEvent style, against the memory store.
 * Bets are written straight through the store (rather than through the bet
 * service) because what is under test here is the *projection*: who can be seen,
 * what they show and how many. The privacy assertions search the whole serialized
 * body for the same reason the /api/state ones do — a field added tomorrow must
 * fail here, not slip out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { PROFILE_RECENT_BETS } from '$lib/server/profile';
import { getStore, resetStoreForTests, type GameStore } from '$lib/server/db';
import type { SettlementTier, Underlying } from '$lib/server/db/types';
import { istAt } from '$lib/server/cas/test-clock';
import { shiftIstDate } from '$lib/time/ist';

const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HANDLE = 'priya';
const EMAIL = 'priya@example.com';
const NOW = istAt('2026-08-27', 16, 0, 0);

type HandlerEvent = Parameters<typeof GET>[0];
const event = (handle?: string): HandlerEvent =>
	({
		params: { handle: handle ?? HANDLE },
		url: new URL(`http://localhost:5173/api/u/${handle ?? HANDLE}`)
	}) as unknown as HandlerEvent;

beforeEach(() => {
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
});

async function seedPlayer(userId: string, handle: string, email: string): Promise<GameStore> {
	const store = getStore();
	await store.profiles.insertProfile({ userId, handle, email, balance: 1_000 });
	return store;
}

/**
 * One settled bet on `tradeDate`, with the stats counters the settlement engine
 * would have moved alongside it. `sequence` stamps the settlement instant so the
 * strip's ordering is unambiguous even though a whole day settles together.
 */
async function settledBet(
	store: GameStore,
	userId: string,
	tradeDate: string,
	underlying: Underlying,
	sequence: number,
	tier: SettlementTier = 'hit'
): Promise<void> {
	const session = await store.sessions.ensureSession(tradeDate, istAt(tradeDate, 15, 20, 0));
	await store.tx(async (t) => {
		const bet = await t.bets.upsertBet({
			userId,
			sessionId: session.id,
			underlying,
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake: 10
		});
		await t.bets.setBetOutcome(
			bet.id,
			tier,
			tier === 'hit' ? 60 : 0,
			istAt(tradeDate, 15, 45, 0, sequence)
		);
		await t.stats.applyStatsDelta(userId, {
			betsPlaced: 1,
			betsWon: tier === 'hit' ? 1 : 0,
			totalStaked: 10,
			totalWon: tier === 'hit' ? 60 : 0,
			bestPayout: tier === 'hit' ? 60 : 0
		});
	});
}

describe('GET /api/u/[handle]', () => {
	it('is 404 NOT_FOUND for a handle nobody owns', async () => {
		await seedPlayer(USER, HANDLE, EMAIL);
		const response = await GET(event('nobody'));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
	});

	it('is 400 for a string that can never be a handle', async () => {
		await seedPlayer(USER, HANDLE, EMAIL);
		for (const bad of ['x', '../etc/passwd', '%20%20%20', 'Not-A-Handle']) {
			const response = await GET(event(bad));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'INVALID_HANDLE' });
		}
	});

	it('matches case-insensitively — handles are stored lowercase, URLs are not', async () => {
		await seedPlayer(USER, HANDLE, EMAIL);
		expect((await GET(event('PRIYA'))).status).toBe(200);
	});

	it('serves the public fields, and nothing private anywhere in the body', async () => {
		const store = await seedPlayer(USER, HANDLE, EMAIL);
		await settledBet(store, USER, '2026-08-27', 'nifty', 0, 'hit');
		await settledBet(store, USER, '2026-08-27', 'sensex', 1, 'miss');

		const response = await GET(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');

		// One read of the body; the lowercase copy is only for the leak search.
		const text = await response.text();
		const lowered = text.toLowerCase();
		const { profile } = JSON.parse(text) as { profile: Record<string, unknown> };
		expect(profile).toEqual({
			handle: HANDLE,
			balance: 1_000,
			xp: 0,
			streakDays: 0,
			winRate: 0.5,
			totals: {
				betsPlaced: 2,
				betsWon: 1,
				totalStaked: 20,
				totalWon: 60,
				bestPayout: 60
			},
			recentBets: [
				{
					underlying: 'sensex',
					targetKind: 'up',
					deltaPoints: 50,
					stake: 10,
					tier: 'miss',
					payout: 0,
					settledOn: '2026-08-27'
				},
				{
					underlying: 'nifty',
					targetKind: 'up',
					deltaPoints: 50,
					stake: 10,
					tier: 'hit',
					payout: 60,
					settledOn: '2026-08-27'
				}
			],
			joined: '2026-08-27',
			rank: null
		});

		// Whole-body search: the profile is public, so it must survive a stranger
		// reading every byte of it.
		expect(lowered).not.toContain(EMAIL);
		expect(lowered).not.toContain('priya@'); // the handle is public, the address is not
		expect(lowered).not.toContain('example.com');
		expect(lowered).not.toContain(USER.toLowerCase());
		expect(lowered).not.toContain(OTHER.toLowerCase());
		for (const forbidden of ['email', 'userid', 'user_id', 'authsource', 'ledger']) {
			expect(lowered).not.toContain(forbidden);
		}
	});

	it('never shows another player’s bets', async () => {
		const store = await seedPlayer(USER, HANDLE, EMAIL);
		await seedPlayer(OTHER, 'arjun', 'arjun@example.com');
		await settledBet(store, OTHER, '2026-08-27', 'banknifty', 0);

		const { profile } = (await (await GET(event())).json()) as {
			profile: { recentBets: unknown[] };
		};
		expect(profile.recentBets).toEqual([]);
	});

	it('winRate is null rather than 0 for a player who has never settled a bet', async () => {
		await seedPlayer(USER, HANDLE, EMAIL);
		const { profile } = (await (await GET(event())).json()) as {
			profile: { winRate: number | null; totals: { betsPlaced: number } };
		};
		expect(profile.totals.betsPlaced).toBe(0);
		expect(profile.winRate).toBeNull();
	});

	it('caps the recent strip at 20, keeping the newest and dropping the oldest', async () => {
		const store = await seedPlayer(USER, HANDLE, EMAIL);

		// Three indices a day is the most one player can have, so 7 days × 3 = 21
		// settled bets: exactly one more than the cap.
		const underlyings: Underlying[] = ['nifty', 'banknifty', 'sensex'];
		let sequence = 0;
		for (let day = 0; day < 7; day += 1) {
			const tradeDate = shiftIstDate('2026-08-17', day);
			for (const underlying of underlyings) {
				await settledBet(store, USER, tradeDate, underlying, sequence);
				sequence += 1;
			}
		}
		// One open bet: never on the public strip, and it must not displace a result.
		const openDate = shiftIstDate('2026-08-17', 7);
		const session = await store.sessions.ensureSession(openDate, istAt(openDate, 15, 20, 0));
		await store.tx((t) =>
			t.bets.upsertBet({
				userId: USER,
				sessionId: session.id,
				underlying: 'nifty',
				targetKind: 'down',
				deltaPoints: 100,
				odds: 4.5,
				stake: 25
			})
		);

		const { profile } = (await (await GET(event())).json()) as {
			profile: { recentBets: { settledOn: string; underlying: Underlying }[] };
		};

		expect(profile.recentBets).toHaveLength(PROFILE_RECENT_BETS);
		// Newest first: the last bet of the last day leads …
		expect(profile.recentBets[0]).toMatchObject({ underlying: 'sensex', settledOn: '2026-08-23' });
		// … and day 0's FIRST bet is the single one that fell off the end; its other
		// two are the oldest survivors.
		expect(profile.recentBets.at(-1)).toMatchObject({
			underlying: 'banknifty',
			settledOn: '2026-08-17'
		});
		expect(
			profile.recentBets.some((bet) => bet.settledOn === '2026-08-17' && bet.underlying === 'nifty')
		).toBe(false);
	});
});
