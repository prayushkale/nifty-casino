/**
 * The crowd-consensus slice of `/api/state` (see `$lib/game/crowd`).
 *
 * These cases pin the two contract points a live screen depends on: the
 * aggregate is present for EVERY reader (anonymous included — it is counts
 * only, no identity) and the `(tradeDate, totalBets)` cache never serves a
 * stale distribution after a new bet moves the pot counter.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './db/memory';
import type { GameStore } from './db/interface';
import { buildStatePayload, resetCrowdCache } from './state';

const DATE = '2026-08-27';
const CUTOFF = Date.parse('2026-08-27T09:50:00.000Z'); // 15:20:00 IST
const NOW = Date.parse('2026-08-27T06:00:00.000Z'); // 11:30 IST — window open

async function seededStore(): Promise<GameStore> {
	const store = new MemoryStore({ now: () => NOW });
	await store.profiles.insertProfile({
		userId: 'u1',
		handle: 'priya',
		email: 'p@x.dev',
		balance: 1000
	});
	await store.profiles.insertProfile({
		userId: 'u2',
		handle: 'rahul',
		email: 'r@x.dev',
		balance: 1000
	});
	await store.sessions.ensureSession(DATE, CUTOFF);
	await store.closes.upsertIndexClose({
		tradeDate: DATE,
		underlying: 'nifty',
		close: 25000,
		source: 'official'
	});
	return store;
}

beforeEach(() => resetCrowdCache());

describe('buildStatePayload — crowd distribution', () => {
	it('carries an empty crowd record on a day with no bets', async () => {
		const store = await seededStore();
		const payload = await buildStatePayload({ store, now: new Date(NOW), live: false });
		expect(payload.crowd).toEqual({});
	});

	it('aggregates every reader’s bets per strike, anonymous included', async () => {
		const store = await seededStore();
		const session = (await store.sessions.getSessionByDate(DATE))!;
		// Three picks: two players on the same nifty strike, one elsewhere.
		await store.bets.upsertBet({
			id: 'b1',
			userId: 'u1',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 10
		});
		await store.bets.upsertBet({
			id: 'b2',
			userId: 'u2',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 100
		});
		await store.bets.upsertBet({
			id: 'b3',
			userId: 'u1',
			sessionId: session.id,
			underlying: 'banknifty',
			targetKind: 'down',
			deltaPoints: 200,
			odds: 28,
			stake: 50
		});
		// Mirror the pot delta the money path would have applied — the cache keys on it.
		await store.pots.applyPotDelta(DATE, { totalBets: 3, playersCount: 2, totalStaked: 160 });

		const payload = await buildStatePayload({ store, now: new Date(NOW), live: false });
		expect(payload.crowd.nifty).toEqual([
			{ targetKind: 'up', deltaPoints: 50, count: 2, pct: 100 }
		]);
		expect(payload.crowd.banknifty).toEqual([
			{ targetKind: 'down', deltaPoints: 200, count: 1, pct: 100 }
		]);
	});

	it('recomputes when the pot counter moves — never serves a stale distribution', async () => {
		const store = await seededStore();
		const session = (await store.sessions.getSessionByDate(DATE))!;
		await store.bets.upsertBet({
			id: 'b1',
			userId: 'u1',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 100
		});
		await store.pots.applyPotDelta(DATE, { totalBets: 1, playersCount: 1, totalStaked: 100 });

		await buildStatePayload({ store, now: new Date(NOW), live: false });

		await store.bets.upsertBet({
			id: 'b2',
			userId: 'u2',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'down',
			deltaPoints: 100,
			odds: 28,
			stake: 100
		});
		await store.pots.applyPotDelta(DATE, { totalBets: 1, playersCount: 1, totalStaked: 100 });

		const payload = await buildStatePayload({ store, now: new Date(NOW), live: false });
		expect(payload.crowd.nifty).toHaveLength(2);
		expect(payload.crowd.nifty[0].pct).toBe(50);
	});

	it('serves the cached distribution when nothing changed', async () => {
		const store = await seededStore();
		const session = (await store.sessions.getSessionByDate(DATE))!;
		await store.bets.upsertBet({
			id: 'b1',
			userId: 'u1',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 28,
			stake: 100
		});
		await store.pots.applyPotDelta(DATE, { totalBets: 1, playersCount: 1, totalStaked: 100 });

		const first = await buildStatePayload({ store, now: new Date(NOW), live: false });

		// Mutate the table WITHOUT touching the pot counter (a settled-day edit,
		// say) — the cached payload must still match the frozen snapshot.
		await store.bets.upsertBet({
			id: 'b2',
			userId: 'u2',
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 150,
			odds: 28,
			stake: 100
		});
		const second = await buildStatePayload({ store, now: new Date(NOW), live: false });
		expect(second.crowd).toEqual(first.crowd);
		expect(second.crowd.nifty).toHaveLength(1);
	});
});
