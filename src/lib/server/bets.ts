/**
 * The bet service (PLAN §5 T7) — the money path a route is allowed to call.
 *
 * Division of labour, top to bottom:
 *
 *   route        — auth (locals.userId), JSON shape, status codes, nothing else
 *   THIS module  — IST day/window/weekend, stake bounds, ladder membership and
 *                  the ODDS (resolved here, never taken from a client), then one
 *                  driver transaction per operation
 *   GameStore    — the transaction itself: session gate, wallet lock, deduction,
 *                  one-bet-per-index, ledger row, counter deltas (./db/money)
 *
 * Every failure is a typed {@link BetError} with a stable code — the route maps
 * codes to HTTP statuses and nothing else has to know what they mean. Nothing in
 * here ever leaks a driver message or a stack trace to a client.
 *
 * Money semantics (all three ops are ONE transaction, wallet locked first):
 *   place  — stake leaves immediately (PLAN §3 "stake deducts at placement")
 *   edit   — refund the old stake, then charge the new one; both land in the
 *            ledger, even when the stake did not change, so the ledger stays a
 *            complete history rather than a net-effect summary
 *   cancel — full refund, and the ROW IS DELETED: that is what frees the
 *            `(user_id, session_id, underlying)` slot so the index can be bet
 *            again today. The ledger rows remain as the audit trail. The pot's
 *            `players_count` only unwinds when this was the player's last active
 *            bet, which is what keeps `players_count === distinct bettors` true
 *            across a cancel-then-re-bet.
 */
import { BETTING_START_HMS, CUTOFF_HMS, MAX_STAKE, MIN_STAKE } from '$lib/config/app';
import {
	hmsToSeconds,
	isBetweenHMS,
	isWeekend,
	istDateStr,
	istDateStrToMidnightUtcMs,
	istHmsToUtcMs,
	secOfDayIst
} from '$lib/time/ist';
import {
	BetExistsError,
	CutoffPassedError,
	DbError,
	InsufficientFundsError,
	SessionClosedError,
	getStore,
	type GameStore
} from '$lib/server/db';
import { UNDERLYINGS, type Bet, type TargetKind, type Underlying } from '$lib/server/db/types';
import { resolveLadderOption } from '$lib/server/ladder';
import type { LiveCloseDeps } from '$lib/server/live-closes';

// ---------------------------------------------------------------------------
// typed errors — the service's whole HTTP contract
// ---------------------------------------------------------------------------

/** Every way a bet request can be refused, each with its own HTTP status. */
export type BetErrorCode =
	| 'INVALID_UNDERLYING'
	| 'INVALID_TARGET_KIND'
	| 'INVALID_STAKE'
	| 'INVALID_TARGET'
	| 'MARKET_CLOSED'
	| 'WINDOW_NOT_OPEN'
	| 'CUTOFF_PASSED'
	| 'SESSION_CLOSED'
	| 'BET_EXISTS'
	| 'INSUFFICIENT_BALANCE'
	| 'BET_NOT_FOUND'
	| 'BET_SETTLED';

/** code → HTTP status. The only place that knows the mapping. */
export const BET_ERROR_STATUS: Readonly<Record<BetErrorCode, number>> = {
	INVALID_UNDERLYING: 400,
	INVALID_TARGET_KIND: 400,
	INVALID_STAKE: 400,
	INVALID_TARGET: 400,
	MARKET_CLOSED: 409,
	WINDOW_NOT_OPEN: 409,
	CUTOFF_PASSED: 409,
	SESSION_CLOSED: 409,
	BET_EXISTS: 409,
	INSUFFICIENT_BALANCE: 409,
	BET_NOT_FOUND: 404,
	BET_SETTLED: 409
};

/**
 * A refused bet. `message` is safe to show a player ("Stake must be at least 10
 * NC"), `code` is what the UI branches on, `betId` carries the existing bet for
 * the idempotent double-submit case.
 */
export class BetError extends Error {
	constructor(
		readonly code: BetErrorCode,
		message: string,
		readonly details: Record<string, string | number> = {}
	) {
		super(message);
		this.name = 'BetError';
	}
}

