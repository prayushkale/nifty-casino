/**
 * The leaderboard service (PLAN §5 T14, §4 "/leaderboard: top balances, today's
 * best calls, longest streaks").
 *
 * Three sections, three readers, one payload:
 *
 *   🏆 balances  — `ProfileRepo.listTopBalances` (profiles ⋈ user_stats)
 *   🔥 streaks   — `ProfileRepo.listTopStreaks`  (profiles, streak_days > 0)
 *   ⚡ topWins   — `BetRepo.listTopWinsForDate`  (settled bets of one trade date)
 *
 * Everything here is a PUBLIC projection: the repo rows already carry handles and
 * counters only, and this module adds nothing that names a wallet's owner — no
 * email, no user id, no ledger. The three lists are computed in one pass so the
 * cached payload is one object, and the whole thing is cached for
 * {@link LEADERBOARD_CACHE_TTL_MS} per process (see `$lib/server/cache` for why
 * that is Tier-1-only and what the Tier-2 swap is).
 *
 * NOT BUILT IN v1, DELIBERATELY: the weekly/all-time-earnings boards the plan
 * sketches ("top balance (all-time/weekly)") have no home in the data model. A
 * "this week" ranking is a windowed aggregate over bets, and PLAN §3 bans
 * aggregates in read paths — `user_stats` is all-time by design and `daily_pots`
 * is per-day, so a weekly board needs either a `weekly_*` column maintained at
 * settlement or a rollup table. Building it as a query today would be exactly the
 * `SUM(bets)` the doctrine outlaws. It becomes a precomputed column at Tier 2,
 * written in the same settlement transaction that already updates `user_stats`.
 * The all-time board stands in for it until then.
 */
import { LEADERBOARD_CACHE_TTL_MS } from '$lib/config/app';
import { istDateStr } from '$lib/time/ist';
import { getStore, type GameStore } from '$lib/server/db';
import type { TopBalanceRow, TopStreakRow, TopWinRow } from '$lib/server/db/interface';
import { cached, type CacheStore } from '$lib/server/cache';
import { winRateOf } from '$lib/server/profile';

/** How many rows each section shows by default — well inside the hard cap. */
export const LEADERBOARD_ROWS = 25;

/** The ⚡ section's window: today's calls only, keyed to the IST trade date. */
export type LeaderboardPayload = {
	/** IST trade date the ⚡ section is scoped to ('YYYY-MM-DD'). */
	tradeDate: string;
	/** epoch ms — the single instant the payload was assembled at. */
	generatedAt: number;
	/** 🏆 Richest wallets, richest first. */
	balances: LeaderBalanceRow[];
	/** 🔥 Longest active streaks, longest first. Empty on a fresh instance. */
	streaks: LeaderStreakRow[];
	/** ⚡ Biggest settled payouts of {@link tradeDate}, biggest first. */
	topWins: LeaderWinRow[];
};

/** 🏆 One row of the top-balances board — the repo row plus the derived win rate. */
export type LeaderBalanceRow = TopBalanceRow & {
	/**
	 * `betsWon / betsPlaced` as 0..1, or `null` when the player has never settled a
	 * bet — `null` so "never played" cannot render as "loses every time".
	 */
	winRate: number | null;
};

/** 🔥 One row of the streak board, as the repo hands it over. */
export type LeaderStreakRow = TopStreakRow;

/**
 * ⚡ One row of the biggest-calls board. `settlementTier` is renamed `tier` on the
 * wire — the same word the public profile's bet strip uses for a verdict, and one
 * less thing for the markup to say three times.
 */
export type LeaderWinRow = Omit<TopWinRow, 'settlementTier'> & {
	tier: TopWinRow['settlementTier'];
};

export type BuildLeaderboardOptions = {
	/** Defaults to the process store. */
	store?: GameStore;
	/** The IST trade date the ⚡ section covers. Defaults to `now`'s. */
	tradeDate?: string;
	/** The instant the payload is stamped with. Defaults to now; tests pin it. */
	now?: Date;
	/** Rows per section — the driver clamps it to the hard cap. */
	limit?: number;
};

