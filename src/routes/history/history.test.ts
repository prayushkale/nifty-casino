/**
 * `/history` and `GET /api/history` — the own-bet log's two doors.
 *
 * The page is the auth boundary (an anonymous visitor is a redirect, never an
 * empty log); the endpoint is the auth boundary for "Load more" (401, never a
 * page of somebody else's bets). Everything between them is
 * `$lib/server/history`, so the tests here pin the HTTP contract: the redirect,
 * the 401, the cursor round-trip and the totals header.
 *
 * Like `/api/state`'s suite, the privacy assertions string-search the WHOLE
 * serialized payload rather than trusting a field list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getHistory } from '../api/history/+server';
import { load as loadPage } from './+page.server';
import { type HistoryPage } from '$lib/server/history';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { istAt, THURSDAY } from '$lib/server/cas/test-clock';
import { shiftIstDate } from '$lib/time/ist';

const DAY = THURSDAY;
const PREV = shiftIstDate(DAY, -1);
const NOW = istAt(DAY, 16, 0, 0);
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HANDLE = 'priya';
const EMAIL = 'priya@example.com';

type PageEvent = Parameters<typeof loadPage>[0];
type ApiEvent = Parameters<typeof getHistory>[0];

const pageEvent = (userId: string | null = USER): PageEvent =>
	({ locals: { userId, handle: userId === null ? null : HANDLE } }) as unknown as PageEvent;

const apiEvent = (query = '', userId: string | null = USER): ApiEvent =>
	({
		locals: { userId, handle: userId === null ? null : HANDLE },
		url: new URL(`http://localhost:5173/api/history${query}`)
	}) as unknown as ApiEvent;

/** A store with two players and a settled day, so the log has rows from one owner only. */
async function seedPlayers(): Promise<void> {
	const store = getStore();
	await store.sessions.ensureSession(DAY, istAt(DAY, 15, 20, 0));
	await store.sessions.ensureSession(PREV, istAt(PREV, 15, 20, 0));
	for (const [userId, handle] of [
		[USER, HANDLE],
		[OTHER, 'arjun']
	] as const) {
		await store.profiles.insertProfile({
			userId,
			handle,
			email: `${handle}@example.com`,
			balance: 1_000
		});
	}
}

/** Place and settle one bet, as the settlement engine would leave it. */
async function seedBet(input: {
	userId: string;
	underlying: 'nifty' | 'banknifty' | 'sensex';
	targetKind?: 'up' | 'down';
	deltaPoints?: number;
	stake?: number;
	odds?: number;
	tier?: 'hit' | 'flat' | 'miss' | null;
	payout?: number | null;
	day?: string;
}): Promise<void> {
	const store = getStore();
	const day = input.day ?? DAY;
	const session = await store.sessions.getSessionByDate(day);
	const bet = await store.bets.upsertBet({
		userId: input.userId,
		sessionId: session?.id ?? 0,
		underlying: input.underlying,
		targetKind: input.targetKind ?? 'up',
		deltaPoints: input.deltaPoints ?? 50,
		odds: input.odds ?? 6,
		stake: input.stake ?? 100
	});
	if (input.tier === undefined || input.tier === null) return;
	await store.bets.setBetOutcome(bet.id, input.tier, input.payout ?? 0, istAt(day, 15, 45));
}

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

describe('/history load', () => {
	it('redirects an anonymous visitor to the login form', async () => {
		try {
			await loadPage(pageEvent(null));
			throw new Error('expected the load to redirect');
		} catch (err: unknown) {
			const redirect = err as { status?: number; location?: string };
			expect(redirect.status).toBe(303);
			expect(redirect.location).toBe('/auth/login');
		}
	});

	it('serves the totals header and the first page for a signed-in player', async () => {
		await seedPlayers();
		await seedBet({ userId: USER, underlying: 'nifty', tier: 'hit', payout: 600 });
		await seedBet({
			userId: USER,
			underlying: 'sensex',
			targetKind: 'down',
			deltaPoints: 250,
			odds: 4.5,
			stake: 200,
			tier: 'miss',
			payout: 0
		});
		await seedBet({ userId: OTHER, underlying: 'nifty', tier: 'hit', payout: 600 });
		// The counters bet placement and settlement write transactionally (T7/T9).
		// Seeded directly because this test drives the store, not the bet service.
		await getStore().stats.applyStatsDelta(USER, {
			betsPlaced: 2,
			betsWon: 1,
			totalStaked: 300,
			totalWon: 600,
			bestPayout: 600
		});

		const payload = (await loadPage(pageEvent())) as {
			totals: Record<string, unknown>;
			page: HistoryPage;
		};

		// The header is the projection of that one row — never a SUM over bets.
		expect(payload.totals).toEqual({
			betsPlaced: 2,
			betsWon: 1,
			winRate: 0.5,
			totalStaked: 300,
			totalWon: 600,
			bestPayout: 600
		});
		expect(payload.page.hasMore).toBe(false);
		expect(payload.page.nextCursor).toBeNull();

		// Only this player's rows, newest first, and a live bet stays live.
		expect(payload.page.bets.map((bet) => bet.underlying)).toEqual(['sensex', 'nifty']);
		expect(payload.page.bets[0]).toEqual({
			id: expect.any(String),
			underlying: 'sensex',
			targetKind: 'down',
			deltaPoints: 250,
			odds: 4.5,
			stake: 200,
			settlementTier: 'miss',
			payout: 0,
			createdAt: expect.any(Number),
			settledAt: istAt(DAY, 15, 45)
		});
	});

	it('carries no email, no user id and no session bookkeeping in the payload', async () => {
		await seedPlayers();
		await seedBet({ userId: USER, underlying: 'nifty', tier: 'hit', payout: 600 });

		const text = JSON.stringify(await loadPage(pageEvent())).toLowerCase();
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain('priya@');
		expect(text).not.toContain('example.com');
		expect(text).not.toContain(USER);
		expect(text).not.toContain(OTHER);
		expect(text).not.toContain('email');
		expect(text).not.toContain('user_id');
		expect(text).not.toContain('userid');
		expect(text).not.toContain('sessionid');
	});

	it('renders an empty log and zeroed totals for a player who has never bet', async () => {
		await seedPlayers();

		const payload = (await loadPage(pageEvent())) as {
			totals: Record<string, unknown>;
			page: HistoryPage;
		};
		expect(payload.totals).toEqual({
			betsPlaced: 0,
			betsWon: 0,
			winRate: null,
			totalStaked: 0,
			totalWon: 0,
			bestPayout: 0
		});
		expect(payload.page.bets).toEqual([]);
		expect(payload.page.hasMore).toBe(false);
	});
});

