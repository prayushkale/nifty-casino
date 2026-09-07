/**
 * GET /api/state — the HTTP contract T11 builds the whole game page on.
 *
 * Same approach as ./api/cas/all and ./api/bets: the handler is called directly
 * with a minimal RequestEvent stub (only `locals` matters here — the auth hooks
 * are what the route reads) against the memory store and a pinned clock. The
 * clock is faked rather than injected because the route owns the trade date and
 * every window flag.
 *
 * The privacy tests are deliberately paranoid: they string-search the WHOLE
 * serialized payload, not the fields a reader thinks are in it, so a field added
 * to the payload later fails here unless it is genuinely public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { SIGNUP_BONUS } from '$lib/config/app';
import { placeBet } from '$lib/server/bets';
import { invalidateLadderCache } from '$lib/server/ladder';
import { getStore, resetStoreForTests } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { istAt, THURSDAY, WEDNESDAY } from '$lib/server/cas/test-clock';
import type { StatePayload } from '$lib/server/state';

// The ladder's live previous-close fallback must stay out of this suite: the
// route enables it by default, and the empty-DB test would otherwise spend the
// NSE/BSE timeouts on the real network. Nulls preserve the DB-only ladder
// every assertion below was written against.
vi.mock('$lib/server/live-closes', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/live-closes')>();
	return {
		...mod,
		fetchLivePrevCloses: async () => ({ nifty: null, banknifty: null, sensex: null })
	};
});

const DAY = THURSDAY;
const USER = '11111111-1111-4111-8111-111111111111';
const HANDLE = 'priya';
const EMAIL = 'priya@example.com';
const ANCHORS: Record<Underlying, number> = { nifty: 25_000, banknifty: 56_000, sensex: 82_000 };
const CUTOFF = istAt(DAY, 15, 20, 0);

type HandlerEvent = Parameters<typeof GET>[0];

const event = (userId: string | null = USER): HandlerEvent =>
	({
		locals: {
			userId,
			handle: userId === null ? null : HANDLE,
			authSource: userId === null ? null : 'dev'
		}
	}) as unknown as HandlerEvent;

const get = async (userId: string | null = USER): Promise<Response> => GET(event(userId));

/** Every key in the payload, however deeply nested — what a client could learn exists. */
function collectKeys(value: unknown, into: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectKeys(item, into);
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			into.push(key);
			collectKeys(item, into);
		}
	}
	return into;
}

beforeEach(async () => {
	// Driver-agnostic route: force the memory store so a developer's DATABASE_URL
	// cannot turn these into an integration run.
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();

	const store = getStore();
	// Yesterday's official closes are what today's ladder hangs off…
	for (const [underlying, close] of Object.entries(ANCHORS)) {
		await store.closes.upsertIndexClose({
			tradeDate: WEDNESDAY,
			underlying: underlying as Underlying,
			close,
			source: 'official'
		});
		// …and today's 15:15:01 LTP anchor is what it hangs off in-window. Seeding it
		// keeps the wrapper from attempting a REAL feed fetch on the fake clock — the
		// anchor row is exactly what the poller would have written by 15:19.
		await store.closes.upsertIndexLtpAnchor({
			tradeDate: DAY,
			underlying: underlying as Underlying,
			close
		});
	}
	await store.profiles.insertProfile({
		userId: USER,
		handle: HANDLE,
		email: EMAIL,
		balance: SIGNUP_BONUS
	});
	await store.sessions.ensureSession(DAY, CUTOFF);

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(istAt(DAY, 15, 19, 0)));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();
});

