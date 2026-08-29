/**
 * A tiny per-process TTL cache for reads that are (a) identical for every
 * caller, (b) expensive enough to repeat per request and (c) allowed to be up to
 * `ttlMs` stale.
 *
 * T14 uses it for `/leaderboard`: three ordered reads over `profiles` /
 * `user_stats` / `bets` that produce byte-identical output for everyone on the
 * node, so a 30s cache turns "one board per page view" into "one board per 30s
 * per process" without changing a single number a player can act on. It is
 * deliberately NOT used for anything per-user — `/api/state` and `/history` are
 * keyed by the caller and would leak a wallet across accounts through a shared
 * key.
 *
 * SCOPE — Tier 1 only. This is one Map in one Node process: it is correct while
 * the app is a single instance, and at Tier 2 (PLAN §6, 2× app nodes behind an
 * ALB) the swap is to Redis with the same `(key → value, expiresAt)` shape and
 * the SAME TTL — this module's contract is the swap surface, which is why `now`
 * and the backing Map are injectable rather than hidden.
 *
 * The clock is injected, not faked with timers: `cached` compares two numbers, so
 * a test passes `() => simulatedNow` and advances it. Nothing here can leak a
 * timer into a test run.
 */
export type CacheEntry<T> = {
	value: T;
	/** epoch ms after which the entry is stale — compared with the injected `now`. */
	expiresAt: number;
};

/** The clock. Defaults to `Date.now`; tests pin it. */
export type NowSource = () => number;

/** The backing store. Defaults to one shared module Map; tests inject their own. */
export type CacheStore<T> = Map<string, CacheEntry<T>>;

/** Shared by every `cached()` that does not inject its own store. */
const defaultCache: CacheStore<unknown> = new Map();

export type CacheOptions<T, A extends unknown[]> = {
	/** Injectable clock — a test drives time by moving this number forward. */
	now?: NowSource;
	/** Injectable backing Map — tests use a throwaway one, never the shared Map. */
	cache?: CacheStore<T>;
	/**
	 * Key over the wrapped call's arguments. Defaults to their JSON, which is only
	 * right for plain serializable arguments — a store or a connection must be
	 * excluded by a custom key (see the leaderboard, which keys on the trade date
	 * and deliberately ignores the store, there being exactly one per process).
	 */
	key?: (...args: A) => string;
};

/**
 * Wrap `fn` so its result is served from the cache for `ttlMs`.
 *
 *   • A stale or absent entry recomputes, and only a RESOLVED value is cached — a
 *     failed read is never remembered, so the next request retries a store that
 *     hiccuped instead of serving a cached error for 30s.
 *   • One flight per key: concurrent calls that miss share a single in-flight
 *     promise, so three players hitting a cold `/leaderboard` in the same tick
 *     cost one set of reads, not three. The in-flight entry is dropped when the
 *     promise settles either way, so a rejection is not sticky.
 *   • `ttlMs` is floored at 0 — a zero TTL recomputes every call and is how a
 *     test turns the cache off without changing the caller.
 *
 * The returned function has the same signature as `fn`; nothing about the caller
 * changes except that its answer may be up to `ttlMs` old.
 */
export function cached<A extends unknown[], T>(
	fn: (...args: A) => Promise<T>,
	ttlMs: number,
	options: CacheOptions<T, A> = {}
): (...args: A) => Promise<T> {
	const ttl = Math.max(0, Math.trunc(ttlMs));
	// Resolved per call rather than captured: `Date.now` must be looked up again at
	// call time, so a clock that is replaced after this wrapper was built is honoured.
	const now = options.now ?? ((): number => Date.now());
	// The shared Map is untyped by necessity (it backs every wrapper), so the
	// assertion is the one place that says "this wrapper's entries are all T".
	const cache: CacheStore<T> = options.cache ?? (defaultCache as CacheStore<T>);
	const keyOf: (...args: A) => string = options.key ?? ((...args: A) => JSON.stringify(args));
	const inflight = new Map<string, Promise<T>>();

	return async (...args: A): Promise<T> => {
		const key = keyOf(...args);
		const at = now();

		const hit = cache.get(key);
		if (hit && hit.expiresAt > at) return hit.value;

		const running = inflight.get(key);
		if (running) return running;

		const pending = (async () => {
			const value = await fn(...args);
			cache.set(key, { value, expiresAt: now() + ttl });
			return value;
		})();
		inflight.set(key, pending);
		try {
			return await pending;
		} finally {
			// Settled (resolved or rejected) — the next caller starts a fresh flight.
			inflight.delete(key);
		}
	};
}

/** Forget every entry in `cache`. For tests, and for "the data just changed" paths. */
export function clearCache(cache: CacheStore<unknown>): void {
	cache.clear();
}
