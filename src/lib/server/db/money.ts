/**
 * Shared money-transaction bodies — one implementation, two drivers.
 *
 * The money paths (T7 placement now, T9 settlement next) are the part of this app
 * where a divergence between the memory and Postgres drivers would be a real bug:
 * tests would pass on the driver they are written against and silently mean
 * nothing for production. So the tx body lives ONCE, here, as a function of a
 * {@link TxStore}, and each driver's `placeBet` is just
 * `this.tx((t) => placeBetInTx(t, input))`.
 *
 * Ordering inside the transaction is not arbitrary:
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
 */
import {
	BetExistsError,
	CutoffPassedError,
	NotFoundError,
	SessionClosedError,
	type TxStore
} from './interface';
import type { Bet, Underlying } from './types';

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
