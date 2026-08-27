/**
 * Minimal async mutex — the memory driver's transaction serializer.
 *
 * Node runs our callbacks on one thread, but every `await` is a yield point, so two
 * concurrent read-modify-write sequences CAN interleave and lose an update:
 *
 *   A: read balance=100 ──await──►                     A: write balance=90
 *   B:                read balance=100 ──await──► B: write balance=95   (the 90 is lost)
 *
 * `Mutex.run` hands out exclusive turns, so tx bodies execute one at a time — which is
 * exactly the isolation `BEGIN … COMMIT` gives the Postgres driver, and what makes
 * `store.tx()` behave identically on both drivers.
 *
 * Deliberately no re-entrancy, no fairness policy, no timeouts: nesting `tx()` on the
 * memory driver would deadlock and it is not a supported pattern (see ./interface).
 * ~30 lines instead of a dependency.
 */
export class Mutex {
	/** Resolves when the current holder releases. The next caller chains onto it. */
	private queue: Promise<void> = Promise.resolve();
	private held = 0;

	get isLocked(): boolean {
		return this.held > 0;
	}

	/**
	 * Run `fn` while holding the lock, serialized against every other `run` call.
	 * `fn` for a later caller does not START until an earlier caller's `fn` resolved or
	 * threw. The lock is always released (`finally`), and a rejection travels only to
	 * the caller that caused it — never to a bystander waiting in the queue.
	 */
	run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});

		const turn = this.queue.then(() => {
			this.held += 1;
		});
		this.queue = gate;

		return turn.then(fn).finally(() => {
			this.held -= 1;
			release();
		});
	}
}
