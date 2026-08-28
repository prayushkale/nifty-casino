/**
 * Global app configuration — single source of truth for time rules, economy and polling.
 * Everything here must be safe to import from both server and browser code.
 */

/** IST = UTC+5:30 all year — India has no DST. */
export const APP_TIMEZONE_OFFSET_MIN = 330;

/**
 * Bet placement OPENS here, IST (PLAN §0: the participation window is
 * 15:00 → 15:20:00). Before this the day's session is not accepting bets.
 * The cutoff is {@link CUTOFF_HMS}; both ends are inclusive.
 */
export const BETTING_START_HMS = { h: 15, m: 0, s: 0 } as const;

/** Bet placement closes exactly here (inclusive up to this instant), IST. */
export const CUTOFF_HMS = { h: 15, m: 20, s: 0 } as const;

/** CAS auction begins — charts switch to live auction mode, betting still allowed until cutoff. */
export const AUCTION_START_HMS = { h: 15, m: 13, s: 30 } as const;

/** Auction nominal end — official close capture starts re-checking after this, IST. */
export const AUCTION_END_HMS = { h: 15, m: 42, s: 0 } as const;

/** Virtual chips credited on signup. Play-money only. */
export const SIGNUP_BONUS = 1000;

/** Upstream NSE/BSE poll cadence on our server (ms). Never poll faster client-side. */
export const POLL_MS = 4000;

/** Idle SSE connections from hidden tabs are dropped after this long. */
export const SSE_IDLE_TIMEOUT_MS = 10 * 60_000;

/** SSE heartbeat interval (ms) — keeps proxies from killing idle streams. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Hot ring buffer size per underlying (~48 min of ticks @4s). */
export const RING_BUFFER_CAP = 720;

/**
 * A feed is "stale" when the newest tick is older than this while the auction is
 * live — drives the client staleness banner (Task 12). Upstream polls at 4s, so
 * three missed polls is the threshold before a user should be told.
 */
export const CAS_STALE_MS = 12_000;

/** Minimum/maximum stake per bet (NC chips). */
export const MIN_STAKE = 10;
export const MAX_STAKE = 100_000;

// ---------------------------------------------------------------------------
// Settlement (PLAN §5 T9) — capture, chunking and the gamification accrual
// ---------------------------------------------------------------------------

/**
 * Official-close capture + settlement may first fire here, IST — one minute after
 * {@link AUCTION_END_HMS}, so a nominal 15:42:00 finish is already on disk. The
 * capture itself still refuses to run before 15:42 and the scheduler keeps
 * re-checking until {@link SETTLE_END_HMS}, which is what absorbs an auction
 * extension (PLAN §6 R2): closes that are not there yet are retried, never guessed.
 */
export const SETTLE_START_HMS = { h: 15, m: 43, s: 0 } as const;

/**
 * Last instant the settlement window stays open, IST (inclusive). Past this the
 * day gives up loudly and the session stays open — an unsettled day is visible,
 * a wrongly-settled one is not fixable.
 */
export const SETTLE_END_HMS = { h: 17, m: 0, s: 0 } as const;

/**
 * Re-check cadence inside the settlement window (ms). A cycle that finds the
 * official closes missing (or only some of them) waits this long and tries again
 * rather than settling on a live indicative.
 */
export const SETTLE_RETRY_MS = 60_000;

/** Re-check cadence outside the settlement window (ms) — do not hammer timers for 22h. */
export const SETTLE_IDLE_RECHECK_MS = 30_000;

/**
 * Bets settled per transaction (PLAN §6 R7): 10 lakh users × 3 bets = 30 lakh rows
 * a day, and one transaction per 5,000 keeps each unit of work well inside a
 * minute (and under every statement/lock budget) while a failure only rolls back
 * its own chunk — the payout-once ledger makes re-running the rest free.
 */
export const SETTLE_CHUNK = 5000;

/** XP for every bet that settles, hit or miss (PLAN §5 T9). */
export const XP_PER_BET = 10;

/** Extra XP for each HIT, on top of {@link XP_PER_BET}. */
export const XP_PER_HIT = 100;

export type Hms = { h: number; m: number; s: number };
