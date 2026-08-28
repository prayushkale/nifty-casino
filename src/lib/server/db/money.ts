/**
 * Shared money-transaction bodies — one implementation, two drivers.
 *
 * The money paths (T7 placement, T9 settlement) are the part of this app where a
 * divergence between the memory and Postgres drivers would be a real bug: tests
 * would pass on the driver they are written against and silently mean nothing for
 * production. So each tx body lives ONCE, here, as a function of a {@link TxStore},
 * and each driver's method is just `this.tx((t) => xxxInTx(t, input))`.
 *
 * Ordering inside `placeBetInTx` is not arbitrary:
 *
 *   1. session gate      — cheapest first, and the verdict the client cares about
 *   2. wallet lock       — serializes every money op for this user (Postgres
 *                          `SELECT … FOR UPDATE`), which is what makes the
 *                          one-bet-per-index check below race-free
 *   3. stake deduction   — the conditional UPDATE is the balance invariant
 *   4. duplicate check   — inside the lock, so two concurrent submissions cannot
 *                          both see "no bet yet"
 *   5. bet row           — INSERT (never an upsert here: a duplicate is an error,
 *                          not an edit — edits go through the service)
 *   6. ledger            — the audit row for the deduction, stamped with the
 *                          post-deduction balance
 *   7. counters          — deltas, never aggregates (PLAN §3)
 *
 * Any throw after step 3 aborts the whole unit: the deduction, the ledger row and
 * the counter bumps vanish together. There is no partial state to unwind.
 *
 * `settleBetsInTx` runs the same discipline per bet, with one extra rule that has
 * no equivalent in placement: EVERY gate is re-checked inside the transaction, in
 * the order "row → settled_at → payout-once → mark settled → money". A re-run after
 * a crash (or a second scheduler that woke up late) therefore walks out of every
 * bet having either settled it or counted it as skipped — never having paid twice.
 * See the function body for the reasoning gate by gate.
 */
import {
	AlreadySettledError,
	BetExistsError,
	CutoffPassedError,
	NotFoundError,
	SessionClosedError,
	type TxStore
} from './interface';
import type { Bet, SettlementTier, Underlying } from './types';

/** Exactly what `GameStore.placeBet` takes — see ./interface for the contract. */
export type PlaceBetInput = {
	userId: string;
	tradeDate: string;
	underlying: Underlying;
	targetKind: 'up' | 'down';
	/** The round-number move picked, in points. */
	deltaPoints: number;
	/** Resolved from the ladder by the service; the driver never looks it up. */
	odds: number;
	stake: number;
	cutoffAtMs: number;
	nowMs: number;
};

/**
 * Place one bet atomically. See the module doc for the step order and the
 * invariant each step protects.
 */
export async function placeBetInTx(t: TxStore, input: PlaceBetInput): Promise<Bet> {
	// 1. Session gate — server-authoritative, re-derived from the row rather than
	//    trusted from the request. The earlier of the service's cutoff and the
	//    stored one wins: a session whose cutoff was written first may not be
	//    stretched by a later call.
	const session = await t.sessions.getSessionByDate(input.tradeDate);
	if (!session || session.status !== 'open') throw new SessionClosedError(input.tradeDate);
	const cutoffAt = Math.min(input.cutoffAtMs, session.cutoffAt);
	if (input.nowMs > cutoffAt) throw new CutoffPassedError(input.nowMs, cutoffAt);

	// 2+3. Wallet: lock, then deduct. `applyBalanceDelta` refuses to take the
	//      balance below zero and its failure aborts the transaction.
	const profile = await t.profiles.lockForUpdate(input.userId);
	if (!profile) throw new NotFoundError(`profile ${input.userId}`);
	const debited = await t.profiles.applyBalanceDelta(input.userId, -input.stake);

	// 4. One active bet per index per day (PLAN §0). Checked under the wallet lock,
	//    so a double-submit is a BET_EXISTS — counted once in the pots, never twice.
	const mine = await t.bets.getBetsForUserOnDate(input.userId, input.tradeDate);
	const existing = mine.find((bet) => bet.underlying === input.underlying);
	if (existing) throw new BetExistsError(existing.id);
	const isFirstBetOfUserToday = mine.length === 0;

	// 5. The bet row. Odds were resolved from the ladder by the service and are
	//    frozen here for the bet's whole life (history-proof, PLAN §3).
	const bet = await t.bets.upsertBet({
		userId: input.userId,
		sessionId: session.id,
		underlying: input.underlying,
		targetKind: input.targetKind,
		deltaPoints: input.deltaPoints,
		odds: input.odds,
		stake: input.stake
	});

	// 6. Ledger: the signed record of the deduction, with the balance it produced.
	await t.ledger.appendLedger({
		userId: input.userId,
		kind: 'bet_stake',
		amount: -input.stake,
		refBetId: bet.id,
		balanceAfter: debited.balance
	});

	// 7. Counters, in the same unit of work as the write they describe.
	await t.pots.applyPotDelta(input.tradeDate, {
		totalBets: 1,
		totalStaked: input.stake,
		playersCount: isFirstBetOfUserToday ? 1 : 0
	});
	await t.stats.applyStatsDelta(input.userId, {
		betsPlaced: 1,
		totalStaked: input.stake
	});

	return bet;
}

// ---------------------------------------------------------------------------
// T9 — settlement
// ---------------------------------------------------------------------------

