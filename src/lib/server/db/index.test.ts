/**
 * Driver selection — the one decision that decides whether the app persists.
 *
 * The contract under test: with NO environment variables (the state of every fresh
 * clone, every CI run and every contributor laptop) `getStore()` hands back a working
 * MemoryStore; with DATABASE_URL it hands back Postgres. Nothing else in the app is
 * allowed to care which one is live.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getStore, resetStoreForTests } from './index';
import { MemoryStore } from './memory';
import { PostgresStore } from './postgres';

const ENV_VAR = 'DATABASE_URL';
const original = process.env[ENV_VAR];

afterEach(() => {
	if (original === undefined) delete process.env[ENV_VAR];
	else process.env[ENV_VAR] = original;
	resetStoreForTests();
});

describe('getStore()', () => {
	it('falls back to the memory driver when DATABASE_URL is unset', () => {
		delete process.env[ENV_VAR];
		resetStoreForTests();
		expect(getStore()).toBeInstanceOf(MemoryStore);
	});

	it('treats a blank DATABASE_URL as unset', () => {
		process.env[ENV_VAR] = '   ';
		resetStoreForTests();
		expect(getStore()).toBeInstanceOf(MemoryStore);
	});

	it('selects the postgres driver when DATABASE_URL is set', () => {
		process.env[ENV_VAR] = 'postgresql://postgres:pw@localhost:5432/nifty_casino_test';
		resetStoreForTests();
		expect(getStore()).toBeInstanceOf(PostgresStore);
	});

	it('caches one instance per process (a single pool, not one per request)', () => {
		delete process.env[ENV_VAR];
		resetStoreForTests();
		expect(getStore()).toBe(getStore());
	});

	it('picks the driver per call, so a store built before the env changed is not reused', async () => {
		delete process.env[ENV_VAR];
		resetStoreForTests();
		const memory = getStore();

		process.env[ENV_VAR] = 'postgresql://postgres:pw@localhost:5432/nifty_casino_test';
		resetStoreForTests();
		const postgresStore = getStore();

		expect(memory).not.toBe(postgresStore);
		await memory.close();
		await postgresStore.close();
	});
});
