/**
 * `placeBet` / `settleBets` — the driver-level money paths (PLAN §5 T7/T9), run
 * against BOTH drivers.
 *
 * The memory driver always runs; the Postgres driver runs the same table behind
 * `describe.skipIf(!DATABASE_URL)`, exactly like ./postgres.test.ts. One table,
 * two drivers, is the point: a divergence here would be a money bug that only
 * production could see.
 *
 * Both methods are deliberately dumb — they move money and refuse to move it
 * twice. Windows, weekends, stakes and the odds belong to the service layer
 * (`$lib/server/bets`); which tier a bet lands in belongs to
 * (`$lib/server/settle`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
	BetExistsError,
	CutoffPassedError,
	InsufficientFundsError,
	NotFoundError,
	SessionClosedError,
	type GameStore
} from './interface';
import { MemoryStore } from './memory';
import { PostgresStore } from './postgres';
import { SIGNUP_BONUS } from '$lib/config/app';
import type { Bet, DailyPot, SettlementTier, Underlying, UserStats } from './types';
import type { SettleOutcomeInput } from './money';

// ---------------------------------------------------------------------------
// the table, parameterised by driver
// ---------------------------------------------------------------------------

type Harness = {
	store: GameStore;
	tradeDate: string;
	cutoffAtMs: number;
	seedUser(userId: string, balance: number): Promise<void>;
	dispose(): Promise<void>;
};

/** A throwaway date no one will ever trade on — keeps the integration run isolated. */
const PG_DATE = '2099-12-30';
const PG_USER = '00000000-0000-4000-8000-00000000d0c2';
const databaseUrl = process.env['DATABASE_URL']?.trim();

/** The cutoff, as 15:20:00 IST of `tradeDate` (09:50:00Z — IST is UTC+5:30). */
const cutoffOf = (tradeDate: string): number => Date.parse(`${tradeDate}T09:50:00.000Z`);

async function memoryHarness(): Promise<Harness> {
	const tradeDate = '2026-08-27';
	const store = new MemoryStore();
	return {
		store,
		tradeDate,
		cutoffAtMs: cutoffOf(tradeDate),
		seedUser: async (userId, balance) => {
			await store.profiles.insertProfile({
				userId,
				handle: `u_${userId}`,
				email: `${userId}@test.dev`,
				balance
			});
		},
		dispose: async () => {
			await store.close();
		}
	};
}

async function postgresHarness(): Promise<Harness> {
	const store = new PostgresStore(databaseUrl as string);
	const sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
	return {
		store,
		tradeDate: PG_DATE,
		cutoffAtMs: cutoffOf(PG_DATE),
		seedUser: async (userId, balance) => {
			await store.profiles.insertProfile({
				userId,
				handle: `pg_money_${userId.slice(-4)}`,
				email: 'pg-money@example.com',
				balance
			});
		},
		// Throwaway keys only: a fixed test uuid and a date nobody trades.
		dispose: async () => {
			await sql`delete from ledger where user_id = ${PG_USER}`;
			await sql`delete from bets where user_id = ${PG_USER}`;
			await sql`delete from user_stats where user_id = ${PG_USER}`;
			await sql`delete from daily_pots where trade_date = ${PG_DATE}`;
			await sql`delete from daily_sessions where trade_date = ${PG_DATE}`;
			await sql`delete from profiles where user_id = ${PG_USER}`;
			await sql.end({ timeout: 5 });
			await store.close();
		}
	};
}

