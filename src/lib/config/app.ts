/**
 * Global app configuration — single source of truth for time rules, economy and polling.
 * Everything here must be safe to import from both server and browser code.
 */

/** IST = UTC+5:30 all year — India has no DST. */
export const APP_TIMEZONE_OFFSET_MIN = 330;

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

/** Minimum/maximum stake per bet (NC chips). */
export const MIN_STAKE = 10;
export const MAX_STAKE = 100_000;

export type Hms = { h: number; m: number; s: number };
