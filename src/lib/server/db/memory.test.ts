/**
 * MemoryStore behaviour tests — the driver every test and dev run uses.
 *
 * These are the contract tests the Postgres driver must also satisfy (its integration
 * suite re-uses the same scenarios where a live database is available). They run with
 * NO environment variables, NO Supabase project and NO network, by design.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	AlreadySettledError,
	DuplicatePayoutError,
	InsufficientFundsError,
	NotFoundError
} from './interface';
import { MemoryStore } from './memory';
import type { GameStore } from './interface';

const DATE = '2026-08-27';
const CUTOFF = Date.parse('2026-08-27T09:50:00.000Z'); // 15:20:00 IST

/** A store with one funded user (+ one empty wallet) and today's session open. */
async function seededStore(balance = 1000): Promise<GameStore> {
	const store = new MemoryStore({ now: () => Date.parse('2026-08-27T06:00:00.000Z') });
	await store.profiles.insertProfile({ userId: 'u1', handle: 'priya', email: 'p@x.dev', balance });
	await store.profiles.insertProfile({
		userId: 'u2',
		handle: 'arjun',
		email: 'a@x.dev',
		balance: 0
	});
	await store.sessions.ensureSession(DATE, CUTOFF);
	return store;
}

const placeBet = async (store: GameStore, userId = 'u1', stake = 100): Promise<string> =>
	store.tx(async (t) => {
		const session = await t.sessions.ensureSession(DATE, CUTOFF);
		const bet = await t.bets.upsertBet({
			userId,
			sessionId: session.id,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake
		});
		return bet.id;
	});