/** Two of today's bets, the older one already settled as a HIT on nifty ±50. */
async function seedTwoBets(): Promise<void> {
	vi.setSystemTime(new Date(istAt(DAY, 15, 16, 0)));
	const older = await placeBet(USER, {
		underlying: 'nifty',
		targetKind: 'up',
		deltaPoints: 50,
		stake: 100
	});
	vi.setSystemTime(new Date(istAt(DAY, 15, 17, 0)));
	await placeBet(USER, {
		underlying: 'sensex',
		targetKind: 'down',
		// 81,800 PE: a real PE distance off the 82,000 anchor — the strikes are
		// round 100-multiples, so every distance is a 100.
		deltaPoints: 200,
		stake: 300
	});

	const session = await getStore().sessions.getSessionByDate(DAY);
	await getStore().settleBets({
		sessionId: session?.id ?? 0,
		tradeDate: DAY,
		outcomes: [{ betId: older.id, userId: USER, stake: 100, odds: 28, tier: 'hit', payout: 2800 }],
		settledAtMs: istAt(DAY, 15, 45, 0)
	});
}

describe('GET /api/state (anonymous)', () => {
	it('serves the documented shape with the session, pot and ladder and no user', async () => {
		const response = await get(null);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');

		const body = (await response.json()) as StatePayload;
		expect(body.serverNow).toBe(istAt(DAY, 15, 19, 0));
		expect(body.tradeDate).toBe(DAY);
		expect(body.user).toBeNull();
		expect(body.myBets).toEqual([]);

		// The participation window (15:15–15:20) sits entirely inside the auction
		// window (15:13:30–15:42), so both flags read true together in-window.
		expect(body.session).toEqual({
			exists: true,
			status: 'open',
			cutoffAtMs: CUTOFF,
			bettingWindowOpen: true,
			auctionLive: true,
			settled: false
		});

		// Nobody has bet yet, so the pot is the zero shape and yesterday is absent.
		expect(body.pot.today).toEqual({
			tradeDate: DAY,
			totalBets: 0,
			totalStaked: 0,
			totalPaidOut: 0,
			playersCount: 0,
			updatedAt: 0
		});
		expect(body.pot.yesterday).toBeNull();

		// The ladder is the whole reason the page can render before anything happens.
		expect(body.ladder.tradeDate).toBe(DAY);
		expect(body.ladder.anchors).toEqual(ANCHORS);
		expect(body.ladder.options).toHaveLength(110);
	});

	it('creates nothing: a day nobody has touched reads as a missing session, not a new row', async () => {
		// A session row only exists because seeding put one there; ask about a day
		// with nothing in it by rewinding to a date with no session.
		resetStoreForTests();
		invalidateLadderCache();

		const body = (await (await get(null)).json()) as StatePayload;
		expect(body.session.exists).toBe(false);
		expect(body.session.status).toBeNull();
		expect(body.session.cutoffAtMs).toBeNull();
		expect(body.session.settled).toBe(false);
		expect(await getStore().sessions.getSessionByDate(DAY)).toBeNull();
	});
});

describe('GET /api/state (signed in)', () => {
	it('rebuilds the whole screen in one payload: user, bets, pot and ladder', async () => {
		await seedTwoBets();

		const body = (await (await get()).json()) as StatePayload;

		// 1000 − 100 − 300 staked, +2800 paid back to an exact HIT.
		expect(body.user).toMatchObject({
			handle: HANDLE,
			balance: SIGNUP_BONUS - 400 + 2800,
			xp: 0,
			streakDays: 0,
			lastBetDate: null,
			authSource: 'dev'
		});
		expect(body.user?.stats).toEqual({
			betsPlaced: 2,
			betsWon: 1,
			totalStaked: 400,
			totalWon: 2800,
			bestPayout: 2800
		});

		// Newest first, and only the fields the strip renders.
		expect(body.myBets).toHaveLength(2);
		expect(body.myBets[0]).toMatchObject({
			underlying: 'sensex',
			targetKind: 'down',
			deltaPoints: 200,
			odds: 28,
			stake: 300,
			settlementTier: null,
			payout: null
		});
		expect(body.myBets[1]).toMatchObject({
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 100,
			settlementTier: 'hit',
			payout: 2800
		});

		// The pot moved with the bets: two, 400 staked, 2800 paid out, one player.
		expect(body.pot.today).toMatchObject({
			tradeDate: DAY,
			totalBets: 2,
			totalStaked: 400,
			totalPaidOut: 2800,
			playersCount: 1
		});
	});

	it('a user whose profile has vanished reads as signed out, not as a 500', async () => {
		const body = (await (await get('00000000-0000-4000-8000-000000000000')).json()) as StatePayload;
		expect(body.user).toBeNull();
		expect(body.myBets).toEqual([]);
		// The room is still there — only the wallet is missing.
		expect(body.session.exists).toBe(true);
	});
});