/**
 * Assemble the whole board, uncached.
 *
 * Reads only, and the three are independent, so they run together. The two
 * profile reads are ordered sorts over precomputed columns and the bet read is a
 * per-date scan of settled payouts — none of them aggregates (PLAN §3), and all
 * three are bounded by {@link MAX_LEADERBOARD_ROWS} at the driver.
 */
export async function buildLeaderboard(
	options: BuildLeaderboardOptions = {}
): Promise<LeaderboardPayload> {
	const store = options.store ?? getStore();
	const now = options.now ?? new Date();
	const tradeDate = options.tradeDate ?? istDateStr(now);
	const limit = Math.max(0, Math.trunc(options.limit ?? LEADERBOARD_ROWS));

	const [balances, streaks, topWins] = await Promise.all([
		store.profiles.listTopBalances(limit),
		store.profiles.listTopStreaks(limit),
		store.bets.listTopWinsForDate(tradeDate, limit)
	]);

	return {
		tradeDate,
		generatedAt: now.getTime(),
		balances: balances.map((row) => ({ ...row, winRate: winRateOf(row) })),
		streaks,
		// Renamed, not duplicated: the payload carries `tier` and nothing else (a
		// spread alone would ship both spellings of the same verdict).
		topWins: topWins.map(({ settlementTier: tier, ...rest }) => ({ ...rest, tier }))
	};
}

export type LeaderboardReaderOptions = {
	/** TTL for the process cache. Defaults to {@link LEADERBOARD_CACHE_TTL_MS}. */
	ttlMs?: number;
	/** Injectable clock — what stamps `generatedAt` AND drives cache expiry. */
	now?: () => number;
	/** Injectable backing Map. Defaults to a fresh one per reader. */
	cache?: CacheStore<LeaderboardPayload>;
	/** Injectable store, for tests that do not want the process singleton. */
	store?: GameStore;
	/** Rows per section. */
	limit?: number;
};

export type LeaderboardReader = (tradeDate?: string) => Promise<LeaderboardPayload>;

/**
 * A cached leaderboard reader.
 *
 * The cache key is the trade date alone: the payload is identical for every
 * caller on the node, and the store is deliberately excluded from the key (one
 * store per process — including it would put a connection object into a JSON
 * string). Tests that swap stores build a new reader, which is why `cache`
 * defaults to a fresh Map per reader rather than to a module singleton.
 */
export function createLeaderboardReader(options: LeaderboardReaderOptions = {}): LeaderboardReader {
	const now = options.now ?? ((): number => Date.now());
	const limit = options.limit ?? LEADERBOARD_ROWS;
	// Resolved PER CALL, not captured: the process store can be re-selected (a test
	// resets it; an operator could point the app at a new database), and a reader
	// that froze the first store would keep reading a wallet nobody else can see.
	const store = options.store;
	const forDate = cached(
		(tradeDate: string) =>
			buildLeaderboard({ store: store ?? getStore(), tradeDate, limit, now: new Date(now()) }),
		options.ttlMs ?? LEADERBOARD_CACHE_TTL_MS,
		// The trade date is the whole key: the payload is identical for every caller
		// on the node, and the store stays out of it (one store per process).
		{ now, cache: options.cache, key: (tradeDate: string) => tradeDate }
	);
	return (tradeDate?: string) => forDate(tradeDate ?? istDateStr(new Date(now())));
}

/**
 * The per-process 30s cache behind `getLeaderboard` — the one `/leaderboard` uses.
 * Exposed so a test (or a manual re-settle) can drop it: the same seam
 * `$lib/server/ladder` calls `invalidateLadderCache`.
 */
const singletonCache: CacheStore<LeaderboardPayload> = new Map();

export function invalidateLeaderboardCache(): void {
	singletonCache.clear();
}

/** The process reader the page's load calls. Cached 30s, keyed by trade date. */
export const getLeaderboard: LeaderboardReader = createLeaderboardReader({
	cache: singletonCache
});
