/**
 * `placeBet` — the driver-level money path (PLAN §5 T7), run against BOTH drivers.
 *
 * The memory driver always runs; the Postgres driver runs the same table behind
 * `describe.skipIf(!DATABASE_URL)`, exactly like ./postgres.test.ts. One table,
 * two drivers, is the point: a divergence here would be a money bug that only
 * production could see.
 *
 * `placeBet` is deliberately dumb — it validates the session and the wallet and
 * nothing else. The service layer (`$lib/server/bets.test.ts`) owns windows,
 * weekends, stakes and the ladder.
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
import type { DailyPot, UserStats } from './types';

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

moneySuite('memory driver', memoryHarness);
describe.skipIf(!databaseUrl)('PostgresStore (integration)', () => {
	moneySuite('postgres driver', postgresHarness);
});
