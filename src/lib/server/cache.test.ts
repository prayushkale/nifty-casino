/**
 * `cached()` — the TTL wrapper `/leaderboard` is built on.
 *
 * Time is INJECTED (`now`), not faked with timers: the wrapper compares two
 * numbers, so a test advances a counter and never has to flush a fake clock. The
 * backing Map is injected for the same reason — no test touches the shared
 * module Map, so nothing can leak between test files.
 */
import { describe, expect, it } from 'vitest';
import { cached, clearCache, type CacheEntry, type CacheOptions, type CacheStore } from './cache';

/** A throwaway cache, a hand-advanced clock, and the option object built from them. */
function rig(): {
	options: CacheOptions<unknown, unknown[]>;
	cache: CacheStore<unknown>;
	now: () => number;
	tick: (ms: number) => void;
} {
	let time = 1_000_000;
	const now = (): number => time;
	const cache: CacheStore<unknown> = new Map();
	return {
		now,
		cache,
		options: { now, cache },
		tick: (ms: number) => {
			time += ms;
		}
	};
}

describe('cached()', () => {
	it('computes once and serves the cached value while it is fresh', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async (date: string) => {
				calls += 1;
				return `board:${date}`;
			},
			30_000,
			rigg.options
		);

		await expect(read('2026-08-27')).resolves.toBe('board:2026-08-27');
		await expect(read('2026-08-27')).resolves.toBe('board:2026-08-27');
		await expect(read('2026-08-27')).resolves.toBe('board:2026-08-27');
		expect(calls).toBe(1);
	});

	it('recomputes once the TTL has passed, from the injected clock', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async () => {
				calls += 1;
				return calls;
			},
			30_000,
			rigg.options
		);

		await read();
		expect(calls).toBe(1);

		rigg.tick(29_999); // still fresh — `expiresAt` must be strictly greater than now
		await read();
		expect(calls).toBe(1);

		rigg.tick(1); // 30s after the write
		await read();
		expect(calls).toBe(2);
	});

	it('keys on the key function, not on argument noise', async () => {
		const rigg = rig();
		const calls: string[] = [];
		const read = cached(
			async (store: unknown, date: string) => {
				calls.push(date);
				return date;
			},
			30_000,
			{ ...rigg.options, key: (_store: unknown, date: string) => date }
		);

		// A different store instance must not be a different key: there is one store
		// per process, and putting a connection in a JSON key would be the bug.
		await read({ a: 1 }, '2026-08-27');
		await read({ b: 2 }, '2026-08-27');
		await read({ c: 3 }, '2026-08-28');

		expect(calls).toEqual(['2026-08-27', '2026-08-28']);
	});

	it('defaults to a JSON key over the arguments', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async (a: string, b: number) => {
				calls += 1;
				return `${a}${b}`;
			},
			30_000,
			rigg.options
		);

		await read('x', 1);
		await read('x', 1);
		await read('x', 2);
		expect(calls).toBe(2);
	});

	it('shares one flight between concurrent callers and caches the answer', async () => {
		const rigg = rig();
		let calls = 0;
		// Definite-assignment: the executor runs synchronously, so `release` is set
		// before the awaited read below; TS cannot see that, and narrowing it to
		// `null` would make the later call unreachable.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const read = cached(
			async () => {
				calls += 1;
				await gate;
				return 'the board';
			},
			30_000,
			rigg.options
		);

		const three = [read(), read(), read()];
		// Yield once: all three are pending on the SAME in-flight promise.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(1);

		release();
		await expect(Promise.all(three)).resolves.toEqual(['the board', 'the board', 'the board']);
		expect(calls).toBe(1);

		// …and the shared answer is now the cached one.
		await expect(read()).resolves.toBe('the board');
		expect(calls).toBe(1);
	});

	it('never caches a rejection and forgets the flight, so the next call retries', async () => {
		const rigg = rig();
		let attempt = 0;
		const read = cached(
			async () => {
				attempt += 1;
				if (attempt === 1) throw new Error('store hiccup');
				return 'recovered';
			},
			30_000,
			rigg.options
		);

		await expect(read()).rejects.toThrow('store hiccup');
		// Nothing was written to the cache…
		expect([...rigg.cache.keys()]).toEqual([]);
		// …and the failure is not sticky: the very next call tries again.
		await expect(read()).resolves.toBe('recovered');
		expect(attempt).toBe(2);
	});

	it('treats a zero TTL as "recompute every call"', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async () => {
				calls += 1;
				return calls;
			},
			0,
			rigg.options
		);
		await read();
		await read();
		expect(calls).toBe(2);
	});

	it('floors a negative TTL to zero rather than making an entry immortal', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async () => {
				calls += 1;
				return calls;
			},
			-5_000,
			rigg.options
		);
		await read();
		await read();
		expect(calls).toBe(2);
	});

	it('stores an expiry the caller can read back out of the Map', async () => {
		const rigg = rig();
		const read = cached(async () => 'value', 30_000, rigg.options);
		await read();

		const entry = rigg.cache.get('[]') as CacheEntry<string> | undefined;
		expect(entry?.value).toBe('value');
		expect(entry?.expiresAt).toBe(rigg.now() + 30_000);
	});

	it('clears on demand — the seam a manual re-settle would use', async () => {
		const rigg = rig();
		let calls = 0;
		const read = cached(
			async () => {
				calls += 1;
				return calls;
			},
			30_000,
			rigg.options
		);
		await read();
		clearCache(rigg.cache);
		await read();
		expect(calls).toBe(2);
	});
});
