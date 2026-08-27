/**
 * Domain row types — the vocabulary of the persistence layer (PLAN.md §3).
 *
 * These are the shapes `GameStore` (./interface) hands back and forth. They are
 * deliberately storage-agnostic:
 *
 *  - `date` columns arrive as 'YYYY-MM-DD' IST calendar strings (the app's own
 *    clock, see $lib/time/ist) — never as Date objects.
 *  - `timestamptz` columns arrive as epoch milliseconds (number) so they are
 *    JSON-serializable straight into `/api/state` with no Date round-trip.
 *  - `numeric` columns arrive as JS numbers (they are prices/odds, not money —
 *    integer NC chips are the only currency and those are `integer`/`bigint`).
 *
 * Both drivers (./memory, ./postgres) map to exactly these shapes, which is why
 * service code (T7 bets, T9 settlement, T10 totals) never learns which one is live.
 */

/**
 * The enum *values* below mirror the CHECK constraints in
 * supabase/migrations/0001_init.sql one-for-one — validate user input against these
 * before it ever reaches an INSERT, and the database can never reject a row.
 */

/** The three tradable indices of the game (mirrors $lib/server/cas/types). */
export type Underlying = 'nifty' | 'banknifty' | 'sensex';

export const UNDERLYINGS: readonly Underlying[] = ['nifty', 'banknifty', 'sensex'];

/** Lifecycle of one trading day. */
export type SessionStatus = 'open' | 'locked' | 'settling' | 'settled';

export const SESSION_STATUSES: readonly SessionStatus[] = ['open', 'locked', 'settling', 'settled'];

/** Direction of a bet relative to the previous close. */
export type TargetKind = 'up' | 'down';

/** Settlement outcome (PLAN §0.2 — miss = full loss, flat = refund). */
export type SettlementTier = 'hit' | 'flat' | 'miss';

/** Wallet movement kinds (append-only ledger). */
export type LedgerKind = 'signup_bonus' | 'bet_stake' | 'payout' | 'refund';

export const LEDGER_KINDS: readonly LedgerKind[] = [
	'signup_bonus',
	'bet_stake',
	'payout',
	'refund'
];

/** Where an official close came from (PLAN §3 index_closes.source). */
export type CloseSource = 'official' | 'live_approx';

/** profiles — one row per user; `balance` is the wallet (integer NC chips, never negative). */
export type Profile = {
	userId: string;
	handle: string;
	email: string;
	balance: number;
	xp: number;
	streakDays: number;
	/** IST 'YYYY-MM-DD' of the user's last bet — streak continuity at settlement. */
	lastBetDate: string | null;
	/** epoch ms */
	createdAt: number;
};

export type NewProfile = {
	userId: string;
	handle: string;
	email: string;
	/** Defaults to 0 when omitted — signup flows pass SIGNUP_BONUS explicitly. */
	balance?: number;
};

/** daily_sessions — one row per IST trading day; the state machine of the game. */
export type DailySession = {
	id: number;
	tradeDate: string;
	status: SessionStatus;
	/** epoch ms — 15:20:00 IST of tradeDate */
	cutoffAt: number;
	/** epoch ms */
	createdAt: number;
};

/** bets — one active bet per (user, session, underlying); odds frozen at placement. */
export type Bet = {
	id: string;
	userId: string;
	sessionId: number;
	underlying: Underlying;
	targetKind: TargetKind;
	deltaPoints: number;
	/** Multiplier copied from the ladder at bet time — history-proof (PLAN §3). */
	odds: number;
	stake: number;
	settlementTier: SettlementTier | null;
	/** Total credited back (stake × odds for a hit, stake for a flat, 0 for a miss). */
	payout: number | null;
	settledAt: number | null;
	createdAt: number;
};

export type NewBet = {
	id?: string;
	userId: string;
	sessionId: number;
	underlying: Underlying;
	targetKind: TargetKind;
	deltaPoints: number;
	odds: number;
	stake: number;
};

/** cas_ticks — append-only archive of every scraped tick (partitioned by trade_date). */
export type CasTickRow = {
	tradeDate: string;
	underlying: Underlying;
	/** epoch ms */
	ts: number;
	value: number;
	changePts: number;
	changePct: number;
};

/** index_closes — the official (or live-approximate) close per index per day. */
export type IndexClose = {
	tradeDate: string;
	underlying: Underlying;
	close: number;
	source: CloseSource;
};

/** daily_pots — platform-wide counters, maintained transactionally with bet writes. */
export type DailyPot = {
	tradeDate: string;
	totalBets: number;
	totalStaked: number;
	totalPaidOut: number;
	playersCount: number;
	/** epoch ms */
	updatedAt: number;
};

/** Signed counter delta applied inside a transaction (never recomputed by SUM at read time). */
export type PotDelta = {
	totalBets?: number;
	totalStaked?: number;
	totalPaidOut?: number;
	playersCount?: number;
};

/** user_stats — all-time aggregates; one row lookup per profile page, never a scan. */
export type UserStats = {
	userId: string;
	betsPlaced: number;
	betsWon: number;
	totalStaked: number;
	totalWon: number;
	bestPayout: number;
	/** epoch ms */
	updatedAt: number;
};

export type StatsDelta = {
	betsPlaced?: number;
	betsWon?: number;
	totalStaked?: number;
	totalWon?: number;
	/** A best_payout candidate — applied only when greater than the stored value. */
	bestPayout?: number;
};

/** ledger — append-only, signed money movements; the audit trail behind every balance. */
export type LedgerEntry = {
	id: number;
	userId: string;
	kind: LedgerKind;
	/** Signed: stakes negative, payouts/refunds/bonuses positive. */
	amount: number;
	refBetId: string | null;
	balanceAfter: number;
	/** epoch ms */
	createdAt: number;
};

export type NewLedgerEntry = {
	userId: string;
	kind: LedgerKind;
	amount: number;
	refBetId?: string | null;
	/** Wallet balance after this movement — required, it is what makes the ledger auditable. */
	balanceAfter: number;
};
