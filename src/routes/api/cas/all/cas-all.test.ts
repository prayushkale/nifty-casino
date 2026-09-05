/**
 * GET /api/cas/all — route-level tests.
 *
 * The handler is exercised directly with a minimal RequestEvent stub (no HTTP
 * server, no SvelteKit internals) against the real process stores. That is
 * cheap here because the route is public, reads no cookies and needs no auth
 * locals — the interesting logic (merge, cap, staleness) is unit-tested in
 * `$lib/server/cas-snapshot.test.ts`; these pin the HTTP contract T12 consumes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import { getCasStore, resetCasStoreForTests } from '$lib/server/cas-store';
import type { CasTickPayload, Underlying } from '$lib/server/cas/types';
import { getStore, resetStoreForTests } from '$lib/server/db';
import type { CasTickRow } from '$lib/server/db/types';
import { istAt, THURSDAY, WEDNESDAY } from '$lib/server/cas/test-clock';

const DAY = WEDNESDAY;
const NOW = istAt(DAY, 15, 20, 0);
const DATABASE_URL = process.env.DATABASE_URL;

type HandlerEvent = Parameters<typeof GET>[0];

const event = (search = ''): HandlerEvent =>
	({ url: new URL(`http://localhost:5173/api/cas/all${search}`) }) as unknown as HandlerEvent;

function payload(ts: number, value: number, underlying: Underlying = 'nifty'): CasTickPayload {
	return {
		underlying,
		value,
		changePts: 10,
		changePct: 0.04,
		prevClose: 24988,
		ts,
		upstreamTs: null,
		source: 'nse'
	};
}

async function seedArchive(rows: CasTickRow[]): Promise<void> {
	await getStore().ticks.insertCasTicks(rows);
}

beforeEach(() => {
	// These tests are about the HTTP contract, not the driver: force the memory
	// store so a developer's DATABASE_URL cannot turn them into an integration run.
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	resetCasStoreForTests();
	// The route reads the real clock for `serverNow`/trade date; pin it to the
	// fixed Wednesday so the fixtures (and the IST-day routing) are deterministic.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
	vi.useRealTimers();
	if (DATABASE_URL === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = DATABASE_URL;
	resetStoreForTests();
	resetCasStoreForTests();
});

describe('GET /api/cas/all', () => {
	it('serves the documented shape with no-store caching', async () => {
		// 8s before `serverNow`: fresh by the 12s staleness rule
		getCasStore().ingest([payload(istAt(DAY, 15, 19, 52), 25000)], new Date(NOW));

		const response = await GET(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.tradeDate).toBe(DAY);
		expect(body.serverNow).toBe(NOW);
		expect(body.bufferedFrom).toBe(istAt(DAY, 15, 19, 52));
		expect(body.stale).toBe(false);
		expect(body.truncated).toBe(false);
		expect(Object.keys(body.ticks as object)).toEqual(['nifty', 'banknifty', 'sensex']);
		expect((body.ticks as Record<string, unknown[]>).nifty).toEqual([
			{ ts: istAt(DAY, 15, 19, 52), value: 25000 }
		]);
		expect(body.latest).toEqual({
			nifty: {
				value: 25000,
				changePts: 10,
				changePct: 0.04,
				prevClose: 24988,
				ts: istAt(DAY, 15, 19, 52),
				upstreamTs: null,
				source: 'nse'
			}
		});
	});

	it('reports staleness from serverNow, not from the client clock', async () => {
		getCasStore().ingest([payload(istAt(DAY, 15, 14), 25000)], new Date(NOW));
		const body = (await (await GET(event())).json()) as { stale: boolean };
		// six minutes of silence mid-auction: the banner case
		expect(body.stale).toBe(true);
	});

	it('honours the since cursor across the RAM/DB boundary', async () => {
		// archive: 15:00:00–15:00:56 · RAM: the three newest polls
		await seedArchive(
			Array.from({ length: 15 }, (_, i) => ({
				tradeDate: DAY,
				underlying: 'nifty' as const,
				ts: istAt(DAY, 15, 0, i * 4),
				value: 24000 + i,
				changePts: 10,
				changePct: 0.04
			}))
		);
		const hot = getCasStore();
		hot.ingest(
			[
				payload(istAt(DAY, 15, 14), 25000),
				payload(istAt(DAY, 15, 14, 4), 25002),
				payload(istAt(DAY, 15, 14, 8), 25004)
			],
			new Date(NOW)
		);

		const full = await GET(event(`?since=${istAt(DAY, 15, 0, 0)}`));
		const body = (await full.json()) as { ticks: { nifty: { ts: number; value: number }[] } };
		expect(body.ticks.nifty).toHaveLength(14 + 3);
		expect(body.ticks.nifty[0]?.value).toBe(24001);
		expect(body.ticks.nifty.at(-1)?.value).toBe(25004);
	});

	it('serves an empty snapshot cleanly before the auction has produced anything', async () => {
		const response = await GET(event());
		const body = (await response.json()) as { ticks: Record<string, unknown[]>; latest: unknown };
		expect(body.ticks).toEqual({ nifty: [], banknifty: [], sensex: [] });
		expect(body.latest).toEqual({});
	});

	it('replays a past day from the archive with ?date=', async () => {
		const yesterday = '2026-08-25';
		await seedArchive([
			{
				tradeDate: yesterday,
				underlying: 'sensex',
				ts: istAt(yesterday, 15, 30),
				value: 82110,
				changePts: 45,
				changePct: 0.05
			}
		]);
		await getStore().closes.upsertIndexClose({
			tradeDate: '2026-08-24',
			underlying: 'sensex',
			close: 82065,
			source: 'official'
		});

		const body = (await (await GET(event(`?date=${yesterday}`))).json()) as {
			tradeDate: string;
			bufferedFrom: number | null;
			stale: boolean;
			ticks: Record<string, { value: number }[]>;
			latest: Record<string, { prevClose: number | null; source: string }>;
		};
		expect(body.tradeDate).toBe(yesterday);
		expect(body.bufferedFrom).toBeNull();
		expect(body.stale).toBe(false);
		expect(body.ticks.sensex).toHaveLength(1);
		expect(body.latest.sensex?.prevClose).toBe(82065);
		expect(body.latest.sensex?.source).toBe('archive');
	});

	it('rejects a malformed ?date= with a 400 instead of a 500', async () => {
		await expect((await GET(event('?date=26-08-2026'))).status).toBe(400);
		await expect((await GET(event('?date=2026-02-30'))).status).toBe(400);
		const body = (await (await GET(event('?date=2026-02-30'))).json()) as { code: string };
		expect(body.code).toBe('INVALID_DATE');
	});

	it('never fetches upstream — no tick appears for a day the poller never polled', async () => {
		// THURSDAY rows in the archive must not leak into today's (WEDNESDAY) answer
		await seedArchive([
			{
				...{
					tradeDate: THURSDAY,
					underlying: 'nifty' as const,
					ts: istAt(THURSDAY, 15, 14),
					value: 1,
					changePts: 0,
					changePct: 0
				}
			}
		]);
		const body = (await (await GET(event(`?since=${istAt(DAY, 15, 0, 0)}`))).json()) as {
			ticks: Record<string, unknown[]>;
		};
		expect(body.ticks.nifty).toEqual([]);
	});
});