/** Register the whole behaviour table for one driver. */
function moneySuite(label: string, makeHarness: () => Promise<Harness>): void {
	describe(`placeBet — ${label}`, () => {
		const A = '00000000-0000-4000-8000-00000000a001';
		const B = '00000000-0000-4000-8000-00000000b002';
		const STAKE = 100;

		let h: Harness;
		let store: GameStore;
		beforeEach(async () => {
			h = await makeHarness();
			store = h.store;
			await h.seedUser(A, 1000);
			await h.seedUser(B, 0);
			await store.sessions.ensureSession(h.tradeDate, h.cutoffAtMs);
		});

		const place = (
			userId: string = A,
			stake = STAKE,
			over: Partial<Parameters<GameStore['placeBet']>[0]> = {},
			nowMs = h.cutoffAtMs
		): ReturnType<GameStore['placeBet']> =>
			store.placeBet({
				userId,
				tradeDate: h.tradeDate,
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake,
				cutoffAtMs: h.cutoffAtMs,
				nowMs,
				...over
			});

		const sessionId = async (): Promise<number> =>
			(await store.sessions.getSessionByDate(h.tradeDate))?.id ?? 0;
		const betsInSession = async (): Promise<number> =>
			(await store.bets.listBetsForSession(await sessionId())).length;
		const pot = (): Promise<DailyPot | null> => store.pots.getDailyPot(h.tradeDate);
		const stats = (userId = A): Promise<UserStats> => store.stats.getUserStats(userId);
		const ledgerSum = async (userId = A): Promise<number> =>
			(await store.ledger.getLedgerForUser(userId)).reduce((acc, row) => acc + row.amount, 0);

		it('deducts the stake and leaves one ledger row, one pot bet and one stat', async () => {
			const bet = await place();

			expect((await store.profiles.getProfile(A))?.balance).toBe(1000 - STAKE);
			expect(bet.odds).toBe(6);
			expect(bet.stake).toBe(STAKE);
			expect(bet.settledAt).toBeNull();

			const rows = await store.ledger.getLedgerForUser(A);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ kind: 'bet_stake', amount: -STAKE, balanceAfter: 900 });
			expect(rows[0].balanceAfter).toBe((await store.profiles.getProfile(A))?.balance);

			expect(await pot()).toMatchObject({ totalBets: 1, totalStaked: STAKE, playersCount: 1 });
			expect(await stats()).toMatchObject({ betsPlaced: 1, totalStaked: STAKE });
		});

		it('stores the odds it was handed — frozen at bet time, whatever the ladder does later', async () => {
			const bet = await place(A, STAKE, { odds: 4.5, deltaPoints: 100 });
			expect((await store.bets.getBetById(bet.id))?.odds).toBe(4.5);
		});

		it('accepts nowMs === cutoffAtMs (the cutoff is inclusive)', async () => {
			const bet = await place(A, STAKE, {}, h.cutoffAtMs);
			expect(bet.id).toBeTruthy();
		});

		it('rejects nowMs one millisecond past the cutoff and writes nothing', async () => {
			const before = await betsInSession();
			await expect(place(A, STAKE, {}, h.cutoffAtMs + 1)).rejects.toBeInstanceOf(CutoffPassedError);
			expect(await betsInSession()).toBe(before);
			expect((await store.profiles.getProfile(A))?.balance).toBe(1000);
			expect(await ledgerSum(A)).toBe(0);
			expect((await pot())?.totalStaked ?? 0).toBe(0);
			expect((await stats()).betsPlaced).toBe(0);
		});

		it('refuses a session that is no longer open — the row decides, not the caller', async () => {
			const session = await store.sessions.getSessionByDate(h.tradeDate);
			await store.sessions.setSessionStatus(session?.id ?? 0, 'locked');
			await expect(place(A)).rejects.toBeInstanceOf(SessionClosedError);
			expect(await betsInSession()).toBe(0);
		});

		it('refuses a day with no session row at all', async () => {
			await expect(
				store.placeBet({
					userId: A,
					tradeDate: '2020-01-01',
					underlying: 'nifty',
					targetKind: 'up',
					deltaPoints: 50,
					odds: 6,
					stake: STAKE,
					cutoffAtMs: cutoffOf('2020-01-01'),
					nowMs: cutoffOf('2020-01-01')
				})
			).rejects.toBeInstanceOf(SessionClosedError);
		});

		it('refuses to overdraw the wallet, and rolls the whole unit back', async () => {
			const before = await betsInSession();
			await expect(place(B, 1)).rejects.toBeInstanceOf(InsufficientFundsError);

			// Nothing changed anywhere: no bet, no ledger row, no counter, no balance.
			expect((await store.profiles.getProfile(B))?.balance).toBe(0);
			expect(await betsInSession()).toBe(before);
			expect(await ledgerSum(B)).toBe(0);
			expect((await pot())?.totalStaked ?? 0).toBe(0);
			expect((await stats(B)).betsPlaced).toBe(0);
		});

		it('answers a double-submit with BET_EXISTS and the existing id, and counts it once', async () => {
			const first = await place(A, STAKE);
			await expect(place(A, 250)).rejects.toBeInstanceOf(BetExistsError);

			// The pot saw one bet, one stake, one player — not the retry's numbers.
			expect(await pot()).toMatchObject({ totalBets: 1, totalStaked: STAKE, playersCount: 1 });
			expect((await store.profiles.getProfile(A))?.balance).toBe(1000 - STAKE);
			expect(await store.ledger.getLedgerForUser(A)).toHaveLength(1);

			const second = await place(A, STAKE, { underlying: 'sensex', deltaPoints: 250 });
			expect(second.id).not.toBe(first.id); // a different index is a different bet
			expect(await pot()).toMatchObject({ totalBets: 2, totalStaked: 2 * STAKE, playersCount: 1 });
		});

		it('counts a player once no matter how many indices they bet', async () => {
			await place(A, STAKE, { underlying: 'nifty' });
			await place(A, STAKE, { underlying: 'banknifty', deltaPoints: 200, odds: 4.5 });
			await place(A, STAKE, { underlying: 'sensex', deltaPoints: 250, odds: 4.5 });
			// B starts at zero on purpose: fund the wallet, then bet two indices.
			await store.profiles.applyBalanceDelta(B, 100);
			await place(B, 10, { underlying: 'nifty' });
			await place(B, 10, { underlying: 'banknifty', deltaPoints: 200, odds: 4.5 });

			const bets = await store.bets.listBetsForSession(await sessionId());
			expect(bets).toHaveLength(5);

			const day = await pot();
			expect(day?.totalStaked).toBe(bets.reduce((acc, bet) => acc + bet.stake, 0));
			expect(day?.playersCount).toBe(new Set(bets.map((bet) => bet.userId)).size);
			expect(day?.totalBets).toBe(bets.length);
		});

		it('keeps the PLAN §8 launch-gate invariant: sum(ledger) === balance − signup bonus', async () => {
			await place(A, STAKE);
			await place(A, STAKE, { underlying: 'banknifty', deltaPoints: 200, odds: 4.5 });

			const balance = (await store.profiles.getProfile(A))?.balance ?? 0;
			expect(await ledgerSum(A)).toBe(balance - SIGNUP_BONUS);
		});

		it('refuses a wallet that does not exist', async () => {
			await expect(place('00000000-0000-4000-8000-00000000dead')).rejects.toBeInstanceOf(
				NotFoundError
			);
		});

		it('deleteBet frees the index slot, so the same index can be bet again', async () => {
			const bet = await place(A, STAKE);
			await store.bets.deleteBet(bet.id);
			expect(await store.bets.getBetById(bet.id)).toBeNull();

			const again = await place(A, STAKE); // would be BET_EXISTS without the delete
			expect(again.id).not.toBe(bet.id);
			expect(await pot()).toMatchObject({ totalBets: 2, totalStaked: 2 * STAKE });
		});
	});
}

