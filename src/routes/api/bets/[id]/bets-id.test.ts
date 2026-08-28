/**
 * PATCH / DELETE /api/bets/[id] — the edit and cancel HTTP contract (PLAN §5 T7).
 *
 * Same approach as ../bets.test.ts: handler called directly, memory store, pinned
 * IST clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, PATCH } from './+server';
import { SIGNUP_BONUS } from '$lib/config/app';
import { invalidateLadderCache } from '$lib/server/ladder';
import { getStore, resetStoreForTests } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { istAt } from '$lib/server/cas/test-clock';

const WEDNESDAY = '2026-08-26';
const THURSDAY = '2026-08-27';
const SATURDAY = '2026-08-29';
const ME = '00000000-0000-4000-8000-00000000m001';
const OTHER = '00000000-0000-4000-8000-00000000o002';
const ANCHORS: Record<Underlying, number> = { nifty: 25_000, banknifty: 56_000, sensex: 82_000 };
/** The day's cutoff — 15:20:00 IST of THURSDAY. */
const CUTOFF = istAt(THURSDAY, 15, 20, 0);

type HandlerEvent = Parameters<typeof PATCH>[0];

const event = (
	method: 'PATCH' | 'DELETE',
	id: string,
	body?: unknown,
	userId: string | null = ME
): HandlerEvent =>
	({
		locals: { userId, handle: 'priya', authSource: 'dev' },
		params: { id },
		request: new Request(`http://localhost:5173/api/bets/${id}`, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	}) as unknown as HandlerEvent;

let betId: string;

beforeEach(async () => {
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
	for (const userId of [ME, OTHER]) {
		await store.profiles.insertProfile({
			userId,
			handle: userId === ME ? 'priya' : 'arjun',
			email: `${userId}@x.dev`,
			balance: SIGNUP_BONUS
		});
	}

	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(istAt(THURSDAY, 15, 5, 0)));

	// The service creates the day's session; the driver-level setup here must too.
	await store.sessions.ensureSession(THURSDAY, CUTOFF);
	betId = (
		await store.placeBet({
			userId: ME,
			tradeDate: THURSDAY,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake: 100,
			cutoffAtMs: CUTOFF,
			nowMs: istAt(THURSDAY, 15, 5, 0)
		})
	).id;
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	invalidateLadderCache();
});

const patch = async (body: unknown, id = betId, userId?: string | null) => {
	const response = await PATCH(event('PATCH', id, body, userId));
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const del = async (id = betId, userId?: string | null) => {
	const response = await DELETE(event('DELETE', id, undefined, userId));
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('PATCH /api/bets/[id]', () => {
	it('is 401 without a resolved user', async () => {
		expect(await patch({ stake: 50 }, betId, null)).toMatchObject({
			status: 401,
			body: { error: 'UNAUTHENTICATED' }
		});
	});

	it('returns 200 with the rewritten bet, refunding the difference', async () => {
		const { status, body } = await patch({ stake: 50 });
		expect(status).toBe(200);
		expect(body.bet).toMatchObject({ id: betId, stake: 50, odds: 6 });

		const pot = await getStore().pots.getDailyPot(THURSDAY);
		expect(pot).toMatchObject({ totalBets: 1, totalStaked: 50, playersCount: 1 });
		expect((await getStore().profiles.getProfile(ME))?.balance).toBe(SIGNUP_BONUS - 50);
	});

	it('re-prices the odds from the ladder when the target moves', async () => {
		const { body } = await patch({ targetKind: 'down', deltaPoints: 200 });
		expect(body.bet).toMatchObject({ targetKind: 'down', deltaPoints: 200, odds: 3.2 });
	});

	it('maps a foreign bet, a bad target and a bad stake to typed codes', async () => {
		expect(await patch({ stake: 50 }, betId, OTHER)).toMatchObject({
			status: 404,
			body: { error: 'BET_NOT_FOUND' }
		});
		expect(await patch({ deltaPoints: 75 })).toMatchObject({
			status: 400,
			body: { error: 'INVALID_TARGET' }
		});
		expect(await patch({ stake: 1 })).toMatchObject({
			status: 400,
			body: { error: 'INVALID_STAKE' }
		});
		expect(await patch('nope')).toMatchObject({
			status: 400,
			body: { error: 'VALIDATION_FAILED' }
		});
	});

	it('refuses an edit past the cutoff', async () => {
		vi.setSystemTime(new Date(istAt(THURSDAY, 15, 20, 1)));
		expect(await patch({ stake: 50 })).toMatchObject({
			status: 409,
			body: { error: 'CUTOFF_PASSED' }
		});
	});
});

describe('DELETE /api/bets/[id]', () => {
	it('is 401 without a resolved user', async () => {
		expect(await del(betId, null)).toMatchObject({
			status: 401,
			body: { error: 'UNAUTHENTICATED' }
		});
	});

	it('returns 200 { refunded } and frees the slot', async () => {
		const { status, body } = await del();
		expect(status).toBe(200);
		expect(body).toEqual({ refunded: 100 });
		expect(await getStore().bets.getBetById(betId)).toBeNull();

		// The slot is free again: a fresh bet on the same index is accepted.
		const store = getStore();
		const again = await store.placeBet({
			userId: ME,
			tradeDate: THURSDAY,
			underlying: 'nifty',
			targetKind: 'down',
			deltaPoints: 100,
			odds: 4.5,
			stake: 40,
			cutoffAtMs: CUTOFF,
			nowMs: istAt(THURSDAY, 15, 10, 0)
		});
		expect(again.id).not.toBe(betId);
		expect((await store.pots.getDailyPot(THURSDAY))?.playersCount).toBe(1);
	});

	it('maps a second cancel and a foreign cancel to 404', async () => {
		expect(await del(betId, OTHER)).toMatchObject({
			status: 404,
			body: { error: 'BET_NOT_FOUND' }
		});
		await del();
		expect(await del()).toMatchObject({ status: 404, body: { error: 'BET_NOT_FOUND' } });
	});

	it('refuses a cancel past the cutoff', async () => {
		vi.setSystemTime(new Date(istAt(SATURDAY, 15, 20, 1)));
		expect(await del()).toMatchObject({ status: 409, body: { error: 'CUTOFF_PASSED' } });
	});
});
