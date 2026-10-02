/**
 * LocalMemoryStore — the desktop build's durable driver.
 *
 * The headline behaviour is restart survival: a player's balance, ledger and history must
 * come back after the process that held them is gone. Everything else here protects that
 * guarantee from the failure modes a file introduces — corrupt payloads, unknown versions,
 * unbounded tick growth, and torn writes.
 *
 * Uses the real OS filesystem (a temp dir per test) rather than a mock, because atomicity is
 * exactly the property under test and a mock cannot demonstrate it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	LocalMemoryStore,
	READ_METHODS,
	SNAPSHOT_VERSION,
	TICK_RETENTION_DAYS,
	trimTicks,
	WRITE_METHODS
} from './local-persistence';
import { MemoryStore, type MemorySnapshot } from './memory';
import type { TxStore } from './interface';

const DATE = '2026-08-27';
const CUTOFF = Date.parse('2026-08-27T09:50:00.000Z'); // 15:20:00 IST
const USER = 'u1';

let dir: string;
let file: string;

/** Debounce 0 keeps the tests synchronous-feeling without fake timers. */
function store(): LocalMemoryStore {
	return new LocalMemoryStore({ file, flushDebounceMs: 0 });
}

/** Give a wallet 1,000 NC and open today's session — the desktop signup shape. */
async function seedWallet(s: LocalMemoryStore, balance = 1000): Promise<void> {
	await s.profiles.insertProfile({
		userId: USER,
		handle: 'priya',
		email: 'p@x.dev',
		balance
	});
	await s.sessions.ensureSession(DATE, CUTOFF);
}

