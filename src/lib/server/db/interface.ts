/**
 * GameStore — the ONLY way feature code touches persistence (PLAN §5 T4/T7/T9/T10).
 *
 * Design rules, in priority order:
 *
 *  1. **Money is transactional.** Anything that moves NC chips (bet place/edit/cancel,
 *     settlement credit) MUST run inside `store.tx(fn)`. Inside a transaction the caller
 *     gets a `TxStore` whose `profiles.lockForUpdate()` row-locks the wallet (Postgres:
 *     `SELECT ... FOR UPDATE`; memory: the tx mutex already serializes everything).
 *     Reads may happen outside a tx; writes that touch a balance may not.
 *  2. **Counters are deltas, never aggregates.** `pots.applyPotDelta` / `stats.applyStatsDelta`
 *     are cheap single-row updates performed in the SAME transaction as the bet write
 *     (PLAN §3) — no `SUM(bets)` at read time, at any scale.
 *  3. **The ledger is append-only and payout-once.** `appendLedger` refuses a second
 *     `payout` row for the same bet — in Postgres via the partial unique index
 *     `ledger_payout_once`, in memory via an explicit check. That is what makes
 *     `settleSession` idempotent.
 *  4. **Two implementations, one interface.** `MemoryStore` (zero-config, tests + local
 *     dev + dry-runs) and `PostgresStore` (production). Pickers live in ./index.
 *
 * How T7/T9 will express transactions — the seam is already here:
 *
 * ```ts
 * // T7 placeBet — one atomic unit:
 * const bet = await store.tx(async (t) => {
 *   const session = await t.sessions.getSessionByDate(tradeDate);
 *   if (!session || session.status !== 'open' || Date.now() >= session.cutoffAt) throw ...;
 *   const profile = await t.profiles.lockForUpdate(userId);        // serializes the wallet
 *   if (profile.balance < stake) throw new InsufficientFundsError();
 *   const bet = await t.bets.insertBet({ ... });                   // upsert per (user,session,underlying)
 *   await t.ledger.appendLedger({ userId, kind: 'bet_stake', amount: -stake,
 *                                 refBetId: bet.id, balanceAfter: profile.balance - stake });
 *   await t.pots.applyPotDelta(tradeDate, { totalBets: 1, totalStaked: stake, playersCount: isNew ? 1 : 0 });
 *   await t.stats.applyStatsDelta(userId, { betsPlaced: 1, totalStaked: stake });
 *   return bet;
 * });
 * ```
 *
 * `placeBet` and `settleBets` are both implemented as the shared bodies in ./money
 * running inside `tx()` — one implementation, two drivers.
 */
import { MAX_LEADERBOARD_ROWS } from '$lib/config/app';
import type {
	Bet,
	CasTickRow,
	CloseSource,
	DailyPot,
	DailySession,
	IndexClose,
	LedgerEntry,
	NewBet,
	NewLedgerEntry,
	NewProfile,
	PotDelta,
	Profile,
	SessionStatus,
	SettlementTier,
	StatsDelta,
	TargetKind,
	Underlying,
	UserStats
} from './types';
// Type-only, so it does not close a runtime cycle: ./money owns the settlement tx
// body and therefore owns its input/result shapes (the same seam as `placeBet`).
import type { SettleBetsInput, SettleBetsResult } from './money';

// ---------------------------------------------------------------------------
// Errors — part of the contract, thrown identically by both drivers
// ---------------------------------------------------------------------------

/** Base class so callers can `catch (e) { if (e instanceof DbError) ... }`. */
export class DbError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message);
		this.name = 'DbError';
	}
}

/** A balance-affecting operation would have taken the wallet below 0. */
export class InsufficientFundsError extends DbError {
	constructor(
		userId: string,
		readonly required: number,
		readonly available: number
	) {
		super(
			`insufficient funds for ${userId}: needs ${required}, has ${available}`,
			'INSUFFICIENT_FUNDS'
		);
		this.name = 'InsufficientFundsError';
	}
}

/** A second `payout` ledger row was attempted for a bet that already paid out. */
export class DuplicatePayoutError extends DbError {
	constructor(betId: string) {
		super(`bet ${betId} has already been paid out (ledger_payout_once)`, 'DUPLICATE_PAYOUT');
		this.name = 'DuplicatePayoutError';
	}
}