/**
 * Register the `settleBets` behaviour table for one driver. The tier/payout
 * decisions were made upstream; what this table pins is that money moves once and
 * only once, on either driver.
 */
function settleBetsSuite(label: string, makeHarness: () => Promise<Harness>): void {
	describe(`settleBets — ${label}`, () => {
		const A = '00000000-0000-4000-8000-00000000a101';
		const B = '00000000-0000-4000-8000-00000000b202';
		const STAKE = 100;

		let h: Harness;
		let store: GameStore;
		beforeEach(async () => {
			h = await makeHarness();
			store = h.store;
			await h.seedUser(A, SIGNUP_BONUS);
			await h.seedUser(B, SIGNUP_BONUS);
			await store.sessions.ensureSession(h.tradeDate, h.cutoffAtMs);
			// One bet per tier for A, one hit for B.
			await place(A, 'nifty', 6); // → hit
			await place(A, 'banknifty', 4.5); // → flat
			await place(A, 'sensex', 3.2); // → miss
			await place(B, 'nifty', 6); // → hit
		});

		const place = (
			userId: string,
			underlying: Underlying,
			odds: number,
			stake = STAKE
		): Promise<Bet> =>
			store.placeBet({
				userId,
				tradeDate: h.tradeDate,
				underlying,
				targetKind: 'up',
				deltaPoints: 50,
				odds,
				stake,
				cutoffAtMs: h.cutoffAtMs,
				nowMs: h.cutoffAtMs
			});

		const sessionId = async (): Promise<number> =>
			(await store.sessions.getSessionByDate(h.tradeDate))?.id ?? 0;

		/** The bet ids, keyed by the tier the service would have computed. */
		const ids = async (): Promise<{ hit: string; flat: string; miss: string; bHit: string }> => {
			const bets = await store.bets.listBetsForSession(await sessionId());
			const byUnderlying = new Map(bets.map((bet) => [`${bet.userId}:${bet.underlying}`, bet]));
			return {
				hit: byUnderlying.get(`${A}:nifty`)!.id,
				flat: byUnderlying.get(`${A}:banknifty`)!.id,
				miss: byUnderlying.get(`${A}:sensex`)!.id,
				bHit: byUnderlying.get(`${B}:nifty`)!.id
			};
		};

		const outcome = async (
			betId: string,
			tier: SettlementTier,
			payout: number
		): Promise<SettleOutcomeInput> => {
			const bet = await store.bets.getBetById(betId);
			return { betId, userId: bet!.userId, stake: bet!.stake, odds: bet!.odds, tier, payout };
		};

		const ledgerSum = async (userId = A): Promise<number> =>
			(await store.ledger.getLedgerForUser(userId)).reduce((total, row) => total + row.amount, 0);

		it('marks a hit settled, credits the wallet and writes one payout ledger row', async () => {
			const { hit } = await ids();
			const result = await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [await outcome(hit, 'hit', 600)]
			});

			expect(result.settled).toBe(1);
			expect(result.skipped).toBe(0);
			expect(result.byUser).toEqual([{ userId: A, settled: 1, hits: 1, payout: 600 }]);
			expect(await store.bets.getBetById(hit)).toMatchObject({
				settlementTier: 'hit',
				payout: 600,
				settledAt: expect.any(Number)
			});
			// 1000 − 300 of stakes (three bets) + 600 back
			expect((await store.profiles.getProfile(A))?.balance).toBe(SIGNUP_BONUS - 3 * STAKE + 600);
			expect(await ledgerSum(A)).toBe(-3 * STAKE + 600);
			const payoutRow = (await store.ledger.getLedgerForUser(A)).find(
				(row) => row.kind === 'payout'
			);
			expect(payoutRow).toMatchObject({
				amount: 600,
				refBetId: hit,
				balanceAfter: SIGNUP_BONUS - 3 * STAKE + 600
			});
			expect(await store.pots.getDailyPot(h.tradeDate)).toMatchObject({ totalPaidOut: 600 });
			expect(await store.stats.getUserStats(A)).toMatchObject({
				betsWon: 1,
				totalWon: 600,
				bestPayout: 600
			});
		});

		it('refunds a flat, and pays nothing at all for a miss', async () => {
			const { flat, miss } = await ids();
			await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [await outcome(flat, 'flat', STAKE), await outcome(miss, 'miss', 0)]
			});

			expect(await store.bets.getBetById(flat)).toMatchObject({
				settlementTier: 'flat',
				payout: STAKE
			});
			expect(await store.bets.getBetById(miss)).toMatchObject({
				settlementTier: 'miss',
				payout: 0
			});
			// −300 staked, +100 refunded for the flat; the miss's stake is simply gone.
			expect((await store.profiles.getProfile(A))?.balance).toBe(SIGNUP_BONUS - 2 * STAKE);
			const rows = await store.ledger.getLedgerForUser(A);
			expect(rows.filter((row) => row.kind === 'refund')).toHaveLength(1);
			expect(rows.filter((row) => row.kind === 'payout')).toHaveLength(0);
			// A miss writes no ledger row at all — the stake row from placement is all there is.
			expect(rows.filter((row) => row.refBetId === miss)).toHaveLength(1);
			expect(await store.pots.getDailyPot(h.tradeDate)).toMatchObject({ totalPaidOut: STAKE });
			// A refund is not a win: best_payout does move, bets_won does not.
			expect(await store.stats.getUserStats(A)).toMatchObject({ betsWon: 0, totalWon: STAKE });
		});

		it('settles a mixed chunk in one transaction', async () => {
			const { hit, flat, miss, bHit } = await ids();
			const result = await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [
					await outcome(hit, 'hit', 600),
					await outcome(flat, 'flat', STAKE),
					await outcome(miss, 'miss', 0),
					await outcome(bHit, 'hit', 300)
				]
			});

			expect(result.settled).toBe(4);
			expect(result.byUser).toEqual([
				{ userId: A, settled: 3, hits: 1, payout: 700 },
				{ userId: B, settled: 1, hits: 1, payout: 300 }
			]);
			expect((await store.profiles.getProfile(A))?.balance).toBe(SIGNUP_BONUS - 3 * STAKE + 700);
			expect((await store.profiles.getProfile(B))?.balance).toBe(SIGNUP_BONUS - STAKE + 300);
			expect(await store.pots.getDailyPot(h.tradeDate)).toMatchObject({ totalPaidOut: 1_000 });
		});

		it('is a numerical no-op when the same outcomes are sent again', async () => {
			const { hit, flat, miss, bHit } = await ids();
			const outcomes = [
				await outcome(hit, 'hit', 600),
				await outcome(flat, 'flat', STAKE),
				await outcome(miss, 'miss', 0),
				await outcome(bHit, 'hit', 300)
			];
			await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes
			});
			const balances = await Promise.all([A, B].map(async (u) => store.profiles.getProfile(u)));
			const pot = await store.pots.getDailyPot(h.tradeDate);
			const stats = await store.stats.getUserStats(A);
			const ledgerRows = await store.ledger.getLedgerForUser(A);

			const again = await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes
			});

			expect(again).toEqual({ settled: 0, skipped: 4, byUser: [] });
			expect(await Promise.all([A, B].map(async (u) => store.profiles.getProfile(u)))).toEqual(
				balances
			);
			expect(await store.pots.getDailyPot(h.tradeDate)).toEqual(pot);
			expect(await store.stats.getUserStats(A)).toEqual(stats);
			expect(await store.ledger.getLedgerForUser(A)).toEqual(ledgerRows);
		});

		it('refuses to pay a bet that already has a payout row but no settled_at', async () => {
			// The state a crash between two statements would have left, had settlement
			// not been a single transaction. The payout-once index is the backstop.
			const { hit } = await ids();
			await store.tx(async (t) => {
				await t.ledger.appendLedger({
					userId: A,
					kind: 'payout',
					amount: 600,
					refBetId: hit,
					balanceAfter: SIGNUP_BONUS - 3 * STAKE + 600
				});
			});

			const result = await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [await outcome(hit, 'hit', 600)]
			});

			expect(result.settled).toBe(0);
			expect(result.skipped).toBe(1);
			expect((await store.profiles.getProfile(A))?.balance).toBe(SIGNUP_BONUS - 3 * STAKE);
		});

		it('skips outcomes that do not match the row they describe', async () => {
			const { hit } = await ids();
			const result = await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [
					{ betId: hit, userId: A, stake: 999, odds: 6, tier: 'hit', payout: 9_999 },
					{
						betId: '00000000-0000-4000-8000-00000000nope',
						userId: A,
						stake: 1,
						odds: 6,
						tier: 'hit',
						payout: 6
					}
				]
			});

			expect(result.settled).toBe(0);
			expect(result.skipped).toBe(2);
			expect((await store.profiles.getProfile(A))?.balance).toBe(SIGNUP_BONUS - 3 * STAKE);
		});

		it('skips outcomes belonging to another session', async () => {
			const { hit } = await ids();
			const result = await store.settleBets({
				sessionId: (await sessionId()) + 999_999,
				tradeDate: h.tradeDate,
				outcomes: [await outcome(hit, 'hit', 600)]
			});

			expect(result).toEqual({ settled: 0, skipped: 1, byUser: [] });
			expect((await store.bets.getBetById(hit))?.settledAt).toBeNull();
		});

		it('keeps the PLAN §8 launch-gate invariant across a settled day', async () => {
			const { hit, flat, miss, bHit } = await ids();
			await store.settleBets({
				sessionId: await sessionId(),
				tradeDate: h.tradeDate,
				outcomes: [
					await outcome(hit, 'hit', 600),
					await outcome(flat, 'flat', STAKE),
					await outcome(miss, 'miss', 0),
					await outcome(bHit, 'hit', 300)
				]
			});

			for (const userId of [A, B]) {
				const balance = (await store.profiles.getProfile(userId))?.balance ?? 0;
				expect(await ledgerSum(userId)).toBe(balance - SIGNUP_BONUS);
			}
		});
	});
}

moneySuite('memory driver', memoryHarness);
settleBetsSuite('memory driver', memoryHarness);
describe.skipIf(!databaseUrl)('PostgresStore (integration)', () => {
	moneySuite('postgres driver', postgresHarness);
	settleBetsSuite('postgres driver', postgresHarness);
});