describe('GET /api/state — time flags from one captured instant', () => {
	const at = async (h: number, m: number, s = 0): Promise<{ open: boolean; live: boolean }> => {
		vi.setSystemTime(new Date(istAt(DAY, h, m, s)));
		const body = (await (await get(null)).json()) as StatePayload;
		expect(body.serverNow).toBe(istAt(DAY, h, m, s));
		return { open: body.session.bettingWindowOpen, live: body.session.auctionLive };
	};

	it.each([
		['15:14:59 (one second early)', 15, 14, 59, false],
		['15:15:00 (inclusive start)', 15, 15, 0, true],
		['15:20:00 (inclusive cutoff)', 15, 20, 0, true],
		['15:20:01 (one second late)', 15, 20, 1, false]
	])('bettingWindowOpen at %s → %s', async (_label, h, m, s, expected) => {
		expect((await at(h, m, s)).open).toBe(expected);
	});

	it.each([
		['15:13:29 (one second early)', 15, 13, 29, false],
		['15:13:30 (inclusive start)', 15, 13, 30, true],
		['15:42:00 (inclusive end)', 15, 42, 0, true],
		['15:42:01 (one second late)', 15, 42, 1, false]
	])('auctionLive at %s → %s', async (_label, h, m, s, expected) => {
		expect((await at(h, m, s)).live).toBe(expected);
	});

	it('both windows can be live at once — betting runs through the first minutes of the auction', async () => {
		const flags = await at(15, 15, 0);
		expect(flags).toEqual({ open: true, live: true });
	});

	it('reports a settled session as settled', async () => {
		const session = await getStore().sessions.getSessionByDate(DAY);
		await getStore().sessions.setSessionStatus(session?.id ?? 0, 'settled');

		const body = (await (await get(null)).json()) as StatePayload;
		expect(body.session.settled).toBe(true);
		expect(body.session.status).toBe('settled');
		// Settled does not mean the windows moved.
		expect(body.session.bettingWindowOpen).toBe(true);
	});
});

describe('GET /api/state — privacy', () => {
	it('never carries an email, a user id or session bookkeeping anywhere in the payload', async () => {
		await seedTwoBets();

		const response = await get();
		const body = (await response.json()) as StatePayload;
		const text = JSON.stringify(body).toLowerCase();

		// String search, not a field check: a new field leaks the same way an old one would.
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain('priya@'); // the handle is public, the address is not
		expect(text).not.toContain('example.com');
		expect(text).not.toContain(USER.toLowerCase());
		expect(text).not.toContain('email');
		expect(text).not.toContain('user_id');
		expect(text).not.toContain('userid');

		const keys = collectKeys(body).map((key) => key.toLowerCase());
		for (const forbidden of ['email', 'userid', 'user_id', 'sessionid', 'settledat', 'ledger']) {
			expect(keys).not.toContain(forbidden);
		}
	});

	it('leaks nothing extra when the request is anonymous', async () => {
		const body = (await (await get(null)).json()) as StatePayload;
		expect(JSON.stringify(body).toLowerCase()).not.toContain(USER.toLowerCase());
		expect(JSON.stringify(body).toLowerCase()).not.toContain(EMAIL);
	});
});