describe('GET /api/history', () => {
	it('answers 401 for an anonymous caller instead of a page', async () => {
		const response = await getHistory(apiEvent('', null));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'UNAUTHENTICATED' });
	});

	it('serves one page with private, no-store caching', async () => {
		await seedPlayers();
		await seedBet({ userId: USER, underlying: 'nifty', tier: 'hit', payout: 600 });

		const response = await getHistory(apiEvent());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');

		const page = (await response.json()) as HistoryPage;
		expect(page.bets).toHaveLength(1);
		expect(page.bets[0]).toMatchObject({ underlying: 'nifty', settlementTier: 'hit' });
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it('rejects a cursor that cannot be parsed with a 400, not with the whole table', async () => {
		await seedPlayers();
		await expect((await getHistory(apiEvent('?before=yesterday'))).status).toBe(400);
		await expect((await getHistory(apiEvent('?before='))).status).toBe(400);
		const body = (await (await getHistory(apiEvent('?before=not-a-date'))).json()) as {
			error: string;
		};
		expect(body.error).toBe('INVALID_CURSOR');
	});

	it('round-trips the cursor: page two holds exactly the rows page one left out', async () => {
		await seedPlayers();
		// Three bets, placed in order (three indices is the per-player per-day ceiling).
		for (const underlying of ['nifty', 'banknifty', 'sensex'] as const) {
			await seedBet({ userId: USER, underlying, tier: 'hit', payout: 600 });
		}

		const first = (await (await getHistory(apiEvent(''))).json()) as HistoryPage;
		expect(first.bets.map((bet) => bet.underlying)).toEqual(['sensex', 'banknifty', 'nifty']);
		expect(first.hasMore).toBe(false); // six rows would be needed for a second page

		// Walk anyway, from the cursor the middle row defines: what comes back is
		// exactly the older half, and nothing is repeated.
		const middle = first.bets[1];
		const cursor = `?before=${new Date(middle.createdAt).toISOString()}&beforeId=${middle.id}`;
		const second = (await (await getHistory(apiEvent(cursor))).json()) as HistoryPage;
		expect(second.bets.map((bet) => bet.underlying)).toEqual(['nifty']);
		expect(new Set([...first.bets, ...second.bets].map((bet) => bet.id)).size).toBe(3);
	});

	it('accepts a cursor with the instant alone (no id) — the timestamp still bounds it', async () => {
		await seedPlayers();
		await seedBet({ userId: USER, underlying: 'nifty', tier: 'hit', payout: 600 });

		const first = (await (await getHistory(apiEvent(''))).json()) as HistoryPage;
		const only = first.bets[0];
		const second = (await (
			await getHistory(apiEvent(`?before=${new Date(only.createdAt).toISOString()}`))
		).json()) as HistoryPage;
		expect(second.bets).toEqual([]);
	});

	it('returns an empty page for a cursor older than every row', async () => {
		await seedPlayers();
		await seedBet({ userId: USER, underlying: 'nifty', tier: 'hit', payout: 600 });

		const page = (await (
			await getHistory(apiEvent(`?before=${new Date(0).toISOString()}`))
		).json()) as HistoryPage;
		expect(page.bets).toEqual([]);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
	});

	it("never serves one player another player's rows", async () => {
		await seedPlayers();
		await seedBet({ userId: OTHER, underlying: 'nifty', tier: 'hit', payout: 600 });

		const page = (await (await getHistory(apiEvent(''))).json()) as HistoryPage;
		expect(page.bets).toEqual([]);
	});
});