async function placeStake(s: LocalMemoryStore, stake: number): Promise<string> {
	return s.tx(async (t) => {
		const session = await t.sessions.ensureSession(DATE, CUTOFF);
		const bet = await t.bets.upsertBet({
			userId: USER,
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake
		});
		return bet.id;
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'nc-local-store-'));
	// `nested/` so the store's mkdir-on-first-write is exercised by every test.
	file = join(dir, 'nested', 'niftycasino.json');
	mkdirSync(join(dir, 'nested'), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('LocalMemoryStore', () => {
	// ------------------------------------------------------------- restart survival

	it('keeps the wallet, ledger and history across a restart', async () => {
		const first = store();
		await seedWallet(first);

		// Spend through the real money path so balance, ledger and stats all move together.
		const betId = await first.tx(async (t) => {
			const session = await t.sessions.ensureSession(DATE, CUTOFF);
			await t.profiles.applyBalanceDelta(USER, -100);
			await t.ledger.appendLedger({
				userId: USER,
				kind: 'bet_stake',
				amount: -100,
				refBetId: 'b1',
				balanceAfter: 900
			});
			return t.bets.upsertBet({
				userId: USER,
				sessionId: session.id,
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 100
			});
		});
		expect((await first.profiles.getProfile(USER))?.balance).toBe(900);
		await first.flush();

		// A brand-new process reading the same file.
		const second = store();
		const profile = await second.profiles.getProfile(USER);

		expect(profile?.balance).toBe(900);
		expect(profile?.handle).toBe('priya');
		expect((await second.ledger.getLedgerForUser(USER)).length).toBe(1);
		expect(await second.bets.getBetById(betId.id)).not.toBeNull();
		expect((await second.sessions.getSessionByDate(DATE))?.status).toBe('open');
	});

	it('resolves a restored profile by handle — the dev-auth login path', async () => {
		const first = store();
		await seedWallet(first);
		await first.flush();

		// getProfileByHandle is what POST /api/auth/signup uses to log a player back in.
		const second = store();
		expect((await second.profiles.getProfileByHandle('priya'))?.userId).toBe(USER);
	});

	it('continues the id sequences instead of replaying ids after a restart', async () => {
		const first = store();
		await seedWallet(first);
		await placeStake(first, 100);
		await first.flush();

		const second = store();
		const next = await second.sessions.ensureSession('2026-08-28', CUTOFF);
		expect(next.id).toBe(2); // not 1 again — a reused id would collide on re-settle
	});

	it('is empty on first run without creating a file until something is written', async () => {
		const fresh = store();
		expect(await fresh.profiles.getProfile(USER)).toBeNull();
		expect(() => readFileSync(file)).toThrow(); // nothing written yet

		await seedWallet(fresh);
		await fresh.flush();
		expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(SNAPSHOT_VERSION);
	});

	it('creates missing parent directories on first write', async () => {
		// Deeper than the shared fixture, so mkdirSync really has work to do.
		const deep = join(dir, 'a', 'b', 'c', 'niftycasino.json');
		const s = new LocalMemoryStore({ file: deep, flushDebounceMs: 0 });
		await seedWallet(s);
		await s.flush();
		expect(JSON.parse(readFileSync(deep, 'utf8')).store.profiles).toHaveLength(1);
	});

	// ------------------------------------------------------------ corrupt / unknown

	it('starts empty rather than throwing when the file is not valid JSON', async () => {
		writeFileSync(file, '{ this is not json');
		const s = store();
		expect(await s.profiles.getProfile(USER)).toBeNull();
	});

	it('starts empty when the file was written by a newer build', async () => {
		writeFileSync(file, JSON.stringify({ v: SNAPSHOT_VERSION + 1, savedAt: 0, store: {} }));
		const s = store();
		expect(await s.profiles.getProfile(USER)).toBeNull();
	});

	it('starts empty when the file is a valid JSON document of the wrong shape', async () => {
		writeFileSync(file, JSON.stringify({ hello: 'world' }));
		const s = store();
		expect(await s.profiles.getProfile(USER)).toBeNull();
	});

	it('recovers on the next write after a corrupt read — a bad file is not a dead app', async () => {
		writeFileSync(file, 'not json at all');
		const s = store();
		await seedWallet(s);
		await s.flush();

		const recovered = store();
		expect((await recovered.profiles.getProfile(USER))?.balance).toBe(1000);
	});

	// ------------------------------------------------------------------ durability

	it('never leaves a partial file behind — the write goes through a temp + rename', async () => {
		const first = store();
		await seedWallet(first);
		await first.flush();

		// The temp file is cleaned up by the rename, so only the real payload remains.
		expect(() => readFileSync(`${file}.tmp`)).toThrow();
		const payload = JSON.parse(readFileSync(file, 'utf8'));
		expect(payload.store.profiles[0][1].handle).toBe('priya');
	});

	it('does not persist a transaction that rolled back', async () => {
		const s = store();
		await seedWallet(s);
		await s.flush();

		await expect(
			s.tx(async (t) => {
				await t.profiles.applyBalanceDelta(USER, -999);
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		await s.flush();

		// The failed tx must not have been written; the pre-failure balance stands.
		const recovered = store();
		expect((await recovered.profiles.getProfile(USER))?.balance).toBe(1000);
	});

	it('coalesces a burst of transactions into one write', async () => {
		const s = new LocalMemoryStore({ file, flushDebounceMs: 5 });
		await seedWallet(s);
		// Three write transactions landing inside one debounce window.
		await s.tx(async (t) => {
			await t.profiles.applyBalanceDelta(USER, -10);
		});
		await s.tx(async (t) => {
			await t.profiles.applyBalanceDelta(USER, -20);
		});
		await s.tx(async (t) => {
			await t.profiles.applyBalanceDelta(USER, -30);
		});
		await s.flush();

		// All three movements survive, and the file holds the final state, not the first.
		expect((await store().profiles.getProfile(USER))?.balance).toBe(940);
	});

	// ------------------------------------------------- writes outside a transaction

	it('persists a direct repo write that never went through tx()', async () => {
		// This is the CAS poller's shape (cas-poller.ts calls store.ticks.insertCasTicks
		// outside any transaction), and the reason the repositories are wrapped too.
		const s = store();
		await s.ticks.insertCasTicks([
			{ tradeDate: DATE, underlying: 'nifty', ts: CUTOFF, value: 25200, changePts: 5, changePct: 0 }
		]);
		await s.flush();

		const recovered = store();
		const ticks = await recovered.ticks.getCasTicksRange(DATE, 'nifty', 0, CUTOFF + 1, 10);
		expect(ticks).toHaveLength(1);
		expect(ticks[0].value).toBe(25200);
	});

	it('persists a directly-written wallet — the dev-auth signup path', async () => {
		// POST /api/auth/signup provisions through store.tx(), but applyProfileProgress
		// and friends are reachable directly; nothing may slip through unpersisted.
		const s = store();
		await s.profiles.insertProfile({
			userId: USER,
			handle: 'priya',
			email: 'p@x.dev',
			balance: 1000
		});
		await s.flush();

		expect((await store().profiles.getProfile(USER))?.balance).toBe(1000);
	});

	it('flushSync persists without awaiting — the process-exit path', async () => {
		// The desktop app relies on this: an abrupt quit (Task Manager, kill -9) never runs
		// adapter-node's graceful close, and an `exit` hook has no time left for a Promise.
		const s = store();
		s.flushSync(); // nothing written yet
		expect(() => readFileSync(file)).toThrow();

		await seedWallet(s);
		s.flushSync();

		expect((await store().profiles.getProfile(USER))?.balance).toBe(1000);
	});

	it('leaves reads from scheduling any write', async () => {
		const s = new LocalMemoryStore({ file, flushDebounceMs: 5 });
		await seedWallet(s);
		await s.flush();
		rmSync(file); // anything that re-created it came from a read

		await s.profiles.getProfile(USER);
		await s.profiles.listTopBalances(10);
		await s.bets.listBetsForSession(1);
		await s.flush();

		expect(() => readFileSync(file)).toThrow(); // a poll must never hit the disk
	});
});

describe('write/read classification covers every repo method', () => {
	// If a write is added to the GameStore interface without being listed in
	// WRITE_METHODS, it silently stops being persisted and the desktop build loses data
	// with no other symptom. These tests turn that into a build failure.
	const repoNames = Object.keys(WRITE_METHODS) as (keyof TxStore)[];

	it('lists the same repositories for reads as for writes', () => {
		expect(Object.keys(READ_METHODS).sort()).toEqual([...repoNames].sort());
	});

	it.each(repoNames)('%s — every method is classified, and classified once', (name) => {
		const repo = new MemoryStore()[name] as unknown as Record<string, unknown>;
		const writes = WRITE_METHODS[name];
		const reads = READ_METHODS[name];

		for (const method of Object.keys(repo)) {
			expect(typeof repo[method], `${name}.${method} is not a function`).toBe('function');
		}

		const classified = new Set([...writes, ...reads]);
		for (const method of Object.keys(repo)) {
			expect(
				classified.has(method),
				`${name}.${method} is neither a write nor a read — classify it in WRITE_METHODS or READ_METHODS`
			).toBe(true);
		}
		// Nothing classified that does not exist — a typo would disable a real write.
		for (const method of classified) {
			expect(typeof repo[method], `${name}.${method} does not exist`).toBe('function');
		}
		expect(writes.length + reads.length).toBe(Object.keys(repo).length);
	});
});

describe('trimTicks', () => {
	const tickDay = (day: string) =>
		[
			`${day}|nifty`,
			[{ tradeDate: day, underlying: 'nifty', ts: 1, value: 1, changePts: 0, changePct: 0 }]
		] as [string, MemorySnapshot['ticks'][number][1]];

	it('leaves a store within the retention window untouched', () => {
		const snapshot = { ticks: [tickDay('2026-08-27'), tickDay('2026-08-28')] } as MemorySnapshot;
		trimTicks(snapshot, 10);
		expect(snapshot.ticks).toHaveLength(2);
	});

	it('keeps only the most recent days once the cap is exceeded', () => {
		// The memory driver has no partition maintenance, so an un-trimmed file grows forever.
		const snapshot = {
			ticks: [
				tickDay('2026-08-01'),
				tickDay('2026-08-20'),
				tickDay('2026-08-27'),
				tickDay('2026-08-28')
			]
		} as MemorySnapshot;
		trimTicks(snapshot, 2);

		expect(snapshot.ticks.map(([key]) => key)).toEqual(['2026-08-27|nifty', '2026-08-28|nifty']);
	});

	it('defaults to the documented retention window', () => {
		const snapshot = {
			ticks: Array.from({ length: TICK_RETENTION_DAYS + 5 }, (_, i) =>
				tickDay(`2026-08-${String(i + 1).padStart(2, '0')}`)
			)
		} as MemorySnapshot;
		trimTicks(snapshot);
		expect(snapshot.ticks).toHaveLength(TICK_RETENTION_DAYS);
	});
});