/** Re-throw a driver-level money error as the service error the route expects. */
function translateDbError(err: unknown): unknown {
	if (!(err instanceof DbError)) return err;
	if (err instanceof InsufficientFundsError) {
		return new BetError('INSUFFICIENT_BALANCE', 'Not enough NC for that stake.', {
			required: err.required,
			available: err.available
		});
	}
	if (err instanceof BetExistsError) {
		return new BetError('BET_EXISTS', 'You already have a bet on this index today.', {
			betId: err.betId
		});
	}
	if (err instanceof CutoffPassedError) {
		return new BetError('CUTOFF_PASSED', 'The 15:20 cutoff has passed.');
	}
	if (err instanceof SessionClosedError) {
		return new BetError('SESSION_CLOSED', 'This session is no longer accepting bets.');
	}
	return err;
}

// ---------------------------------------------------------------------------
// validation helpers (the request is untrusted JSON — treat every field as unknown)
// ---------------------------------------------------------------------------

/** A bet request exactly as it arrived from the wire, before validation. */
export type BetRequest = {
	underlying: unknown;
	targetKind: unknown;
	deltaPoints: unknown;
	stake: unknown;
};

/** An edit request: every field optional, an absent field meaning "unchanged". */
export type BetPatch = {
	targetKind?: unknown;
	deltaPoints?: unknown;
	stake?: unknown;
};

/** Dependencies overridable per call — tests inject a store and a clock. */
export type BetCallOptions = {
	/** Defaults to `new Date()`; pin it to test windows and cutoffs. */
	now?: Date;
	/** Defaults to the process store (`getStore()`). */
	store?: GameStore;
	/**
	 * Live previous-close fallback for ladder validation. Defaults to the real
	 * feeds so a ladder the player could SEE is a ladder they can BET — the
	 * fallback only fires when the DB has no anchor for the bet's underlying.
	 * Pass `false` for the DB-only ladder (hermetic tests), or inject fetchers
	 * to simulate the feeds.
	 */
	live?: LiveCloseDeps | false;
};

type ResolvedOptions = { now: Date; store: GameStore; live: LiveCloseDeps | false };

function resolveOptions(options: BetCallOptions = {}): ResolvedOptions {
	return {
		now: options.now ?? new Date(),
		store: options.store ?? getStore(),
		live: options.live ?? {}
	};
}

function isUnderlying(value: unknown): value is Underlying {
	return typeof value === 'string' && (UNDERLYINGS as readonly string[]).includes(value);
}

function assertUnderlying(value: unknown): Underlying {
	if (isUnderlying(value)) return value;
	throw new BetError('INVALID_UNDERLYING', 'Pick one of NIFTY, BANKNIFTY or SENSEX.');
}

function assertTargetKind(value: unknown): TargetKind {
	if (value === 'up' || value === 'down') return value;
	throw new BetError('INVALID_TARGET_KIND', 'Direction must be "up" or "down".');
}

/** Steps are whole index points; a fractional or signed step is not on the ladder. */
function assertDeltaPoints(value: unknown): number {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
	throw new BetError('INVALID_TARGET', 'Target must be a positive whole number of points.');
}

function assertStake(value: unknown): number {
	if (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= MIN_STAKE &&
		value <= MAX_STAKE
	) {
		return value;
	}
	throw new BetError(
		'INVALID_STAKE',
		`Stake must be a whole number from ${MIN_STAKE} to ${MAX_STAKE} NC.`
	);
}

/** IST trade date + the absolute cutoff instant that belongs to it. */
export function tradeDayFor(now: Date): { tradeDate: string; cutoffAtMs: number } {
	const tradeDate = istDateStr(now);
	return {
		tradeDate,
		cutoffAtMs: istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), CUTOFF_HMS)
	};
}

/** Where `now` sits in the 15:00:00–15:20:00 IST participation window. */
export function bettingWindowState(now: Date): 'open' | 'not-open' | 'cutoff-passed' {
	if (isBetweenHMS(now, BETTING_START_HMS, CUTOFF_HMS)) return 'open';
	return secOfDayIst(now) < hmsToSeconds(BETTING_START_HMS) ? 'not-open' : 'cutoff-passed';
}

/**
 * The shared pre-flight for every money op: the day must be a trading day inside
 * the participation window. Throws the window errors, else returns the day.
 */