/** A row that had to exist did not (e.g. settling a bet twice, or a missing profile). */
export class NotFoundError extends DbError {
	constructor(what: string) {
		super(`${what} not found`, 'NOT_FOUND');
		this.name = 'NotFoundError';
	}
}

/** An already-settled bet/session was written to again. */
export class AlreadySettledError extends DbError {
	constructor(what: string) {
		super(`${what} is already settled`, 'ALREADY_SETTLED');
		this.name = 'AlreadySettledError';
	}
}

/** The trading day is not accepting bets (no session row, or it is locked/settled). */
export class SessionClosedError extends DbError {
	constructor(tradeDate: string) {
		super(`session ${tradeDate} is not open for bets`, 'SESSION_CLOSED');
		this.name = 'SessionClosedError';
	}
}

/** A bet arrived after the day's 15:20:00 IST cutoff. Server clock is authoritative. */
export class CutoffPassedError extends DbError {
	constructor(
		readonly nowMs: number,
		readonly cutoffAtMs: number
	) {
		super(`cutoff passed: now ${nowMs} is after ${cutoffAtMs}`, 'CUTOFF_PASSED');
		this.name = 'CutoffPassedError';
	}
}

/**
 * The user already has an active bet on this index for this session — the "one
 * active bet per index per day" rule of PLAN §0, enforced by the
 * `unique (user_id, session_id, underlying)` key. The existing bet's id travels
 * with the error so the service (and the 409 it maps to) can point at it.
 */
export class BetExistsError extends DbError {
	constructor(readonly betId: string) {
		super(`bet ${betId} already covers this index for this session`, 'BET_EXISTS');
		this.name = 'BetExistsError';
	}
}

// ---------------------------------------------------------------------------
// Domain groups
// ---------------------------------------------------------------------------

/**
 * One settlement day's gamification write (T9). See
 * {@link ProfileRepo.applyProfileProgress} for why `xpDelta` is a delta and the
 * streak fields are not.
 */
export type ProfileProgress = {
	/** XP to ADD to the profile (XP_PER_BET × settled + XP_PER_HIT × hits). */
	xpDelta: number;
	/** The streak count as it should now stand (continues, resets, or starts at 1). */
	streakDays: number;
	/** The IST trade date to stamp as the user's last betting day. */
	lastBetDate: string;
};

// ---------------------------------------------------------------------------
// Leaderboard / history readers (T14)
//
// Every one of these is a bounded, read-only projection over COLUMNS THAT ARE
// ALREADY PRECOMPUTED — `profiles.balance`, `profiles.streak_days`,
// `user_stats.bets_won`, `bets.payout`. That is what keeps them inside the PLAN
// §3 doctrine: no `SUM`/`COUNT` over `bets` anywhere in a read path, so a
// leaderboard costs the same at 10 users as at 10 lakh. The ordering keys are
// ordinary indexed columns; the limit is the bound.
// ---------------------------------------------------------------------------

/** One row of the 🏆 top-balances board — a `profiles` row joined to its `user_stats`. */
export type TopBalanceRow = {
	/** The public identity. A leaderboard never carries an email or a user id. */
	handle: string;
	/** Live wallet, whole NC chips. */
	balance: number;
	xp: number;
	streakDays: number;
	/** All-time counters from `user_stats` — precomputed at bet/settle time, never aggregated here. */
	betsPlaced: number;
	betsWon: number;
};

/** One row of the 🔥 longest-streaks board — `profiles` where `streak_days > 0`. */
export type TopStreakRow = {
	handle: string;
	streakDays: number;
	/** Carried so the UI can badge the row with the XP-derived rank (`$lib/config/ranks`). */
	xp: number;
};

/** One row of the ⚡ biggest-calls board — the day's settled bets by payout. */
export type TopWinRow = {
	handle: string;
	underlying: Underlying;
	targetKind: TargetKind;
	/** The round-number move the player called, in points (sign lives in {@link targetKind}). */
	deltaPoints: number;
	stake: number;
	/** Total credited back — `stake × odds` for a hit, `stake` for a flat, 0 for a miss. */
	payout: number;
	/** Multiplier frozen at bet time. */
	odds: number;
	/** Always present: only settled bets are ranked. */
	settlementTier: SettlementTier;
};

