/**
 * GET /api/cas/days — route-level test: the history dropdown\'s option list is
 * the distinct `cas_ticks` dates, newest first, bounded. The driver logic is
 * unit-tested in `$lib/server/db`; here the HTTP contract is pinned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './+server';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { istAt, WEDNESDAY } from '$lib/server/cas/test-clock';
import type { CasTickRow } from '$lib/server/db/types';

const DAY = WEDNESDAY;
type HandlerEvent = Parameters<typeof GET>[0];
const event = (): HandlerEvent => ({}) as unknown as HandlerEvent;
const DATABASE_URL = process.env.DATABASE_URL;

const row = (tradeDate: string, ts: number, underlying = 'nifty' as const): CasTickRow => ({
	tradeDate,
	underlying,
	ts,
	value: 25000,
	changePts: 0,
	changePct: 0
});

beforeEach(() => {
	delete process.env.DATABASE_URL;
	resetStoreForTests();
});

afterEach(() => {
	if (DATABASE_URL === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = DATABASE_URL;
	resetStoreForTests();
});

describe('GET /api/cas/days', () => {
	it('serves the tick-bearing days newest first with a short public cache', async () => {
		const store = getStore();
		await store.ticks.insertCasTicks([
			row('2026-08-25', istAt('2026-08-25', 15, 20, 0)),
			row(DAY, istAt(DAY, 15, 20, 0)),
			row('2026-08-28', istAt('2026-08-28', 15, 20, 0))
		]);

		const response = await GET(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=60');
		expect(await response.json()).toEqual({ days: ['2026-08-28', DAY, '2026-08-25'] });
	});

	it('serves an empty list when no ticks have ever been archived', async () => {
		const response = await GET(event());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ days: [] });
	});
});
