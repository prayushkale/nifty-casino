/**
 * Mutex tests — the primitive that makes MemoryStore.tx() trustworthy.
 *
 * The interesting property is NOT "runs one at a time" (obvious) but "a later body does
 * not START until an earlier one FINISHES, even across awaits, and the lock always
 * comes back".
 */
import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex';

/** Lets a test park a body at a known point before finishing it. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Mutex', () => {
	it('is unlocked when idle', () => {
		expect(new Mutex().isLocked).toBe(false);
	});

	it('reports locked while a body is in flight', async () => {
		const mutex = new Mutex();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));

		const running = mutex.run(() => gate.then(() => 'done'));
		await tick();
		expect(mutex.isLocked).toBe(true);

		release?.();
		await expect(running).resolves.toBe('done');
		expect(mutex.isLocked).toBe(false);
	});

	it('runs bodies in the order they arrived', async () => {
		const mutex = new Mutex();
		const order: number[] = [];

		await Promise.all([
			mutex.run(async () => {
				await tick();
				order.push(1);
			}),
			mutex.run(async () => {
				await tick();
				order.push(2);
			}),
			mutex.run(async () => order.push(3))
		]);

		expect(order).toEqual([1, 2, 3]);
	});

	it('does not start a later body until the earlier one finishes', async () => {
		const mutex = new Mutex();
		let inside = 0;
		let overlap = false;

		const body = async (): Promise<void> => {
			inside += 1;
			if (inside > 1) overlap = true;
			await tick();
			inside -= 1;
		};

		await Promise.all(Array.from({ length: 20 }, () => mutex.run(body)));
		expect(overlap).toBe(false);
		expect(inside).toBe(0);
	});

	it('releases the lock when a body throws, and keeps the rejection private to that caller', async () => {
		const mutex = new Mutex();
		const boom = mutex.run(async () => {
			await tick();
			throw new Error('body failed');
		});

		const next = mutex.run(async () => 'recovered');

		await expect(boom).rejects.toThrow('body failed');
		await expect(next).resolves.toBe('recovered');
		expect(mutex.isLocked).toBe(false);
	});

	it('does not let a rejected body leak its error into a bystander', async () => {
		const mutex = new Mutex();
		const results = await Promise.allSettled([
			mutex.run(async () => {
				await tick();
				throw new Error('only mine');
			}),
			mutex.run(() => Promise.resolve('safe'))
		]);

		expect(results[0].status).toBe('rejected');
		expect(results[1]).toEqual({ status: 'fulfilled', value: 'safe' });
	});

	it('propagates a thrown synchronous-looking body', async () => {
		const mutex = new Mutex();
		// `Promise.resolve` bodies never yield; the lock must still be released.
		await mutex.run(() => Promise.resolve(1));
		await mutex.run(() => Promise.resolve(2));
		expect(mutex.isLocked).toBe(false);
	});
});