/** Cursor options for {@link BetRepo.listBetsForUserPage}. */
export type BetPageOptions = {
	/**
	 * epoch ms — only rows PLACED STRICTLY BEFORE this instant. The cursor is the
	 * `created_at` of the last row of the previous page; the HTTP edge carries it
	 * as an ISO string (`?before=`) and converts.
	 */
	beforeCreatedAt?: number;
	/**
	 * Keyset tie-break for the rows that share {@link beforeCreatedAt} to the
	 * millisecond. Without it, two same-instant bets straddling a page boundary
	 * would skip one on the next page; `id` (uuid) breaks the tie and makes the
	 * walk lossless.
	 */
	beforeId?: string;
	/**
	 * Caller-capped, never defaulted — a page endpoint states its own bound, the
	 * same rule {@link BetRepo.listRecentSettledBets} follows.
	 */
	limit: number;
};

/**
 * The single clamp every leaderboard read runs through. A negative or
 * non-integer limit reads as 0 (a caller that cannot state a bound gets nothing
 * rather than everything), and nothing can exceed {@link MAX_LEADERBOARD_ROWS} —
 * the documented product cap, identical in both drivers.
 */
export function leaderboardLimit(limit: number): number {
	return Math.min(Math.max(0, Math.trunc(limit)), MAX_LEADERBOARD_ROWS);
}

/** daily_sessions — the trading-day state machine. */
export type SessionRepo = {
	/**
	 * Get-or-create by IST trade date. Idempotent: the second call returns the same row
	 * and does NOT overwrite `cutoffAt`/`status` (first write wins — re-deriving a session
	 * mid-day must never move the cutoff or unlock a locked day).
	 */
	ensureSession(tradeDate: string, cutoffAt: number): Promise<DailySession>;
	getSessionByDate(tradeDate: string): Promise<DailySession | null>;
	getSessionById(sessionId: number): Promise<DailySession | null>;
	setSessionStatus(sessionId: number, status: SessionStatus): Promise<void>;
	/**
	 * Conditional status write — the settlement engine's re-entry guard. Moves the
	 * session to `status` ONLY when it currently sits in one of `expected`, and
	 * reports whether the write won. One UPDATE with the expected state in the WHERE,
	 * so two overlapping runs cannot both claim a day: the loser reads `false` and
	 * backs off. `false` also covers a session id that no longer exists.
	 */
	setSessionStatusIf(
		sessionId: number,
		status: SessionStatus,
		expected: readonly SessionStatus[]
	): Promise<boolean>;
};

export type ProfileRepo = {
	getProfile(userId: string): Promise<Profile | null>;
	getProfileByHandle(handle: string): Promise<Profile | null>;
	/** Public profile page needs a batch of handles in one round trip. */
	listProfilesByHandles(handles: string[]): Promise<Profile[]>;
	insertProfile(profile: NewProfile): Promise<Profile>;
	setHandle(userId: string, handle: string): Promise<Profile>;
	/**
	 * Wallet serialization primitive. Only meaningful inside `tx()`: Postgres issues
	 * `SELECT ... FOR UPDATE` on the transaction's connection, so concurrent money
	 * ops on the same user queue up behind the row lock. The memory driver's tx mutex
	 * already provides the ordering, so this is a plain read there.
	 */
	lockForUpdate(userId: string): Promise<Profile | null>;
	/**
	 * The only way a balance changes. Atomic (single UPDATE), rejects with
	 * {@link InsufficientFundsError} — and rolls the whole transaction back — when the
	 * resulting balance would be negative (PLAN §3 `check (balance >= 0)`).
	 * Returns the updated profile so the caller can stamp `ledger.balanceAfter`.
	 */
	applyBalanceDelta(userId: string, delta: number): Promise<Profile>;
	/**
	 * The settlement side of gamification (T9): XP accrual and the streak flame.
	 * Call it inside `tx()` after `lockForUpdate`, having computed the next streak
	 * from the row you just read.
	 *
	 * `xpDelta` is a DELTA (it accrues per settled bet); `streakDays` and
	 * `lastBetDate` are ABSOLUTE — a streak resets as well as continues, so "add 1"
	 * is not expressible. This asymmetry is deliberate and is why the type is not a
	 * plain signed delta like {@link StatsDelta}.
	 */
	applyProfileProgress(userId: string, next: ProfileProgress): Promise<Profile>;
	/**
	 * 🏆 Top balances (T14) — `profiles` joined to `user_stats`, richest first.
	 *
	 * Ordering is deterministic all the way down: `balance desc`, then `xp desc`,
	 * then `handle asc`, so two wallets of equal size always render in the same
	 * order on every node and every re-render. A profile with no `user_stats` row
	 * yet (nobody has settled anything for it) is NOT dropped — its counters read
	 * 0, because "has chips but has not played" is a real leaderboard state.
	 *
	 * Capped by {@link leaderboardLimit}; the balance column is the precomputed
	 * wallet, so this is one indexed sort over `profiles`, never an aggregate.
	 */
	listTopBalances(limit: number): Promise<TopBalanceRow[]>;
	/**
	 * 🔥 Longest streaks (T14) — `profiles` with `streak_days > 0`, longest first.
	 *
	 * Zero-streak rows are excluded rather than zero-padded: a player who has not
	 * bet yet has no streak to rank, and the section renders an empty state instead
	 * of 100 rows of "0 days". Tie-break `xp desc, handle asc` for the same reason
	 * as {@link listTopBalances}.
	 */
	listTopStreaks(limit: number): Promise<TopStreakRow[]>;
};