function assertBettableDay(now: Date): { tradeDate: string; cutoffAtMs: number } {
	const day = tradeDayFor(now);
	// Weekends first: no session can exist, so say that rather than "window closed".
	if (isWeekend(day.tradeDate)) {
		throw new BetError('MARKET_CLOSED', 'Markets are closed on weekends.');
	}
	const state = bettingWindowState(now);
	if (state === 'not-open') {
		throw new BetError('WINDOW_NOT_OPEN', 'Betting opens at 15:00 IST.');
	}
	if (state === 'cutoff-passed') {
		throw new BetError('CUTOFF_PASSED', 'The 15:20 cutoff has passed.');
	}
	return day;
}

// ---------------------------------------------------------------------------
// place
// ---------------------------------------------------------------------------

/**
 * Place a bet: validate, resolve the odds from today's ladder, then let the
 * driver move the money in one transaction.
 *
 * `request` may be the raw body fields — every one is validated here. `odds` is
 * deliberately NOT part of the request type at all.
 */
export async function placeBet(
	userId: string,
	request: BetRequest,
	options: BetCallOptions = {}
): Promise<Bet> {
	const { now, store, live } = resolveOptions(options);
	const underlying = assertUnderlying(request.underlying);
	const targetKind = assertTargetKind(request.targetKind);
	const deltaPoints = assertDeltaPoints(request.deltaPoints);
	const stake = assertStake(request.stake);
	const day = assertBettableDay(now);

	await store.sessions.ensureSession(day.tradeDate, day.cutoffAtMs);
	const option = await resolveLadderOption(
		day.tradeDate,
		underlying,
		targetKind,
		deltaPoints,
		store,
		live
	);
	if (!option) {
		throw new BetError('INVALID_TARGET', 'That target is not on today’s ladder.', {
			underlying,
			targetKind,
			deltaPoints
		});
	}

	try {
		return await store.placeBet({
			userId,
			tradeDate: day.tradeDate,
			underlying,
			targetKind,
			deltaPoints,
			odds: option.odds,
			stake,
			cutoffAtMs: day.cutoffAtMs,
			nowMs: now.getTime()
		});
	} catch (err: unknown) {
		throw translateDbError(err);
	}
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/**
 * Edit a bet before the cutoff: refund the old stake, charge the new one, rewrite
 * the row. Counters move by the *difference*, so `totalBets` is untouched and a
 * same-stake edit is a zero-width money movement that still leaves two ledger rows.
 */
export async function editBet(
	userId: string,
	betId: string,
	patch: BetPatch,
	options: BetCallOptions = {}
): Promise<Bet> {
	const { now, store, live } = resolveOptions(options);

	// Validate before opening the transaction: a bad field must not cost a lock.
	const nextTargetKind = patch.targetKind === undefined ? null : assertTargetKind(patch.targetKind);
	const nextDeltaPoints =
		patch.deltaPoints === undefined ? null : assertDeltaPoints(patch.deltaPoints);
	const nextStake = patch.stake === undefined ? null : assertStake(patch.stake);
	const targetChanged = nextTargetKind !== null || nextDeltaPoints !== null;

	try {
		return await store.tx(async (t) => {
			// Lock the wallet first: it serializes every money op for this user, so the
			// read-modify-write below cannot race another edit, a cancel or a settle.
			const profile = await t.profiles.lockForUpdate(userId);
			if (!profile) throw new BetError('BET_NOT_FOUND', 'Bet not found.');

			const bet = await t.bets.getBetById(betId);
			// Someone else's bet reads as "not found" — never confirm that an id exists.
			if (!bet || bet.userId !== userId) throw new BetError('BET_NOT_FOUND', 'Bet not found.');
			if (bet.settledAt !== null) {
				throw new BetError('BET_SETTLED', 'That bet is already settled.');
			}

			const session = await t.sessions.getSessionById(bet.sessionId);
			if (!session || session.status !== 'open') {
				throw new BetError('SESSION_CLOSED', 'This session is no longer accepting bets.');
			}
			if (now.getTime() > session.cutoffAt) {
				throw new BetError('CUTOFF_PASSED', 'The 15:20 cutoff has passed.');
			}

			const targetKind = nextTargetKind ?? bet.targetKind;
			const deltaPoints = nextDeltaPoints ?? bet.deltaPoints;
			const stake = nextStake ?? bet.stake;

			// Odds come from the ladder whenever the target moves, so a bet is always
			// priced by today's config, never by whatever the client sent.
			let odds = bet.odds;
			if (targetChanged) {
				const option = await resolveLadderOption(
					session.tradeDate,
					bet.underlying,
					targetKind,
					deltaPoints,
					store,
					live
				);
				if (!option) {
					throw new BetError('INVALID_TARGET', 'That target is not on today’s ladder.', {
						underlying: bet.underlying,
						targetKind,
						deltaPoints
					});
				}
				odds = option.odds;
			}

			// 1. give the old stake back …
			const afterRefund = await t.profiles.applyBalanceDelta(userId, bet.stake);
			await t.ledger.appendLedger({
				userId,
				kind: 'refund',
				amount: bet.stake,
				refBetId: bet.id,
				balanceAfter: afterRefund.balance
			});
			// 2. … then take the new one (INSUFFICIENT_BALANCE aborts everything above).
			const afterCharge = await t.profiles.applyBalanceDelta(userId, -stake);

			// 3. rewrite the position — same row, outcome columns cleared.
			const updated = await t.bets.upsertBet({
				id: bet.id,
				userId,
				sessionId: session.id,
				underlying: bet.underlying,
				targetKind,
				deltaPoints,
				odds,
				stake
			});
			await t.ledger.appendLedger({
				userId,
				kind: 'bet_stake',
				amount: -stake,
				refBetId: bet.id,
				balanceAfter: afterCharge.balance
			});

			// 4. counters move by the difference only.
			const stakedDelta = stake - bet.stake;
			await t.pots.applyPotDelta(session.tradeDate, { totalStaked: stakedDelta });
			await t.stats.applyStatsDelta(userId, { totalStaked: stakedDelta });

			return updated;
		});
	} catch (err: unknown) {
		throw translateDbError(err);
	}
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

/**
 * Cancel a bet before the cutoff: full refund, row deleted, counters reversed.
 * Deleting (rather than flagging) is what frees the index's unique slot so the
 * user can bet it again today; the ledger rows keep the story of the stake and
 * its refund.
 */
export async function cancelBet(
	userId: string,
	betId: string,
	options: BetCallOptions = {}
): Promise<{ refunded: number }> {
	const { now, store } = resolveOptions(options);

	try {
		return await store.tx(async (t) => {
			const profile = await t.profiles.lockForUpdate(userId);
			if (!profile) throw new BetError('BET_NOT_FOUND', 'Bet not found.');

			const bet = await t.bets.getBetById(betId);
			if (!bet || bet.userId !== userId) throw new BetError('BET_NOT_FOUND', 'Bet not found.');
			if (bet.settledAt !== null) {
				throw new BetError('BET_SETTLED', 'That bet is already settled.');
			}

			const session = await t.sessions.getSessionById(bet.sessionId);
			if (!session || session.status !== 'open') {
				throw new BetError('SESSION_CLOSED', 'This session is no longer accepting bets.');
			}
			if (now.getTime() > session.cutoffAt) {
				throw new BetError('CUTOFF_PASSED', 'The 15:20 cutoff has passed.');
			}

			const afterRefund = await t.profiles.applyBalanceDelta(userId, bet.stake);
			await t.ledger.appendLedger({
				userId,
				kind: 'refund',
				amount: bet.stake,
				refBetId: bet.id,
				balanceAfter: afterRefund.balance
			});
			await t.bets.deleteBet(bet.id);

			// players_count means "distinct players with an active bet today", so it only
			// unwinds when this was the user's last one — otherwise a player who cancels
			// one of two legs would be counted twice when they re-bet (the driver's pot
			// bump is "this user had no active bet", see ./db/money).
			const stillHasBets = (await t.bets.getBetsForUserOnDate(userId, session.tradeDate)).some(
				(bet0) => bet0.id !== bet.id
			);
			await t.pots.applyPotDelta(session.tradeDate, {
				totalBets: -1,
				totalStaked: -bet.stake,
				playersCount: stillHasBets ? 0 : -1
			});
			await t.stats.applyStatsDelta(userId, {
				betsPlaced: -1,
				totalStaked: -bet.stake
			});

			return { refunded: bet.stake };
		});
	} catch (err: unknown) {
		throw translateDbError(err);
	}
}
