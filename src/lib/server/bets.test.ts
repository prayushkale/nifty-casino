/**
 * The bet service (PLAN §5 T7) — the plan-mandated table: cutoff boundary,
 * insufficient funds, invalid target, edit-refund math, cancel refund, idempotent
 * double-submit, session closed, weekend, window-not-open, and counter
 * consistency after every single operation.
 *
 * Runs against the memory driver: money behaviour is defined once in ./db/money
 * and shared by both drivers, so what is under test here is the service's own
 * validation, its ledger math and its error codes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SIGNUP_BONUS } from '$lib/config/app';
import { invalidateLadderCache } from '$lib/server/ladder';
import { MemoryStore, type GameStore } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { istAt } from '$lib/server/cas/test-clock';
import { BetError, cancelBet, editBet, placeBet, type BetRequest } from './bets';

// IST fixtures: THURSDAY is a trading day, SATURDAY is not. 2026-08-26 is a Wednesday.
const WEDNESDAY = '2026-08-26';
const THURSDAY = '2026-08-27';
const SATURDAY = '2026-08-29';
const at = (h: number, m = 0, s = 0): Date => new Date(istAt(THURSDAY, h, m, s));

const ANCHORS: Record<Underlying, number> = { nifty: 25_000, banknifty: 56_000, sensex: 82_000 };
const U1 = '00000000-0000-4000-8000-00000000u001';
const U2 = '00000000-0000-4000-8000-00000000u002';

/** Fresh store, today's anchors, one funded player. */
async function setup(balance = SIGNUP_BONUS): Promise<GameStore> {
	invalidateLadderCache();
	const store = new MemoryStore({ now: () => istAt(THURSDAY, 12, 0, 0) });
	for (const [underlying, close] of Object.entries(ANCHORS)) {
		await store.closes.upsertIndexClose({
			tradeDate: WEDNESDAY,
			underlying: underlying as Underlying,
			close,
			source: 'official'
		});
	}
	await store.profiles.insertProfile({ userId: U1, handle: 'priya', email: 'p@x.dev', balance });
	await store.profiles.insertProfile({ userId: U2, handle: 'arjun', email: 'a@x.dev', balance });
	return store;
}

/** A valid nifty request, fields overridden per test. */
const nifty = (over: Record<string, unknown> = {}): BetRequest => ({
	underlying: 'nifty',
	targetKind: 'up',
	deltaPoints: 50,
	stake: 100,
	...over
});

/**
 * The whole point of the counters: they must describe the bets exactly, the
 * ledger must explain the balance, and every row must carry the balance it
 * produced. Called after every mutating operation in this suite.
 */
async function expectConsistent(store: GameStore, tradeDate = THURSDAY): Promise<void> {
	const session = await store.sessions.getSessionByDate(tradeDate);
	const bets = session ? await store.bets.listBetsForSession(session.id) : [];
	const pot = await store.pots.getDailyPot(tradeDate);

	// A day with no bets has no pot row at all — absent reads as zero.
	expect(pot?.totalBets ?? 0).toBe(bets.length);
	expect(pot?.totalStaked ?? 0).toBe(bets.reduce((acc, bet) => acc + bet.stake, 0));
	expect(pot?.playersCount ?? 0).toBe(new Set(bets.map((bet) => bet.userId)).size);

	for (const userId of [U1, U2]) {
		const mine = bets.filter((bet) => bet.userId === userId);
		const stats = await store.stats.getUserStats(userId);
		expect(stats.betsPlaced).toBe(mine.length);
		expect(stats.totalStaked).toBe(mine.reduce((acc, bet) => acc + bet.stake, 0));

		const balance = (await store.profiles.getProfile(userId))?.balance ?? 0;
		const rows = await store.ledger.getLedgerForUser(userId);
		const sum = rows.reduce((acc, row) => acc + row.amount, 0);
		// PLAN §8 launch gate: the movement ledger explains the wallet, minus the
		// signup grant it started from (no signup row is written in this fixture).
		expect(sum, `ledger vs balance for ${userId}`).toBe(balance - SIGNUP_BONUS);
		// The newest row was written by the newest movement, so it knows the balance.
		if (rows.length > 0) expect(rows[0]?.balanceAfter).toBe(balance);
	}
}