export type BetRepo = {
	getBetById(betId: string): Promise<Bet | null>;
	/** Every bet a user placed on one IST date (edit/cancel UI + history). */
	getBetsForUserOnDate(userId: string, tradeDate: string): Promise<Bet[]>;
	/**
	 * The public profile page's "recent bets" strip (T10): this user's last `limit`
	 * SETTLED bets, newest settlement first. Open bets are deliberately excluded —
	 * the game page owns today's live positions, a public page shows outcomes.
	 *
	 * Ordering is `settled_at desc, created_at desc, id desc`: a whole trading day
	 * settles in one instant, so a day's own bets are ordered by when they were
	 * placed. `limit` has no default on purpose — a public endpoint must state its
	 * own bound rather than inherit one from the driver.
	 */
	listRecentSettledBets(userId: string, limit: number): Promise<Bet[]>;
	/**
	 * ⚡ Today's biggest calls (T14) — the settled bets of ONE trade date, biggest
	 * payout first, joined to `profiles` so the row names a player.
	 *
	 * "Of that date" means the bet's SESSION carries the trade date (`session_id →
	 * daily_sessions.trade_date`), not `settled_at::date`: a day settles once at
	 * ~15:43, so the two coincide in practice, but the session is the fact the
	 * product means by "today's calls" and it survives a re-settle or a late
	 * capture past midnight IST.
	 *
	 * Ties are broken by `handle asc, id asc` — deterministic across nodes and
	 * stable across re-reads, which a "top calls" strip needs if two players cash
	 * the identical payout. A bet whose profile row has vanished is skipped (the
	 * join drops it): an ownerless bet cannot be named on a public board.
	 */
	listTopWinsForDate(tradeDate: string, limit: number): Promise<TopWinRow[]>;
	/**
	 * The player's OWN bet log, one page at a time (T14 `/history`). Unlike
	 * {@link listRecentSettledBets} this is every status — live bets are the
	 * interesting rows on your own history, and only a public page has to hide them.
	 *
	 * Newest first (`created_at desc, id desc`), caller-capped, and cursor-keyed by
	 * {@link BetPageOptions.beforeCreatedAt} (+ {@link BetPageOptions.beforeId}) so
	 * "Load more" is a keyset walk and never re-sends or skips a row as the table
	 * grows underneath it. `limit` has no default, same as the other readers here.
	 */
	listBetsForUserPage(userId: string, options: BetPageOptions): Promise<Bet[]>;
	/** Settlement scan — the settlement engine iterates a session's bets in chunks. */
	listBetsForSession(sessionId: number): Promise<Bet[]>;
	/**
	 * Insert, or replace an existing bet for the same (user, session, underlying) — the
	 * "one active bet per index per day" rule from PLAN §0. Balance/ledger effects are
	 * the CALLER's job inside the same tx (see {@link GameStore.tx}).
	 */
	upsertBet(bet: NewBet): Promise<Bet>;
	/**
	 * Remove a bet outright — the cancel path (T7). Deleting (rather than marking)
	 * is what frees the unique `(user_id, session_id, underlying)` slot so the user
	 * can bet that index again the same day; the ledger rows are the audit trail of
	 * the stake that left and the refund that came back.
	 *
	 * Driver note: migration 0001 declares `ledger.ref_bet_id → bets(id)` with no
	 * `on delete` action, and migrations are frozen. Postgres therefore detaches the
	 * ledger references (amounts and `balance_after` untouched) before the delete;
	 * the memory driver has no FK and keeps them. Money never changes either way.
	 */
	deleteBet(betId: string): Promise<void>;
	/** Mark settled. Throws {@link AlreadySettledError} if the bet was already settled. */
	setBetOutcome(
		betId: string,
		tier: SettlementTier,
		payout: number,
		settledAt: number
	): Promise<void>;
};

