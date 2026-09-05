/**
 * POST /api/bets — the HTTP contract T11 bets against.
 *
 * The handler is called directly with a minimal RequestEvent stub (same approach
 * as ./api/cas/all), against the memory store and a pinned clock: the route reads
 * `Date` itself (it owns the trade date and the cutoff), so the wall clock has to
 * be faked rather than injected here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import { SIGNUP_BONUS } from '$lib/config/app';
import { invalidateLadderCache } from '$lib/server/ladder';
import { getStore, resetStoreForTests } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { istAt } from '$lib/server/cas/test-clock';

// The route opts into the live LTP fallback; the mock pins it to the fixture
// closes so the strike distances (and the whole suite) stay deterministic and
// network-free.
vi.mock('$lib/server/ltp', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/ltp')>();
	const quote = (underlying: 'nifty' | 'banknifty' | 'sensex', value: number) => ({
		underlying,
		value,
		changePts: 0,
		changePct: 0,
		prevClose: value
	});
	return {
		...mod,
		fetchLiveLtp: async () => ({
			nifty: quote('nifty', 25_000),
			banknifty: quote('banknifty', 56_000),
			sensex: quote('sensex', 82_000)
		})
	};
});

const WEDNESDAY = '2026-08-26';
const THURSDAY = '2026-08-27';
const USER = '00000000-0000-4000-8000-00000000r001';
const ANCHORS: Record<Underlying, number> = { nifty: 25_000, banknifty: 56_000, sensex: 82_000 };

type HandlerEvent = Parameters<typeof POST>[0];

const event = (body: unknown, userId: string | null = USER): HandlerEvent =>
	({
		locals: { userId, handle: 'priya', authSource: 'dev' },
		request: new Request('http://localhost:5173/api/bets', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	}) as unknown as HandlerEvent;

beforeEach(async () => {
	// The route is driver-agnostic; force the memory one so a developer's
	// DATABASE_URL cannot turn these into an integration run.
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();

	const store = getStore();
	for (const [underlying, close] of Object.entries(ANCHORS)) {
		await store.closes.upsertIndexClose({
			tradeDate: WEDNESDAY,
			underlying: underlying as Underlying,
			close,
			source: 'official'
		});
	}
	await store.profiles.insertProfile({
		userId: USER,
		handle: 'priya',
		email: 'p@x.dev',
		balance: SIGNUP_BONUS
	});

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(istAt(THURSDAY, 15, 16, 0)));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();
});

const post = async (body: unknown, userId?: string | null) => {
	const response = await POST(event(body, userId));
	return {
		status: response.status,
		headers: response.headers,
		body: (await response.json()) as Record<string, unknown>
	};
};

describe('POST /api/bets', () => {
	it('is 401 without a resolved user, before the body is even read', async () => {
		const { status, body } = await post(nifty(), null);
		expect(status).toBe(401);
		expect(body).toEqual({ error: 'UNAUTHENTICATED' });
	});

	it('returns 201 with the bet and a no-store header', async () => {
		const { status, headers, body } = await post(nifty());
		expect(status).toBe(201);
		expect(headers.get('cache-control')).toBe('private, no-store');
		expect(body.bet).toMatchObject({
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 100
		});
	});

	it('never takes odds from the client — the ladder is the only price source', async () => {
		const { body } = await post({ ...nifty(), odds: 999 });
		expect((body.bet as Record<string, unknown>).odds).toBe(28);
	});

	it('maps a malformed body to 400 VALIDATION_FAILED', async () => {
		const { status, body } = await post('not json at all');
		expect(status).toBe(400);
		expect(body).toEqual({ error: 'VALIDATION_FAILED' });
	});

	it('maps field failures to the service codes', async () => {
		expect(await post(nifty({ stake: 5 }))).toMatchObject({
			status: 400,
			body: { error: 'INVALID_STAKE' }
		});
		expect(await post(nifty({ underlying: 'reliance' }))).toMatchObject({
			status: 400,
			body: { error: 'INVALID_UNDERLYING' }
		});
		expect(await post(nifty({ deltaPoints: 75 }))).toMatchObject({
			status: 400,
			body: { error: 'INVALID_TARGET' }
		});
	});

	it('maps the window, the market and the wallet to 409', async () => {
		vi.setSystemTime(new Date(istAt(THURSDAY, 15, 14, 59)));
		expect(await post(nifty())).toMatchObject({ status: 409, body: { error: 'WINDOW_NOT_OPEN' } });

		vi.setSystemTime(new Date(istAt(THURSDAY, 15, 20, 1)));
		expect(await post(nifty())).toMatchObject({ status: 409, body: { error: 'CUTOFF_PASSED' } });

		vi.setSystemTime(new Date(istAt('2026-08-29', 15, 18, 0))); // Saturday
		expect(await post(nifty())).toMatchObject({ status: 409, body: { error: 'MARKET_CLOSED' } });

		// Back inside the window, a stake the wallet cannot cover is still 409.
		vi.setSystemTime(new Date(istAt(THURSDAY, 15, 16, 0)));
		expect(await post(nifty({ stake: SIGNUP_BONUS + 1 }))).toMatchObject({
			status: 409,
			body: { error: 'INSUFFICIENT_BALANCE', required: SIGNUP_BONUS + 1, available: SIGNUP_BONUS }
		});
	});

	it('answers a double submit with 409 BET_EXISTS and the first bet id', async () => {
		const first = await post(nifty());
		const again = await post(nifty({ stake: 50 }));
		expect(again.status).toBe(409);
		expect(again.body).toMatchObject({
			error: 'BET_EXISTS',
			betId: (first.body.bet as Record<string, unknown>).id
		});
	});
});

function nifty(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { underlying: 'nifty', targetKind: 'up', deltaPoints: 50, stake: 100, ...over };
}