/** Expect a refusal with a specific code, and that it really is the service's error. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<BetError> {
	try {
		await promise;
	} catch (err: unknown) {
		expect(err).toBeInstanceOf(BetError);
		expect((err as BetError).code).toBe(code);
		return err as BetError;
	}
	throw new Error(`expected ${code}, but the call succeeded`);
}

let store: GameStore;
beforeEach(async () => {
	store = await setup();
});

describe('placeBet', () => {
	it('prices the bet off the ladder and freezes target and odds', async () => {
		const bet = await placeBet(U1, nifty(), { now: at(15, 5), store });

		expect(bet).toMatchObject({
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake: 100
		});
		// The bet row does not carry the target level (settlement derives it from the
		// anchor), but the ladder the player saw was 25,000 ± 50.
		expect((await store.profiles.getProfile(U1))?.balance).toBe(900);
		await expectConsistent(store);
	});

	it('prices every index from its own configured odds', async () => {
		const cases: [Underlying, 'up' | 'down', number, number][] = [
			['nifty', 'up', 50, 6],
			['banknifty', 'down', 200, 4.5],
			['sensex', 'up', 400, 3.8]
		];
		for (const [underlying, targetKind, deltaPoints, odds] of cases) {
			const bet = await placeBet(
				U1,
				{ underlying, targetKind, deltaPoints, stake: 10 },
				{ now: at(15, 5), store }
			);
			expect(bet.odds, `${underlying} ±${deltaPoints}`).toBe(odds);
		}
		await expectConsistent(store);
	});

	it('accepts the boundary instants: 15:00:00 opens, 15:20:00 is the last millisecond', async () => {
		await placeBet(U1, nifty({ stake: 10 }), { now: at(15, 0, 0), store });
		await expectCode(
			placeBet(U1, nifty({ underlying: 'sensex' }), { now: at(14, 59, 59), store }),
			'WINDOW_NOT_OPEN'
		);
		// BANKNIFTY's smallest step is 100, not 50 (PLAN §0.1).
		await placeBet(U1, nifty({ underlying: 'banknifty', deltaPoints: 100 }), {
			now: at(15, 20, 0),
			store
		});
		await expectConsistent(store);
	});

	it('refuses 15:20:01 as CUTOFF_PASSED', async () => {
		await expectCode(placeBet(U1, nifty(), { now: at(15, 20, 1), store }), 'CUTOFF_PASSED');
		expect((await store.profiles.getProfile(U1))?.balance).toBe(1000);
		await expectConsistent(store);
	});

	it('refuses a weekend as MARKET_CLOSED, even inside the window', async () => {
		await expectCode(
			placeBet(U1, nifty(), { now: new Date(istAt(SATURDAY, 15, 10, 0)), store }),
			'MARKET_CLOSED'
		);
		await expectConsistent(store);
	});

	it('refuses a target that is not on today’s ladder as INVALID_TARGET', async () => {
		await expectCode(
			placeBet(U1, nifty({ deltaPoints: 75 }), { now: at(15, 5), store }),
			'INVALID_TARGET'
		);
		await expectCode(
			placeBet(U1, nifty({ deltaPoints: 300 }), { now: at(15, 5), store }),
			'INVALID_TARGET'
		);
		// SENSEX has no 300 step by design (PLAN §0.1).
		await expectCode(
			placeBet(U1, nifty({ underlying: 'sensex', deltaPoints: 300 }), { now: at(15, 5), store }),
			'INVALID_TARGET'
		);
		await expectCode(
			placeBet(U1, nifty({ targetKind: 'sideways' }), { now: at(15, 5), store }),
			'INVALID_TARGET_KIND'
		);
		await expectConsistent(store);
	});

	it('rejects an unusable index, stake or direction before touching any money', async () => {
		const cases: [BetRequest, string][] = [
			[nifty({ underlying: 'reliance' }), 'INVALID_UNDERLYING'],
			[nifty({ underlying: null }), 'INVALID_UNDERLYING'],
			[nifty({ stake: 5 }), 'INVALID_STAKE'], // below MIN_STAKE
			[nifty({ stake: 100_001 }), 'INVALID_STAKE'], // above MAX_STAKE
			[nifty({ stake: 10.5 }), 'INVALID_STAKE'], // not whole chips
			[nifty({ stake: '100' }), 'INVALID_STAKE'], // a string is not a stake
			[nifty({ deltaPoints: 0 }), 'INVALID_TARGET'],
			[nifty({ deltaPoints: -50 }), 'INVALID_TARGET'],
			[nifty({ deltaPoints: 50.5 }), 'INVALID_TARGET'],
			[nifty({ targetKind: 'flat' }), 'INVALID_TARGET_KIND']
		];
		for (const [body, code] of cases) {
			await expectCode(placeBet(U1, body, { now: at(15, 5), store }), code);
		}

		expect((await store.profiles.getProfile(U1))?.balance).toBe(SIGNUP_BONUS);
		expect(await store.ledger.getLedgerForUser(U1)).toHaveLength(0);
		await expectConsistent(store);
	});

	it('refuses a stake the wallet cannot cover, and leaves nothing behind', async () => {
		const err = await expectCode(
			placeBet(U1, nifty({ stake: 1001 }), { now: at(15, 5), store }),
			'INSUFFICIENT_BALANCE'
		);
		expect(err.details).toMatchObject({ required: 1001, available: 1000 });
		expect((await store.profiles.getProfile(U1))?.balance).toBe(1000);
		expect(await store.ledger.getLedgerForUser(U1)).toHaveLength(0);
		await expectConsistent(store);
	});

	it('answers a double-submit with BET_EXISTS and the existing bet id, counted once', async () => {
		const first = await placeBet(U1, nifty(), { now: at(15, 5), store });
		const err = await expectCode(
			placeBet(U1, nifty({ stake: 50 }), { now: at(15, 6), store }),
			'BET_EXISTS'
		);
		expect(err.details.betId).toBe(first.id);

		// The pot saw one bet, one stake, one player — not the retry's 999.
		expect((await store.pots.getDailyPot(THURSDAY))?.totalStaked).toBe(100);
		expect((await store.profiles.getProfile(U1))?.balance).toBe(900);
		expect(await store.ledger.getLedgerForUser(U1)).toHaveLength(1);
		await expectConsistent(store);
	});

	it('refuses a bet once the session is no longer open', async () => {
		const session = await store.sessions.ensureSession(THURSDAY, istAt(THURSDAY, 15, 20));
		await store.sessions.setSessionStatus(session.id, 'locked');
		await expectCode(placeBet(U1, nifty(), { now: at(15, 5), store }), 'SESSION_CLOSED');
		await expectConsistent(store);
	});
});

describe('editBet', () => {
	const placeNifty = async (stake = 100): Promise<string> =>
		(await placeBet(U1, nifty({ stake }), { now: at(15, 5), store })).id;

	it('halves the stake: +50 back on balance, −50 in the pot, two ledger rows', async () => {
		const id = await placeNifty(100);

		const bet = await editBet(U1, id, { stake: 50 }, { now: at(15, 10), store });
		expect(bet.stake).toBe(50);
		expect(bet.id).toBeTruthy();
		expect((await store.profiles.getProfile(U1))?.balance).toBe(1000 - 50);

		const rows = await store.ledger.getLedgerForUser(U1);
		expect(rows).toHaveLength(3); // stake 100, refund 100, stake 50 — newest first
		expect(rows.map((row) => row.kind)).toEqual(['bet_stake', 'refund', 'bet_stake']);
		expect(rows.map((row) => row.amount)).toEqual([-50, 100, -100]);

		expect(await store.pots.getDailyPot(THURSDAY)).toMatchObject({
			totalBets: 1,
			totalStaked: 50,
			playersCount: 1
		});
		expect(await store.stats.getUserStats(U1)).toMatchObject({
			betsPlaced: 1,
			totalStaked: 50
		});
		await expectConsistent(store);
	});

	it('re-prices the odds from the ladder when the target moves, keeping the same row', async () => {
		const id = await placeNifty(100);
		const bet = await editBet(
			U1,
			id,
			{ targetKind: 'down', deltaPoints: 200 },
			{ now: at(15, 10), store }
		);

		expect(bet.id).toBe(id);
		expect(bet).toMatchObject({ targetKind: 'down', deltaPoints: 200, odds: 3.2, stake: 100 });
		expect((await store.profiles.getProfile(U1))?.balance).toBe(900); // 100 out, 100 in, 100 out
		expect((await store.pots.getDailyPot(THURSDAY))?.totalStaked).toBe(100);
		await expectConsistent(store);
	});

	it('flows a same-value edit through the same ledger math (zero net movement)', async () => {
		const id = await placeNifty(100);
		await editBet(U1, id, { stake: 100 }, { now: at(15, 10), store });

		expect((await store.profiles.getProfile(U1))?.balance).toBe(900);
		expect(await store.ledger.getLedgerForUser(U1)).toHaveLength(3); // refund + re-stake
		expect((await store.pots.getDailyPot(THURSDAY))?.totalStaked).toBe(100);
		await expectConsistent(store);
	});

	it('refuses a bigger stake the wallet cannot cover, changing nothing', async () => {
		const id = await placeNifty(100);
		await expectCode(
			editBet(U1, id, { stake: 2000 }, { now: at(15, 10), store }),
			'INSUFFICIENT_BALANCE'
		);
		expect((await store.profiles.getProfile(U1))?.balance).toBe(900);
		expect(await store.ledger.getLedgerForUser(U1)).toHaveLength(1);
		expect((await store.bets.getBetById(id))?.stake).toBe(100);
		await expectConsistent(store);
	});

	it('refuses a patch target that is not on the ladder, and a bad stake', async () => {
		const id = await placeNifty(100);
		await expectCode(
			editBet(U1, id, { deltaPoints: 75 }, { now: at(15, 10), store }),
			'INVALID_TARGET'
		);
		await expectCode(editBet(U1, id, { stake: 1 }, { now: at(15, 10), store }), 'INVALID_STAKE');
		expect((await store.bets.getBetById(id))?.stake).toBe(100);
		await expectConsistent(store);
	});

	it('refuses an edit after the cutoff, or once the session is locked', async () => {
		const id = await placeNifty(100);
		await expectCode(
			editBet(U1, id, { stake: 50 }, { now: at(15, 20, 1), store }),
			'CUTOFF_PASSED'
		);

		const session = await store.sessions.getSessionByDate(THURSDAY);
		await store.sessions.setSessionStatus(session?.id ?? 0, 'locked');
		await expectCode(editBet(U1, id, { stake: 50 }, { now: at(15, 10), store }), 'SESSION_CLOSED');
		await expectConsistent(store);
	});

	it('refuses another player’s bet as BET_NOT_FOUND (and a bet that never existed)', async () => {
		const id = await placeNifty(100);
		await expectCode(editBet(U2, id, { stake: 50 }, { now: at(15, 10), store }), 'BET_NOT_FOUND');
		await expectCode(
			editBet(
				U1,
				'00000000-0000-4000-8000-00000000nope',
				{ stake: 50 },
				{ now: at(15, 10), store }
			),
			'BET_NOT_FOUND'
		);
		expect((await store.bets.getBetById(id))?.stake).toBe(100);
		await expectConsistent(store);
	});

	it('refuses to edit a bet that is already settled', async () => {
		const id = await placeNifty(100);
		await store.bets.setBetOutcome(id, 'miss', 0, istAt(THURSDAY, 15, 45));
		await expectCode(editBet(U1, id, { stake: 50 }, { now: at(15, 10), store }), 'BET_SETTLED');
		await expectConsistent(store);
	});
});

describe('cancelBet', () => {
	const placeNifty = async (stake = 100): Promise<string> =>
		(await placeBet(U1, nifty({ stake }), { now: at(15, 5), store })).id;

	it('refunds the full stake, deletes the row and reverses the counters', async () => {
		const id = await placeNifty(100);
		await placeBet(U1, nifty({ underlying: 'banknifty', stake: 40, deltaPoints: 200 }), {
			now: at(15, 6),
			store
		});

		const result = await cancelBet(U1, id, { now: at(15, 10), store });
		expect(result).toEqual({ refunded: 100 });

		expect(await store.bets.getBetById(id)).toBeNull();
		expect((await store.profiles.getProfile(U1))?.balance).toBe(1000 - 40);
		expect(await store.pots.getDailyPot(THURSDAY)).toMatchObject({
			totalBets: 1,
			totalStaked: 40,
			playersCount: 1
		});
		expect(await store.stats.getUserStats(U1)).toMatchObject({
			betsPlaced: 1,
			totalStaked: 40
		});
		await expectConsistent(store);
	});

	it('keeps the refund in the ledger — the audit trail outlives the row', async () => {
		const id = await placeNifty(100);
		await cancelBet(U1, id, { now: at(15, 10), store });

		const rows = await store.ledger.getLedgerForUser(U1);
		expect(rows.map((row) => row.kind)).toEqual(['refund', 'bet_stake']);
		expect(rows.map((row) => row.amount)).toEqual([100, -100]);
		await expectConsistent(store);
	});

	it('frees the index slot, so the same index can be bet again today', async () => {
		const id = await placeNifty(100);
		await cancelBet(U1, id, { now: at(15, 10), store });

		const again = await placeBet(U1, nifty({ targetKind: 'down' }), { now: at(15, 11), store });
		expect(again.id).not.toBe(id);
		expect((await store.pots.getDailyPot(THURSDAY))?.totalStaked).toBe(100);
		await expectConsistent(store);
	});

	it('refuses a cancel after the cutoff', async () => {
		const id = await placeNifty(100);
		await expectCode(cancelBet(U1, id, { now: at(15, 20, 1), store }), 'CUTOFF_PASSED');
		expect(await store.bets.getBetById(id)).not.toBeNull();
		expect((await store.profiles.getProfile(U1))?.balance).toBe(900);
		await expectConsistent(store);
	});

	it('refuses an unknown bet, another player’s bet, and a second cancel', async () => {
		const id = await placeNifty(100);
		await expectCode(cancelBet(U2, id, { now: at(15, 10), store }), 'BET_NOT_FOUND');
		await expectCode(
			cancelBet(U1, '00000000-0000-4000-8000-00000000nope', { now: at(15, 10), store }),
			'BET_NOT_FOUND'
		);
		await cancelBet(U1, id, { now: at(15, 10), store });
		await expectCode(cancelBet(U1, id, { now: at(15, 10), store }), 'BET_NOT_FOUND');
		await expectConsistent(store);
	});
});

describe('a whole betting day', () => {
	it('stays counter-consistent through place, edit, cancel and a second player', async () => {
		const a = await placeBet(U1, nifty(), { now: at(15, 1), store });
		await placeBet(U1, nifty({ underlying: 'banknifty', deltaPoints: 200, stake: 40 }), {
			now: at(15, 2),
			store
		});
		const c = await placeBet(U2, nifty({ underlying: 'sensex', deltaPoints: 250, stake: 60 }), {
			now: at(15, 3),
			store
		});
		await editBet(U1, a.id, { stake: 250 }, { now: at(15, 4), store });
		// A third leg for U1 on a free index, then cancelled: the counters must unwind.
		const scratch = await placeBet(
			U1,
			nifty({ underlying: 'sensex', deltaPoints: 250, stake: 30 }),
			{
				now: at(15, 5),
				store
			}
		);
		await cancelBet(U1, scratch.id, { now: at(15, 6), store });
		await cancelBet(U2, c.id, { now: at(15, 7), store });
		await editBet(U1, a.id, { deltaPoints: 100 }, { now: at(15, 8), store });

		await expectConsistent(store);
		expect((await store.pots.getDailyPot(THURSDAY))?.playersCount).toBe(1);
		expect(await store.bets.getBetsForUserOnDate(U2, THURSDAY)).toHaveLength(0);
	});
});