export type PotRepo = {
	getDailyPot(tradeDate: string): Promise<DailyPot | null>;
	/** Get-or-create a zeroed pot row; idempotent, never resets existing counters. */
	ensureDailyPot(tradeDate: string): Promise<DailyPot>;
	/** Signed counter arithmetic, applied in one UPDATE. Creates the row if absent. */
	applyPotDelta(tradeDate: string, delta: PotDelta): Promise<DailyPot>;
};

export type StatsRepo = {
	getUserStats(userId: string): Promise<UserStats>;
	/** Signed counter arithmetic; `bestPayout` is max-only. Creates the row if absent. */
	applyStatsDelta(userId: string, delta: StatsDelta): Promise<UserStats>;
};

export type LedgerRepo = {
	/**
	 * Append one signed money movement. Enforces payout-once (throws
	 * {@link DuplicatePayoutError} on a second `payout` for the same `refBetId`).
	 */
	appendLedger(entry: NewLedgerEntry): Promise<LedgerEntry>;
	/** Newest first — the receipt/history view. */
	getLedgerForUser(userId: string, limit?: number): Promise<LedgerEntry[]>;
	hasPayoutForBet(betId: string): Promise<boolean>;
};

export type TickRepo = {
	/**
	 * Batch-append scraped ticks (the 4s poller's write path). Idempotent on the
	 * natural key (trade_date, underlying, ts): re-inserting a poll is a no-op.
	 * Returns the number of rows actually stored.
	 */
	insertCasTicks(rows: CasTickRow[]): Promise<number>;
	/**
	 * Backfill window for chart rebuilds. `fromTs` is INCLUSIVE, `toTs` EXCLUSIVE —
	 * `[fromTs, toTs)` so a client can pass its `sinceTs` as `fromTs` without seeing
	 * the tick it already has, and re-request with `toTs` as the next `fromTs`.
	 * Ordered by ts ascending, capped at `limit`.
	 */
	getCasTicksRange(
		tradeDate: string,
		underlying: Underlying,
		fromTs: number,
		toTs: number,
		limit: number
	): Promise<CasTickRow[]>;
};

export type CloseRepo = {
	upsertIndexClose(close: {
		tradeDate: string;
		underlying: Underlying;
		close: number;
		source: CloseSource;
	}): Promise<void>;
	/**
	 * Write a close only when the (trade_date, underlying) row does not exist yet.
	 * Returns whether the row was written.
	 *
	 * This is the poller's anchor path: the first live `prevClose` of a trading day
	 * seeds `index_closes` as `live_approx`, and re-running the poll (or restarting
	 * the server mid-day) must not keep rewriting it — the day's `official` close
	 * lands later via {@link upsertIndexClose} and then wins for good.
	 */
	upsertIndexCloseIfAbsent(close: {
		tradeDate: string;
		underlying: Underlying;
		close: number;
		source: CloseSource;
	}): Promise<boolean>;
	/**
	 * Write the day's 15:15 last-traded-price anchor (`source = 'ltp_anchor'`).
	 * Overwrites a `live_approx` row (the poller's earlier prev-close fallback on
	 * the same primary key) but NEVER an `official` one, so a settled day is
	 * untouchable. Returns whether the row now holds the LTP anchor.
	 */
	upsertIndexLtpAnchor(close: {
		tradeDate: string;
		underlying: Underlying;
		close: number;
	}): Promise<boolean>;
	getIndexCloses(tradeDate: string): Promise<IndexClose[]>;
	/** The previous trading day's official close — the anchor every bet ladder hangs off. */
	getLatestCloseBefore(tradeDate: string, underlying: Underlying): Promise<IndexClose | null>;
};