/** One bet's settled verdict, as the service hands it to {@link GameStore.settleBets}. */
export type SettleOutcomeInput = {
	betId: string;
	/** Copied from the bet row by the service; re-verified here against the row. */
	userId: string;
	/** Copied from the bet row — a payout must never be computed from stale numbers. */
	stake: number;
	odds: number;
	/** The verdict: `hit` / `flat` / `miss`. (`abstain` never reaches a driver.) */
	tier: SettlementTier;
	/** What the bet credits back: `stake × odds` (hit), `stake` (flat), `0` (miss). */
	payout: number;
};

/** Exactly what `GameStore.settleBets` takes — one chunk of the day's outcomes. */
export type SettleBetsInput = {
	sessionId: number;
	tradeDate: string;
	outcomes: readonly SettleOutcomeInput[];
	/** Instant stamped on every `bets.settled_at` of this chunk. Defaults to now. */
	settledAtMs?: number;
};

/** Per-user roll-up of what ONE call settled — the XP/streak phase's exact input. */
export type SettleBetsUserTally = {
	userId: string;
	/** Bets this call moved from unsettled to settled (any tier). */
	settled: number;
	/** How many of those were hits (the XP_PER_HIT part). */
	hits: number;
	/** Total NC this call credited that user (0 when every bet was a miss). */
	payout: number;
};

export type SettleBetsResult = {
	/** Bets settled by this call. */
	settled: number;
	/** Bets left untouched: already settled, stale, or paid out by an earlier run. */
	skipped: number;
	byUser: SettleBetsUserTally[];
};

/**
 * Settle one chunk of bets atomically. See the module doc for the gate order; the
 * per-bet sequence is:
 *
 *   1. the row still exists, belongs to this session and matches the outcome
 *      (an outcome built from a bet that has since been edited is stale — skipping
 *      beats paying a number computed from numbers that no longer exist)
 *   2. `settled_at` is still NULL — the row itself is the first write-once gate,
 *      and it covers `flat`/`miss`, whose refund is NOT protected by any index
 *   3. for a `hit`, no `payout` ledger row exists yet. This pre-check is what
 *      keeps one already-paid bet from throwing `DuplicatePayoutError` and
 *      rolling back the other 4,999 bets of its chunk; the index behind it is
 *      still the authority (a race that slips past the check aborts the chunk
 *      instead of double-paying)
 *   4. mark settled — {@link BetRepo.setBetOutcome} refuses a second write, so a
 *      bet cannot be marked twice even under a concurrent run
 *   5. the money, under the wallet lock, in the same unit of work as the mark
 *
 * Steps 4 and 5 are one transaction: there is no state in which a bet is marked
 * settled but its credit is missing, which is what makes "did this bet pay?"
 * answerable from a single column.
 */
export async function settleBetsInTx(
	t: TxStore,
	input: SettleBetsInput
): Promise<SettleBetsResult> {
	const settledAt = input.settledAtMs ?? Date.now();
	let settled = 0;
	let skipped = 0;
	const byUser = new Map<string, SettleBetsUserTally>();

	for (const outcome of input.outcomes) {
		// 1. The row is the truth; the outcome is only a verdict about it.
		const bet = await t.bets.getBetById(outcome.betId);
		if (!bet || bet.sessionId !== input.sessionId) {
			skipped += 1;
			continue;
		}
		if (bet.userId !== outcome.userId || bet.stake !== outcome.stake || bet.odds !== outcome.odds) {
			skipped += 1;
			continue;
		}

		// 2. First write-once gate. A miss pays nothing and a flat only refunds, so
		//    for those two this row check is the ONLY thing standing between a
		//    re-run and a second refund.
		if (bet.settledAt !== null) {
			skipped += 1;
			continue;
		}

		// 3. Payout-once pre-check (see the doc: chunk-safety, not correctness).
		if (outcome.tier === 'hit' && (await t.ledger.hasPayoutForBet(bet.id))) {
			skipped += 1;
			continue;
		}

		// 4. Mark settled — throws AlreadySettledError if a concurrent run won the row.
		try {
			await t.bets.setBetOutcome(bet.id, outcome.tier, outcome.payout, settledAt);
		} catch (err: unknown) {
			if (err instanceof AlreadySettledError) {
				skipped += 1;
				continue;
			}
			throw err;
		}

		// 5. The money. A miss credits nothing and writes no ledger row at all — the
		//    stake left the wallet at placement, and inventing a zero row would make
		//    sum(ledger) lie about the wallet.
		if (outcome.payout > 0) {
			const locked = await t.profiles.lockForUpdate(bet.userId);
			if (!locked) throw new NotFoundError(`profile ${bet.userId}`);
			const credited = await t.profiles.applyBalanceDelta(bet.userId, outcome.payout);
			await t.ledger.appendLedger({
				userId: bet.userId,
				kind: outcome.tier === 'hit' ? 'payout' : 'refund',
				amount: outcome.payout,
				refBetId: bet.id,
				balanceAfter: credited.balance
			});
			// Counters move in the same unit of work as the money they describe
			// (PLAN §3). `total_paid_out` is "NC returned to players", so a flat's
			// refund counts — that keeps pots.total_paid_out === Σ bets.payout exact.
			await t.pots.applyPotDelta(input.tradeDate, { totalPaidOut: outcome.payout });
			await t.stats.applyStatsDelta(bet.userId, {
				betsWon: outcome.tier === 'hit' ? 1 : 0,
				totalWon: outcome.payout,
				bestPayout: outcome.payout
			});
		}

		settled += 1;
		const tally = byUser.get(bet.userId) ?? { userId: bet.userId, settled: 0, hits: 0, payout: 0 };
		tally.settled += 1;
		if (outcome.tier === 'hit') tally.hits += 1;
		tally.payout += outcome.payout;
		byUser.set(bet.userId, tally);
	}

	return { settled, skipped, byUser: [...byUser.values()] };
}