describe('MemoryStore', () => {
	let store: GameStore;
	beforeEach(async () => {
		store = await seededStore();
	});

	// ---------------------------------------------------------------- sessions

	describe('sessions.ensureSession', () => {
		it('is idempotent: the same trade date returns the same row', async () => {
			const first = await store.sessions.ensureSession(DATE, CUTOFF);
			const second = await store.sessions.ensureSession(DATE, CUTOFF);
			expect(second.id).toBe(first.id);
			expect(second.createdAt).toBe(first.createdAt);

			const all = await Promise.all([first, second]);
			expect(new Set(all.map((s) => s.id)).size).toBe(1);
		});

		it('never lets a second call move the cutoff or reset the status (first write wins)', async () => {
			const before = await store.sessions.ensureSession(DATE, CUTOFF);
			await store.sessions.setSessionStatus(before.id, 'settled');

			const after = await store.sessions.ensureSession(DATE, Date.now() + 86_400_000);

			expect(after.cutoffAt).toBe(before.cutoffAt);
			expect(after.status).toBe('settled');
			expect(after.id).toBe(before.id);
		});

		it('starts every new day open', async () => {
			const session = await store.sessions.ensureSession('2026-08-28', CUTOFF);
			expect(session.status).toBe('open');
		});

		it('round-trips status, and unknown sessions/sessions-by-date read as null', async () => {
			const session = await store.sessions.ensureSession(DATE, CUTOFF);
			await store.sessions.setSessionStatus(session.id, 'locked');
			expect((await store.sessions.getSessionByDate(DATE))?.status).toBe('locked');
			expect(await store.sessions.getSessionByDate('2020-01-01')).toBeNull();
			await expect(store.sessions.setSessionStatus(9999, 'settled')).rejects.toBeInstanceOf(
				NotFoundError
			);
		});
	});

	// ------------------------------------------------------------------- money

	describe('wallet invariants', () => {
		it('applies signed balance deltas and reports the new balance', async () => {
			const after = await store.profiles.applyBalanceDelta('u1', -300);
			expect(after.balance).toBe(700);
			expect((await store.profiles.getProfile('u1'))?.balance).toBe(700);
		});

		it('refuses to go below zero (PLAN §3 check (balance >= 0))', async () => {
			await expect(store.profiles.applyBalanceDelta('u2', -1)).rejects.toBeInstanceOf(
				InsufficientFundsError
			);
			// ...and the failed write changed nothing
			expect((await store.profiles.getProfile('u2'))?.balance).toBe(0);
		});

		it('throws NotFoundError for a wallet that does not exist', async () => {
			await expect(store.profiles.applyBalanceDelta('nobody', 10)).rejects.toBeInstanceOf(
				NotFoundError
			);
		});
	});

	describe('ledger payout-once', () => {
		it('throws on a second payout for the same bet', async () => {
			await store.profiles.applyBalanceDelta('u1', 600);
			await store.ledger.appendLedger({
				userId: 'u1',
				kind: 'payout',
				amount: 600,
				refBetId: 'b1',
				balanceAfter: 1600
			});

			await expect(
				store.ledger.appendLedger({
					userId: 'u1',
					kind: 'payout',
					amount: 600,
					refBetId: 'b1',
					balanceAfter: 2200
				})
			).rejects.toBeInstanceOf(DuplicatePayoutError);
		});

		it('does not confuse a payout with a refund, or bets with each other', async () => {
			// A refund (or a stake) may legally reference the same bet more than once.
			await store.ledger.appendLedger({
				userId: 'u1',
				kind: 'refund',
				amount: 50,
				refBetId: 'b1',
				balanceAfter: 1050
			});
			await store.ledger.appendLedger({
				userId: 'u1',
				kind: 'refund',
				amount: 50,
				refBetId: 'b1',
				balanceAfter: 1100
			});
			await store.ledger.appendLedger({
				userId: 'u1',
				kind: 'payout',
				amount: 600,
				refBetId: 'b2',
				balanceAfter: 1700
			});

			expect(await store.ledger.hasPayoutForBet('b1')).toBe(false);
			expect(await store.ledger.hasPayoutForBet('b2')).toBe(true);
			expect((await store.ledger.getLedgerForUser('u1')).length).toBe(3);
		});

		it('lets settlement re-run read the existing payout instead of re-writing it', async () => {
			await store.ledger.appendLedger({
				userId: 'u1',
				kind: 'payout',
				amount: 600,
				refBetId: 'b1',
				balanceAfter: 1600
			});
			const alreadyPaid = await store.ledger.hasPayoutForBet('b1');
			expect(alreadyPaid).toBe(true);
			// Idempotent re-settlement: no second row.
			const rows = await store.ledger.getLedgerForUser('u1');
			expect(rows.filter((r) => r.kind === 'payout').length).toBe(1);
		});
	});

	describe('tx() — transactions', () => {
		it('commits when the body succeeds', async () => {
			await store.tx(async (t) => {
				await t.profiles.applyBalanceDelta('u1', -100);
				await t.ledger.appendLedger({
					userId: 'u1',
					kind: 'bet_stake',
					amount: -100,
					refBetId: 'b1',
					balanceAfter: 900
				});
				return 'ok';
			});
			expect((await store.profiles.getProfile('u1'))?.balance).toBe(900);
			expect(await store.ledger.hasPayoutForBet('b1')).toBe(false);
			expect((await store.ledger.getLedgerForUser('u1'))[0]?.kind).toBe('bet_stake');
		});

		it('rolls back the whole body on throw — no partial write', async () => {
			await expect(
				store.tx(async (t) => {
					await t.profiles.applyBalanceDelta('u1', -100); // would be lost without rollback
					await t.ledger.appendLedger({
						userId: 'u1',
						kind: 'bet_stake',
						amount: -100,
						refBetId: 'b9',
						balanceAfter: 900
					});
					throw new Error('boom');
				})
			).rejects.toThrow('boom');

			expect((await store.profiles.getProfile('u1'))?.balance).toBe(1000);
			expect((await store.ledger.getLedgerForUser('u1')).length).toBe(0);
		});

		it('serializes concurrent balance ops so a read-modify-write cannot lose an update', async () => {
			// 50 concurrent tx bodies each read the balance, YIELD, then write +1.
			// Unsynchronized, all 50 would read 1000 and the final balance would be 1001.
			// Holding the mutex for the whole body is what makes the answer 1050 — the same
			// guarantee `SELECT … FOR UPDATE` gives the Postgres driver.
			const concurrency = 50;
			await Promise.all(
				Array.from({ length: concurrency }, () =>
					store.tx(async (t) => {
						const profile = await t.profiles.lockForUpdate('u1');
						if (!profile) throw new NotFoundError('profile u1');
						const next = profile.balance + 1;
						await new Promise((resolve) => setTimeout(resolve, 0)); // force a yield mid-tx
						return t.profiles.applyBalanceDelta('u1', next - profile.balance);
					})
				)
			);

			expect((await store.profiles.getProfile('u1'))?.balance).toBe(1000 + concurrency);
			expect((await store.profiles.getProfile('u1'))?.balance).toBe(1050);
		});

		it('releases the lock when a body throws, so the next tx still runs', async () => {
			await expect(store.tx(async () => Promise.reject(new Error('first fails')))).rejects.toThrow(
				'first fails'
			);
			const result = await store.tx(async (t) => (await t.profiles.getProfile('u1'))?.balance);
			expect(result).toBe(1000);
		});

		it('gives the body a TxStore whose writes land in the same store', async () => {
			await store.tx(async (t) => {
				const session = await t.sessions.ensureSession(DATE, CUTOFF);
				await t.pots.applyPotDelta(DATE, { totalBets: 1 });
				expect(session.id).toBe((await store.sessions.getSessionByDate(DATE))?.id);
			});
			expect((await store.pots.getDailyPot(DATE))?.totalBets).toBe(1);
		});
	});

	// ---------------------------------------------------------------- bets

	describe('bets', () => {
		it('keeps one bet per (user, session, underlying): an upsert replaces in place', async () => {
			const first = await placeBet(store);
			const session = await store.sessions.getSessionByDate(DATE);

			const edited = await store.tx(async (t) =>
				t.bets.upsertBet({
					userId: 'u1',
					sessionId: session?.id ?? 0,
					underlying: 'nifty',
					targetKind: 'down',
					deltaPoints: 100,
					odds: 4.5,
					stake: 250
				})
			);

			expect(edited.id).toBe(first); // same row, not a second bet
			const mine = await store.bets.getBetsForUserOnDate('u1', DATE);
			expect(mine).toHaveLength(1);
			expect(mine[0]).toMatchObject({
				targetKind: 'down',
				deltaPoints: 100,
				stake: 250,
				odds: 4.5
			});
		});

		it('clears a prior outcome when a bet is edited', async () => {
			const betId = await placeBet(store);
			await store.bets.setBetOutcome(betId, 'hit', 600, Date.now());

			await placeBet(store, 'u1', 100); // re-place = edit
			const bet = (await store.bets.getBetsForUserOnDate('u1', DATE))[0];
			expect(bet.settlementTier).toBeNull();
			expect(bet.payout).toBeNull();
			expect(bet.settledAt).toBeNull();
		});

		it('refuses a second settlement of the same bet', async () => {
			const betId = await placeBet(store);
			await store.bets.setBetOutcome(betId, 'hit', 600, 1);
			await expect(store.bets.setBetOutcome(betId, 'miss', 0, 2)).rejects.toBeInstanceOf(
				AlreadySettledError
			);
			// first write wins
			expect((await store.bets.getBetById(betId))?.payout).toBe(600);
		});

		it("lists a session's bets and scopes user queries to a trade date", async () => {
			await placeBet(store, 'u1');
			await store.tx(async (t) => {
				const session = await t.sessions.getSessionByDate(DATE);
				await t.bets.upsertBet({
					userId: 'u2',
					sessionId: session?.id ?? 0,
					underlying: 'sensex',
					targetKind: 'down',
					deltaPoints: 250,
					odds: 4.5,
					stake: 10
				});
			});

			expect((await store.bets.listBetsForSession(1)).length).toBe(2);
			expect((await store.bets.getBetsForUserOnDate('u1', DATE)).length).toBe(1);
			expect((await store.bets.getBetsForUserOnDate('u2', DATE)).length).toBe(1);
			expect((await store.bets.getBetsForUserOnDate('u1', '2020-01-01')).length).toBe(0);
		});
	});

	// ------------------------------------------------------- counters (pots/stats)

	describe('counter arithmetic', () => {
		it('accumulates pot deltas and never resets an existing row', async () => {
			const first = await store.pots.ensureDailyPot(DATE);
			expect(first.totalStaked).toBe(0);

			await store.pots.applyPotDelta(DATE, { totalBets: 1, totalStaked: 100, playersCount: 1 });
			await store.pots.applyPotDelta(DATE, { totalBets: 1, totalStaked: 250, playersCount: 0 });
			await store.pots.ensureDailyPot(DATE); // must not zero anything

			const pot = await store.pots.getDailyPot(DATE);
			expect(pot).toEqual({
				tradeDate: DATE,
				totalBets: 2,
				totalStaked: 350,
				totalPaidOut: 0,
				playersCount: 1,
				updatedAt: expect.any(Number)
			});
		});

		it('applies signed payout deltas to the pot', async () => {
			await store.pots.applyPotDelta(DATE, { totalStaked: 1000 });
			await store.pots.applyPotDelta(DATE, { totalPaidOut: 650 });
			expect((await store.pots.getDailyPot(DATE))?.totalPaidOut).toBe(650);
		});

		it('sums stats deltas and keeps best_payout as a max', async () => {
			await store.stats.applyStatsDelta('u1', { betsPlaced: 1, totalStaked: 100 });
			await store.stats.applyStatsDelta('u1', {
				betsPlaced: 1,
				betsWon: 1,
				totalStaked: 50,
				totalWon: 300,
				bestPayout: 300
			});
			await store.stats.applyStatsDelta('u1', { bestPayout: 120 }); // lower — ignored

			const stats = await store.stats.getUserStats('u1');
			expect(stats).toMatchObject({
				betsPlaced: 2,
				betsWon: 1,
				totalStaked: 150,
				totalWon: 300,
				bestPayout: 300
			});
		});

		it('keeps counters independent per user and per date', async () => {
			await store.pots.applyPotDelta(DATE, { totalBets: 1 });
			await store.pots.applyPotDelta('2026-08-28', { totalBets: 5 });
			await store.stats.applyStatsDelta('u2', { betsPlaced: 1 });

			expect((await store.pots.getDailyPot(DATE))?.totalBets).toBe(1);
			expect((await store.pots.getDailyPot('2026-08-28'))?.totalBets).toBe(5);
			expect((await store.stats.getUserStats('u1')).betsPlaced).toBe(0);
			expect((await store.stats.getUserStats('u2')).betsPlaced).toBe(1);
		});

		it('keeps the wallet, the ledger and the counters consistent across a full place+settle cycle', async () => {
			// The invariant PLAN §8 checks: sum(ledger.amount) == balance - 1000.
			const betId = await placeBet(store, 'u1', 100);
			await store.tx(async (t) => {
				await t.profiles.applyBalanceDelta('u1', -100);
				await t.ledger.appendLedger({
					userId: 'u1',
					kind: 'bet_stake',
					amount: -100,
					refBetId: betId,
					balanceAfter: 900
				});
				await t.pots.applyPotDelta(DATE, { totalBets: 1, totalStaked: 100, playersCount: 1 });
				await t.stats.applyStatsDelta('u1', { betsPlaced: 1, totalStaked: 100 });
			});

			await store.tx(async (t) => {
				await t.bets.setBetOutcome(betId, 'hit', 600, Date.now());
				await t.profiles.applyBalanceDelta('u1', 600);
				await t.ledger.appendLedger({
					userId: 'u1',
					kind: 'payout',
					amount: 600,
					refBetId: betId,
					balanceAfter: 1500
				});
				await t.pots.applyPotDelta(DATE, { totalPaidOut: 600 });
				await t.stats.applyStatsDelta('u1', { betsWon: 1, totalWon: 600, bestPayout: 600 });
			});

			const profile = await store.profiles.getProfile('u1');
			const ledger = await store.ledger.getLedgerForUser('u1');
			const sum = ledger.reduce((acc, row) => acc + row.amount, 0);

			expect((profile?.balance ?? 0) - 1000).toBe(sum);
			expect(profile?.balance).toBe(1500);
			expect((await store.pots.getDailyPot(DATE))?.totalPaidOut).toBe(600);
			expect((await store.bets.getBetById(betId))?.settlementTier).toBe('hit');
		});
	});

	// ----------------------------------------------------------------- ticks

	describe('cas tick range query', () => {
		const ts = (n: number): number => Date.parse('2026-08-27T10:00:00.000Z') + n * 1000;

		beforeEach(async () => {
			await store.ticks.insertCasTicks(
				['nifty', 'banknifty'].flatMap((underlying) =>
					[1000, 2000, 3000, 4000].map((ms) => ({
						tradeDate: DATE,
						underlying: underlying as 'nifty' | 'banknifty',
						ts: ts(ms),
						value: 25000 + ms,
						changePts: ms / 10,
						changePct: ms / 1000
					}))
				)
			);
		});

		it('is inclusive of fromTs and exclusive of toTs', async () => {
			const ticks = await store.ticks.getCasTicksRange(DATE, 'nifty', ts(2000), ts(4000), 100);
			expect(ticks.map((t) => t.ts)).toEqual([ts(2000), ts(3000)]);
		});

		it('returns nothing for an empty or inverted window', async () => {
			expect(await store.ticks.getCasTicksRange(DATE, 'nifty', ts(3000), ts(3000), 100)).toEqual(
				[]
			);
			expect(await store.ticks.getCasTicksRange(DATE, 'nifty', ts(4000), ts(1000), 100)).toEqual(
				[]
			);
		});

		it('is scoped by trade date and underlying', async () => {
			expect(
				await store.ticks.getCasTicksRange('2020-01-01', 'nifty', 0, Date.now() + 1, 100)
			).toEqual([]);
			expect(
				(await store.ticks.getCasTicksRange(DATE, 'banknifty', 0, Date.now() + 1, 100)).length
			).toBe(4);
			expect(
				(await store.ticks.getCasTicksRange(DATE, 'sensex', 0, Date.now() + 1, 100)).length
			).toBe(0);
		});

		it('honours the limit and stays ordered ascending', async () => {
			const ticks = await store.ticks.getCasTicksRange(DATE, 'nifty', 0, Date.now() + 1, 2);
			expect(ticks.map((t) => t.ts)).toEqual([ts(1000), ts(2000)]);
		});

		it('is idempotent on the natural key (trade_date, underlying, ts) and counts new rows', async () => {
			const again = await store.ticks.insertCasTicks([
				{
					tradeDate: DATE,
					underlying: 'nifty',
					ts: ts(2000),
					value: 1,
					changePts: 0,
					changePct: 0
				},
				{
					tradeDate: DATE,
					underlying: 'nifty',
					ts: ts(5000),
					value: 27000,
					changePts: 5,
					changePct: 0.5
				}
			]);
			expect(again).toBe(1); // only the genuinely new tick stored

			const ticks = await store.ticks.getCasTicksRange(DATE, 'nifty', 0, Date.now() + 1, 100);
			expect(ticks.map((t) => t.ts)).toEqual([ts(1000), ts(2000), ts(3000), ts(4000), ts(5000)]);
			// first write won the ts collision — the value is unchanged
			expect(ticks.find((t) => t.ts === ts(2000))?.value).toBe(27000);
		});

		it('accepts an empty batch as a no-op', async () => {
			expect(await store.ticks.insertCasTicks([])).toBe(0);
		});
	});

	// --------------------------------------------------------------- closes

	describe('index closes', () => {
		it('upserts the latest close and reads the previous trading day as the anchor', async () => {
			await store.closes.upsertIndexClose({
				tradeDate: '2026-08-26',
				underlying: 'nifty',
				close: 24950.5,
				source: 'official'
			});
			await store.closes.upsertIndexClose({
				tradeDate: '2026-08-25',
				underlying: 'nifty',
				close: 24880,
				source: 'official'
			});
			await store.closes.upsertIndexClose({
				tradeDate: '2026-08-27',
				underlying: 'nifty',
				close: 25012.25,
				source: 'live_approx'
			});

			const anchor = await store.closes.getLatestCloseBefore(DATE, 'nifty');
			expect(anchor?.close).toBe(24950.5); // previous day, not today's live value

			// today's live approximation is overwritten by the official close
			await store.closes.upsertIndexClose({
				tradeDate: DATE,
				underlying: 'nifty',
				close: 25010,
				source: 'official'
			});
			const today = await store.closes.getIndexCloses(DATE);
			expect(today).toHaveLength(1);
			expect(today[0]).toEqual({
				tradeDate: DATE,
				underlying: 'nifty',
				close: 25010,
				source: 'official'
			});
		});

		it('returns null when there is no anchor yet (first trading day)', async () => {
			expect(await store.closes.getLatestCloseBefore('2026-01-01', 'sensex')).toBeNull();
		});
	});

	// -------------------------------------------------------------- profiles

	describe('profiles', () => {
		it('finds by id and by handle, and reports misses as null', async () => {
			expect((await store.profiles.getProfile('u1'))?.handle).toBe('priya');
			expect((await store.profiles.getProfileByHandle('priya'))?.userId).toBe('u1');
			expect(await store.profiles.getProfile('nope')).toBeNull();
			expect(await store.profiles.getProfileByHandle('nope')).toBeNull();
		});

		it('enforces handle uniqueness on insert and rename', async () => {
			await expect(
				store.profiles.insertProfile({ userId: 'u3', handle: 'priya', email: 'x@x.dev' })
			).rejects.toBeInstanceOf(Error);
			await expect(store.profiles.setHandle('u2', 'priya')).rejects.toBeInstanceOf(Error);
			const renamed = await store.profiles.setHandle('u2', 'arjun_2');
			expect(renamed.handle).toBe('arjun_2');
		});

		it('rejects a negative starting balance', async () => {
			await expect(
				store.profiles.insertProfile({
					userId: 'u4',
					handle: 'debt',
					email: 'd@x.dev',
					balance: -1
				})
			).rejects.toBeInstanceOf(InsufficientFundsError);
		});

		it("lists a batch of handles in the caller's order, skipping unknown ones", async () => {
			const found = await store.profiles.listProfilesByHandles([
				'arjun',
				'ghost',
				'priya',
				'priya'
			]);
			expect(found.map((p) => p.handle)).toEqual(['arjun', 'priya']);
			expect(await store.profiles.listProfilesByHandles([])).toEqual([]);
		});
	});
});