/** Everything a transaction body may do. Same groups, scoped to one Postgres transaction. */
export type TxStore = {
	sessions: SessionRepo;
	profiles: ProfileRepo;
	bets: BetRepo;
	pots: PotRepo;
	stats: StatsRepo;
	ledger: LedgerRepo;
	ticks: TickRepo;
	closes: CloseRepo;
};

/** A live store handle. Reads are always allowed; money writes must go through {@link tx}. */
export type GameStore = TxStore & {
	/**
	 * Run `fn` as one atomic unit: BEGIN → fn(TxStore) → COMMIT, ROLLBACK on throw.
	 * Concurrency: serialized per wallet by `profiles.lockForUpdate` (Postgres) and
	 * globally by an async mutex (memory) — concurrent tx bodies never interleave, so
	 * read-modify-write inside a tx cannot lose an update.
	 *
	 * Nested `tx()` calls share the outer transaction (Postgres uses a SAVEPOINT) rather
	 * than opening a second one.
	 */
	tx<T>(fn: (tx: TxStore) => Promise<T>): Promise<T>;

	/** Release the pool / clear caches. Safe to call more than once. */
	close(): Promise<void>;

	// -------------------------------------------------------------------------
	// Money operations
	// -------------------------------------------------------------------------
	// The two money paths, both implemented as a single `this.tx(...)` running the
	// shared bodies in ./money (see the example on this interface).

	/**
	 * T7 — the placement money path, one atomic unit (see `placeBetInTx` in ./money,
	 * which both drivers run): session open + pre-cutoff check, wallet
	 * `lockForUpdate` + stake deduction, the one-bet-per-index rule, stake ledger row,
	 * then `daily_pots` + `user_stats` deltas.
	 *
	 * The service layer (`$lib/server/bets`) owns everything user-facing: ladder
	 * membership and the odds (resolved server-side, never taken from the client),
	 * the IST window and the stake bounds. It hands this method a settled input plus
	 * `cutoffAtMs`/`nowMs` so the driver can re-derive the same verdict from the
	 * session row — two independent gates on the same cutoff.
	 *
	 * Throws {@link SessionClosedError}, {@link CutoffPassedError},
	 * {@link NotFoundError} (unknown wallet), {@link InsufficientFundsError} and
	 * {@link BetExistsError}; every one of them leaves the store untouched.
	 */
	placeBet(input: {
		userId: string;
		tradeDate: string;
		underlying: Underlying;
		targetKind: 'up' | 'down';
		deltaPoints: number;
		/** Copied from the ladder by the service — the driver stores it verbatim. */
		odds: number;
		stake: number;
		/** 15:20:00 IST of `tradeDate`, in epoch ms. */
		cutoffAtMs: number;
		/** The instant the request was judged at. */
		nowMs: number;
	}): Promise<Bet>;

	/**
	 * T9 — the settlement money path: ONE transaction per chunk of bets
	 * (`settleBetsInTx` in ./money, the shared body both drivers run). Per bet,
	 * and only when the bet is still unsettled:
	 *
	 *   • mark it settled (`settlement_tier`, `payout`, `settled_at`)
	 *   • `hit`   → credit `payout`, one `payout` ledger row — the partial unique
	 *               index `ledger_payout_once` makes a second payment for the same
	 *               bet impossible, across re-runs as well as crashes
	 *   • `flat`  → credit the stake back, one `refund` ledger row
	 *   • `miss`  → no credit and NO ledger row (the stake left at placement)
	 *   • `daily_pots.total_paid_out` + `user_stats` move in the same unit of work
	 *
	 * The tier and the payout are decided by the service (`$lib/server/settle`) from
	 * the official close; this method only moves money and refuses to move it twice.
	 * Anything already settled is counted in `skipped` and left untouched, so a
	 * re-run after a crash is a numerical no-op.
	 */
	settleBets(input: SettleBetsInput): Promise<SettleBetsResult>;
};
