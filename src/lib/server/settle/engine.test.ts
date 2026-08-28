/**
 * The settlement engine (PLAN §5 T9), against the memory driver.
 *
 * Every scenario here ends with the same three invariants, because they are the
 * launch gate of PLAN §8 and the cheapest way to catch a money bug anywhere in the
 * settlement path:
 *
 *   Σ ledger(amount) === balance − SIGNUP_BONUS     for every touched user
 *   pots.total_paid_out === Σ bets.payout           for the day
 *   pots.players_count === distinct players          for the day
 *
 * Payouts come from the PLAN §0.2 odds (6× / 4.5× / 3.8× / 3.2×) so the rounding
 * of `stake × odds` is exercised against the real ladder config. Bets are placed
 * through the real money path (`store.placeBet`), so a stake that never left the
 * wallet can never settle.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SIGNUP_BONUS, XP_PER_BET, XP_PER_HIT } from '$lib/config/app';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { istAt } from '$lib/server/cas/test-clock';
import {
	MemoryStore,
	type Bet,
	type DailyPot,
	type GameStore,
	type LedgerEntry,
	type Profile,
	type UserStats
} from '$lib/server/db';
import type { TargetKind, Underlying } from '$lib/server/db/types';
import { invalidateLadderCache } from '$lib/server/ladder';
import { prevTradingDay, settleSession, type SettleReport } from './engine';

// ---------------------------------------------------------------------------
// the day
// ---------------------------------------------------------------------------

/** Wed → Thu, a Friday → (weekend) → Monday pair, and a Tue → (gap) → Thu pair. */
const WEDNESDAY = '2026-08-26';
const THURSDAY = '2026-08-27';
const FRIDAY = '2026-08-28';
const MONDAY = '2026-08-31';
const TUESDAY = '2026-09-01';
const THURSDAY_AFTER = '2026-09-03';

/** The PLAN §0.1 launch anchors, as the previous trading day's official closes. */
const ANCHORS: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

/** The instant every settlement run in this file is judged at. */
const FIXED_NOW = istAt(THURSDAY, 15, 43, 0);
const cutoffOf = (tradeDate: string): number => istAt(tradeDate, 15, 20, 0);
const duringBetting = (tradeDate: string): number => istAt(tradeDate, 15, 5, 0);

type Seed = {
	underlying: Underlying;
	targetKind?: TargetKind;
	deltaPoints: number;
	odds: number;
	stake?: number;
};

let store: MemoryStore;

// -- read helpers (store first, so the chunking test can run two stores) --------

const sessionOf = async (s: GameStore, tradeDate: string) => {
	const session = await s.sessions.getSessionByDate(tradeDate);
	if (!session) throw new Error(`no session for ${tradeDate}`);
	return session;
};
const betsOf = async (s: GameStore, tradeDate: string): Promise<Bet[]> =>
	s.bets.listBetsForSession((await sessionOf(s, tradeDate)).id);
const potOf = (s: GameStore, tradeDate: string): Promise<DailyPot | null> =>
	s.pots.getDailyPot(tradeDate);
const ledgerOf = (s: GameStore, userId: string): Promise<LedgerEntry[]> =>
	s.ledger.getLedgerForUser(userId);
const profileOf = (s: GameStore, userId: string): Promise<Profile | null> =>
	s.profiles.getProfile(userId);
const statsOf = (s: GameStore, userId: string): Promise<UserStats> => s.stats.getUserStats(userId);

const balanceOf = async (s: GameStore, userId: string): Promise<number> =>
	(await profileOf(s, userId))?.balance ?? -1;
const xpOf = async (s: GameStore, userId: string): Promise<number> =>
	(await profileOf(s, userId))?.xp ?? -1;

// -- setup helpers ----------------------------------------------------------------

async function newUser(userId: string): Promise<Profile> {
	return store.profiles.insertProfile({
		userId,
		handle: userId,
		email: `${userId}@test.dev`,
		balance: SIGNUP_BONUS
	});
}

/** A day's official closes as absolute levels. */
async function writeCloses(
	tradeDate: string,
	closes: Partial<Record<LadderUnderlying, number>>,
	source: 'official' | 'live_approx' = 'official'
): Promise<void> {
	for (const underlying of LADDER_UNDERLYINGS) {
		const close = closes[underlying];
		if (close === undefined) continue;
		await store.closes.upsertIndexClose({ tradeDate, underlying, close, source });
	}
	invalidateLadderCache();
}

/** Yesterday's official closes — the anchors today's ladder (and settlement) hang off. */
function seedAnchors(tradeDate: string, closes: Partial<Record<LadderUnderlying, number>> = {}) {
	return writeCloses(tradeDate, { ...ANCHORS, ...closes });
}

/** Open a betting day with the usual anchors, ready to take bets. */
async function openDay(
	tradeDate: string,
	anchors: Partial<Record<LadderUnderlying, number>> = {}
): Promise<void> {
	await store.sessions.ensureSession(tradeDate, cutoffOf(tradeDate));
	const yesterday = prevTradingDay(tradeDate);
	if (yesterday) await seedAnchors(yesterday, anchors);
	invalidateLadderCache();
}

async function place(userId: string, seed: Seed, tradeDate = THURSDAY): Promise<Bet> {
	return store.placeBet({
		userId,
		tradeDate,
		underlying: seed.underlying,
		targetKind: seed.targetKind ?? 'up',
		deltaPoints: seed.deltaPoints,
		odds: seed.odds,
		stake: seed.stake ?? 100,
		cutoffAtMs: cutoffOf(tradeDate),
		nowMs: duringBetting(tradeDate)
	});
}

/** Publish today's official closes as ANCHOR + move — what the capture would write. */
async function publishMoves(
	tradeDate: string,
	moves: Partial<Record<LadderUnderlying, number>>
): Promise<void> {
	const closes: Partial<Record<LadderUnderlying, number>> = {};
	for (const underlying of LADDER_UNDERLYINGS) {
		const move = moves[underlying];
		if (move === undefined) continue;
		closes[underlying] = ANCHORS[underlying] + move;
	}
	await writeCloses(tradeDate, closes);
}

// ---------------------------------------------------------------------------
// the invariants (PLAN §8 launch gate), asserted after every scenario
// ---------------------------------------------------------------------------

async function expectMoneyInvariants(s: GameStore, tradeDate: string): Promise<void> {
	const bets = await betsOf(s, tradeDate);
	const pot = await potOf(s, tradeDate);
	const players = [...new Set(bets.map((bet) => bet.userId))];

	expect(pot).not.toBeNull();
	expect(pot?.totalBets).toBe(bets.length);
	expect(pot?.totalStaked).toBe(bets.reduce((total, bet) => total + bet.stake, 0));
	expect(pot?.totalPaidOut).toBe(bets.reduce((total, bet) => total + (bet.payout ?? 0), 0));
	expect(pot?.playersCount).toBe(players.length);

	for (const userId of players) {
		// The whole-wallet invariant: every NC the user ever held came from the ledger.
		const allRows = await ledgerOf(s, userId);
		const net = allRows.reduce((total, row) => total + row.amount, 0);
		expect(net).toBe((await balanceOf(s, userId)) - SIGNUP_BONUS);

		// …and this day's rows line up with this day's bets, one credit per settled
		// bet (a hit pays, a flat refunds, a miss has no row at all).
		const mine = new Set(bets.filter((bet) => bet.userId === userId).map((bet) => bet.id));
		const dayRows = allRows.filter((row) => row.refBetId !== null && mine.has(row.refBetId));
		const settled = bets.filter((bet) => bet.userId === userId && bet.settledAt !== null);
		expect(dayRows.filter((row) => row.kind === 'payout')).toHaveLength(
			settled.filter((bet) => bet.settlementTier === 'hit').length
		);
		expect(dayRows.filter((row) => row.kind === 'refund')).toHaveLength(
			settled.filter((bet) => bet.settlementTier === 'flat').length
		);
		for (const row of dayRows.filter((r) => r.kind === 'payout' || r.kind === 'refund')) {
			const bet = bets.find((candidate) => candidate.id === row.refBetId);
			expect(bet?.payout).toBe(row.amount);
		}
	}
}

/** Settle at a pinned instant, so `settled_at` is part of the idempotency snapshots. */
const settle = (
	s: GameStore,
	tradeDate: string,
	options: { chunkSize?: number } = {}
): Promise<SettleReport> => settleSession(s, tradeDate, { nowMs: FIXED_NOW, ...options });

/** Everything settlement can touch — the input to the idempotency comparisons. */
async function snapshot(s: GameStore, tradeDate: string): Promise<Record<string, unknown>> {
	const bets = await betsOf(s, tradeDate);
	const players = [...new Set(bets.map((bet) => bet.userId))];
	return {
		session: { ...(await sessionOf(s, tradeDate)) },
		bets: bets.map((bet) => ({ ...bet })),
		pot: { ...((await potOf(s, tradeDate)) as DailyPot) },
		profiles: await Promise.all(
			players.map(async (userId) => ({ ...(await profileOf(s, userId)) }))
		),
		stats: await Promise.all(players.map(async (userId) => ({ ...(await statsOf(s, userId)) }))),
		ledger: await Promise.all(
			players.map(async (userId) => (await ledgerOf(s, userId)).map((row) => ({ ...row })))
		)
	};
}

beforeEach(async () => {
	store = new MemoryStore({ now: () => FIXED_NOW });
	await openDay(THURSDAY);
});

// ---------------------------------------------------------------------------
// one user, three tiers
// ---------------------------------------------------------------------------

describe('one user, one bet per tier', () => {
	beforeEach(async () => {
		await newUser('priya');
		// Δ +50 → HIT (6×), Δ +10 → FLAT (inside banknifty's ±50 dead zone), Δ +600 → MISS.
		await place('priya', { underlying: 'nifty', deltaPoints: 50, odds: 6 });
		await place('priya', { underlying: 'banknifty', deltaPoints: 200, odds: 4.5 });
		await place('priya', { underlying: 'sensex', deltaPoints: 400, odds: 3.8 });
		await publishMoves(THURSDAY, { nifty: 50, banknifty: 10, sensex: 600 });
	});

	it('pays the hit, refunds the flat and pays nothing for the miss', async () => {
		const report = await settle(store, THURSDAY);

		expect(report.status).toBe('settled');
		expect(report.settled).toBe(3);
		expect(report.chunks).toBe(1);
		expect(report.tiers).toEqual({ hit: 1, flat: 1, miss: 1 });
		expect(report.paidOut).toBe(700); // 600 + 100
		expect(report.incomplete).toEqual([]);
		expect(report.users).toEqual(['priya']);

		const byUnderlying = new Map(
			(await betsOf(store, THURSDAY)).map((bet) => [bet.underlying, bet])
		);
		expect(byUnderlying.get('nifty')).toMatchObject({
			settlementTier: 'hit',
			payout: 600,
			settledAt: FIXED_NOW
		});
		expect(byUnderlying.get('banknifty')).toMatchObject({
			settlementTier: 'flat',
			payout: 100,
			settledAt: FIXED_NOW
		});
		expect(byUnderlying.get('sensex')).toMatchObject({ settlementTier: 'miss', payout: 0 });

		// 1000 − 300 staked + 600 payout + 100 refund
		expect(await balanceOf(store, 'priya')).toBe(1_400);
	});

	it('writes one ledger row per money movement and none for the miss', async () => {
		await settle(store, THURSDAY);

		const rows = await ledgerOf(store, 'priya');
		expect(rows.reduce((total, row) => total + row.amount, 0)).toBe(400);
		// Newest first: the two credits, then the three stakes.
		expect(rows.map((row) => [row.kind, row.amount])).toEqual([
			['refund', 100],
			['payout', 600],
			['bet_stake', -100],
			['bet_stake', -100],
			['bet_stake', -100]
		]);

		const bets = await betsOf(store, THURSDAY);
		const niftyBet = bets.find((bet) => bet.underlying === 'nifty');
		const sensexBet = bets.find((bet) => bet.underlying === 'sensex');
		// Credits are stamped in settlement order: NIFTY pays first (700 − 300 + 600),
		// BANKNIFTY's refund is what lands the wallet on its final 1,400.
		expect(rows.find((row) => row.refBetId === niftyBet?.id)).toMatchObject({
			kind: 'payout',
			amount: 600,
			balanceAfter: 1_300
		});
		// The miss's only row is the stake it lost at placement.
		expect(rows.find((row) => row.refBetId === sensexBet?.id)).toMatchObject({
			kind: 'bet_stake',
			amount: -100
		});
	});

	it('moves the pots, the stats and the gamification exactly once', async () => {
		await settle(store, THURSDAY);

		expect(await potOf(store, THURSDAY)).toMatchObject({
			totalBets: 3,
			totalStaked: 300,
			totalPaidOut: 700,
			playersCount: 1
		});
		expect(await statsOf(store, 'priya')).toMatchObject({
			betsPlaced: 3,
			betsWon: 1,
			totalStaked: 300,
			totalWon: 700,
			bestPayout: 600
		});
		// 3 bets × 10 XP + 1 hit × 100 XP
		expect(await profileOf(store, 'priya')).toMatchObject({
			xp: XP_PER_BET * 3 + XP_PER_HIT,
			streakDays: 1,
			lastBetDate: THURSDAY
		});
		expect((await sessionOf(store, THURSDAY)).status).toBe('settled');
		await expectMoneyInvariants(store, THURSDAY);
	});
});

describe('payout arithmetic on the configured odds', () => {
	it('rounds 6×, 4.5× and 3.8× to whole chips', async () => {
		await newUser('arjun');
		await place('arjun', { underlying: 'banknifty', deltaPoints: 100, odds: 6, stake: 111 });
		await place('arjun', { underlying: 'sensex', deltaPoints: 250, odds: 4.5, stake: 111 });
		await place('arjun', { underlying: 'nifty', deltaPoints: 150, odds: 3.8, stake: 111 });
		// All three land exactly on target.
		await publishMoves(THURSDAY, { banknifty: 100, sensex: 250, nifty: 150 });

		const report = await settle(store, THURSDAY);

		expect(report.settled).toBe(3);
		const payouts = new Map(
			(await betsOf(store, THURSDAY)).map((bet) => [bet.underlying, bet.payout])
		);
		expect(payouts.get('banknifty')).toBe(666); // 111 × 6
		expect(payouts.get('sensex')).toBe(500); // 499.5 rounds half up
		expect(payouts.get('nifty')).toBe(422); // 421.8 rounds up
		expect(await balanceOf(store, 'arjun')).toBe(1_000 - 333 + 666 + 500 + 422);
		expect(await statsOf(store, 'arjun')).toMatchObject({
			betsWon: 3,
			totalWon: 1_588,
			bestPayout: 666
		});
		await expectMoneyInvariants(store, THURSDAY);
	});
});

// ---------------------------------------------------------------------------
// gamification
// ---------------------------------------------------------------------------

describe('streaks and XP', () => {
	/** Bet + settle one index on `tradeDate`, against that day's anchor. */
	const betAndSettle = async (userId: string, tradeDate: string): Promise<SettleReport> => {
		await store.sessions.ensureSession(tradeDate, cutoffOf(tradeDate));
		const yesterday = prevTradingDay(tradeDate);
		if (yesterday) await seedAnchors(yesterday);
		await place(userId, { underlying: 'nifty', deltaPoints: 50, odds: 6 }, tradeDate);
		await writeCloses(tradeDate, { nifty: ANCHORS.nifty + 50 });
		invalidateLadderCache();
		return settle(store, tradeDate);
	};

	it('continues a streak across a weekend (Friday → Monday is two days)', async () => {
		await newUser('priya');

		await betAndSettle('priya', FRIDAY);
		expect(await profileOf(store, 'priya')).toMatchObject({ streakDays: 1, lastBetDate: FRIDAY });

		await betAndSettle('priya', MONDAY);
		expect(await profileOf(store, 'priya')).toMatchObject({
			streakDays: 2,
			lastBetDate: MONDAY
		});
		await expectMoneyInvariants(store, MONDAY);
	});

	it('resets a streak after a gap in the betting days', async () => {
		await newUser('priya');

		await betAndSettle('priya', TUESDAY);
		expect((await profileOf(store, 'priya'))?.streakDays).toBe(1);

		// Skipped Wednesday: Thursday starts a new streak rather than extending.
		await betAndSettle('priya', THURSDAY_AFTER);
		expect(await profileOf(store, 'priya')).toMatchObject({
			streakDays: 1,
			lastBetDate: THURSDAY_AFTER
		});
	});

	it('gives a miss-only user XP but no credit and no extra ledger row', async () => {
		await newUser('devi');
		await place('devi', { underlying: 'sensex', deltaPoints: 500, odds: 3.2 });
		// Δ −500 on an `up` bet: wrong direction, full loss.
		await publishMoves(THURSDAY, { sensex: -500 });

		const report = await settle(store, THURSDAY);

		expect(report.settled).toBe(1);
		expect(await balanceOf(store, 'devi')).toBe(SIGNUP_BONUS - 100);
		const rows = await ledgerOf(store, 'devi');
		expect(rows).toHaveLength(1); // the stake, nothing else
		expect(rows[0]).toMatchObject({ kind: 'bet_stake', amount: -100 });
		expect(await statsOf(store, 'devi')).toMatchObject({ betsWon: 0, totalWon: 0 });
		expect(await xpOf(store, 'devi')).toBe(XP_PER_BET);
		await expectMoneyInvariants(store, THURSDAY);
	});
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
	beforeEach(async () => {
		await newUser('priya');
		await place('priya', { underlying: 'nifty', deltaPoints: 50, odds: 6 });
		await place('priya', { underlying: 'banknifty', deltaPoints: 200, odds: 4.5 });
		await place('priya', { underlying: 'sensex', deltaPoints: 400, odds: 3.8 });
	});

	it('re-running a settled day is a numerical no-op', async () => {
		await publishMoves(THURSDAY, { nifty: 50, banknifty: 10, sensex: 600 });
		const first = await settle(store, THURSDAY);
		const before = await snapshot(store, THURSDAY);

		const second = await settle(store, THURSDAY);
		const after = await snapshot(store, THURSDAY);

		expect(first.status).toBe('settled');
		expect(second).toMatchObject({
			status: 'already-settled',
			idempotent: true,
			settled: 0,
			chunks: 0,
			paidOut: 0
		});
		expect(after).toEqual(before);
		expect(await balanceOf(store, 'priya')).toBe(1_400);
		await expectMoneyInvariants(store, THURSDAY);
	});

	it('re-running a partially settled day pays only what was missing', async () => {
		// SENSEX has no official close yet: two bets settle, the third waits.
		await publishMoves(THURSDAY, { nifty: 50, banknifty: 10 });

		const first = await settle(store, THURSDAY);
		expect(first.status).toBe('incomplete');
		expect(first.incomplete).toEqual(['sensex']);
		expect(first.settled).toBe(2);
		expect(first.paidOut).toBe(700);
		expect((await sessionOf(store, THURSDAY)).status).toBe('open');
		expect(await balanceOf(store, 'priya')).toBe(1_400);

		// The close arrives (a late auction, a feed catch-up); the re-run settles the
		// outstanding bet and does not touch what it already paid.
		await publishMoves(THURSDAY, { sensex: 600 });
		const second = await settle(store, THURSDAY);

		expect(second.status).toBe('settled');
		expect(second.settled).toBe(1);
		// Already-settled bets are filtered out before the driver, so there is
		// nothing for it to skip.
		expect(second.skipped).toBe(0);
		expect(second.paidOut).toBe(0);
		expect(second.xpAwarded).toBe(XP_PER_BET);

		expect((await betsOf(store, THURSDAY)).filter((bet) => bet.settledAt !== null)).toHaveLength(3);
		expect(await balanceOf(store, 'priya')).toBe(1_400);
		expect(await potOf(store, THURSDAY)).toMatchObject({ totalPaidOut: 700 });
		// XP: 3 bets × 10 + 1 hit × 100, split across two runs — never doubled.
		expect(await xpOf(store, 'priya')).toBe(XP_PER_BET * 3 + XP_PER_HIT);
		await expectMoneyInvariants(store, THURSDAY);
	});

	it('skips a bet that something else settled before the run', async () => {
		await publishMoves(THURSDAY, { nifty: 50, banknifty: 10, sensex: 600 });
		// Hand-settle the NIFTY bet exactly the way a crashed run would have left it:
		// marked, paid, counted — but no XP, because no run awarded it.
		const niftyBet = (await betsOf(store, THURSDAY)).find((bet) => bet.underlying === 'nifty');
		await store.tx(async (t) => {
			await t.bets.setBetOutcome(niftyBet!.id, 'hit', 600, FIXED_NOW);
			const credited = await t.profiles.applyBalanceDelta('priya', 600);
			await t.ledger.appendLedger({
				userId: 'priya',
				kind: 'payout',
				amount: 600,
				refBetId: niftyBet!.id,
				balanceAfter: credited.balance
			});
			await t.pots.applyPotDelta(THURSDAY, { totalPaidOut: 600 });
			await t.stats.applyStatsDelta('priya', { betsWon: 1, totalWon: 600, bestPayout: 600 });
		});
		const before = await snapshot(store, THURSDAY);

		const report = await settle(store, THURSDAY);

		expect(report.status).toBe('settled');
		expect(report.settled).toBe(2); // the flat and the miss only
		expect(await balanceOf(store, 'priya')).toBe(1_400);
		expect(await potOf(store, THURSDAY)).toMatchObject({ totalPaidOut: 700 });
		// XP covers the two bets this run settled. The hit's bonus is NOT re-awarded
		// — that is the documented gap between the money and the gamification phase,
		// and it can only ever under-credit, never double-pay.
		expect(await xpOf(store, 'priya')).toBe(XP_PER_BET * 2);
		await expectMoneyInvariants(store, THURSDAY);
		expect(before).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------

describe('chunked settlement', () => {
	const BET_COUNT = 12;
	const USERS = 4;

	/** A fresh day with 12 bets over 4 users and 3 indices, all closes published. */
	const buildDay = async (): Promise<MemoryStore> => {
		const fresh = new MemoryStore({ now: () => FIXED_NOW });
		await fresh.sessions.ensureSession(THURSDAY, cutoffOf(THURSDAY));
		for (const underlying of LADDER_UNDERLYINGS) {
			await fresh.closes.upsertIndexClose({
				tradeDate: WEDNESDAY,
				underlying,
				close: ANCHORS[underlying],
				source: 'official'
			});
		}
		for (let i = 0; i < USERS; i += 1) {
			await fresh.profiles.insertProfile({
				userId: `trader${i}`,
				handle: `trader${i}`,
				email: `trader${i}@test.dev`,
				balance: SIGNUP_BONUS
			});
		}
		for (let i = 0; i < BET_COUNT; i += 1) {
			await fresh.placeBet({
				userId: `trader${i % USERS}`,
				tradeDate: THURSDAY,
				underlying: LADDER_UNDERLYINGS[i % 3],
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 10,
				cutoffAtMs: cutoffOf(THURSDAY),
				nowMs: duringBetting(THURSDAY)
			});
		}
		// NIFTY hits (+50); BANKNIFTY and SENSEX each move a single point → flat.
		for (const underlying of LADDER_UNDERLYINGS) {
			await fresh.closes.upsertIndexClose({
				tradeDate: THURSDAY,
				underlying,
				close: underlying === 'nifty' ? ANCHORS.nifty + 50 : ANCHORS[underlying] + 1,
				source: 'official'
			});
		}
		invalidateLadderCache();
		return fresh;
	};

	it('splits 12 bets into 3 transactions of 5 and lands on the same numbers', async () => {
		const chunked = await buildDay();
		const whole = await buildDay();

		const chunkedReport = await settle(chunked, THURSDAY, { chunkSize: 5 });
		const wholeReport = await settle(whole, THURSDAY, { chunkSize: 5000 });

		expect(chunkedReport.chunks).toBe(3);
		expect(wholeReport.chunks).toBe(1);
		expect(chunkedReport.settled).toBe(BET_COUNT);
		expect(wholeReport.settled).toBe(BET_COUNT);
		expect(chunkedReport.paidOut).toBe(wholeReport.paidOut);
		expect(chunkedReport.xpAwarded).toBe(wholeReport.xpAwarded);

		// A chunk boundary changes no number: same pots, same wallets, same stats.
		expect(await potOf(chunked, THURSDAY)).toEqual(await potOf(whole, THURSDAY));
		for (let i = 0; i < USERS; i += 1) {
			expect(await profileOf(chunked, `trader${i}`)).toEqual(await profileOf(whole, `trader${i}`));
			expect(await statsOf(chunked, `trader${i}`)).toEqual(await statsOf(whole, `trader${i}`));
			expect(await ledgerOf(chunked, `trader${i}`)).toEqual(await ledgerOf(whole, `trader${i}`));
		}
		// The money invariants hold for the chunked store too.
		store = chunked;
		await expectMoneyInvariants(store, THURSDAY);
	});

	it('re-running a chunked day settles nothing and pays nothing', async () => {
		const chunked = await buildDay();
		await settle(chunked, THURSDAY, { chunkSize: 5 });
		const again = await settle(chunked, THURSDAY, { chunkSize: 5 });
		expect(again).toMatchObject({ status: 'already-settled', idempotent: true, settled: 0 });
	});
});

// ---------------------------------------------------------------------------
// incomplete days and session states
// ---------------------------------------------------------------------------

describe('a day that cannot be settled honestly', () => {
	it('leaves an index without an anchor unsettled and reopens the session', async () => {
		await newUser('priya');
		await place('priya', { underlying: 'nifty', deltaPoints: 50, odds: 6 });
		await place('priya', { underlying: 'sensex', deltaPoints: 400, odds: 3.8 });
		await publishMoves(THURSDAY, { nifty: 50, sensex: 600 });
		// SENSEX has no usable previous-day close: no anchor, no honest verdict.
		await seedAnchors(WEDNESDAY, { sensex: 0 });

		const report = await settle(store, THURSDAY);

		expect(report.status).toBe('incomplete');
		expect(report.incomplete).toEqual(['sensex']);
		expect(report.reason).toContain('sensex');
		expect(report.settled).toBe(1);
		expect((await sessionOf(store, THURSDAY)).status).toBe('open');

		const bets = await betsOf(store, THURSDAY);
		expect(bets.find((bet) => bet.underlying === 'sensex')?.settledAt).toBeNull();
		expect(bets.find((bet) => bet.underlying === 'nifty')?.settlementTier).toBe('hit');

		// The anchor arrives late: the same call finishes the day without touching
		// what it already paid.
		await seedAnchors(WEDNESDAY, { sensex: ANCHORS.sensex });
		const second = await settle(store, THURSDAY);

		expect(second.status).toBe('settled');
		expect(second.settled).toBe(1);
		expect(second.skipped).toBe(0);
		expect(await balanceOf(store, 'priya')).toBe(1_000 - 200 + 600);
		expect(await xpOf(store, 'priya')).toBe(XP_PER_BET * 2 + XP_PER_HIT);
		await expectMoneyInvariants(store, THURSDAY);
	});

	it('refuses a day with no session row instead of inventing one', async () => {
		const report = await settle(store, '2030-01-01');
		expect(report).toMatchObject({
			status: 'no-session',
			sessionId: null,
			settled: 0,
			idempotent: false
		});
		expect(await store.sessions.getSessionByDate('2030-01-01')).toBeNull();
	});

	it('backs off when another run owns the session', async () => {
		await newUser('priya');
		await place('priya', { underlying: 'nifty', deltaPoints: 50, odds: 6 });
		await publishMoves(THURSDAY, { nifty: 50 });
		const session = await sessionOf(store, THURSDAY);
		await store.sessions.setSessionStatus(session.id, 'settling');

		const report = await settle(store, THURSDAY);

		expect(report.status).toBe('busy');
		expect(report.settled).toBe(0);
		expect((await sessionOf(store, THURSDAY)).status).toBe('settling');
	});

	it('settles an empty day immediately', async () => {
		const report = await settle(store, THURSDAY);
		expect(report).toMatchObject({ status: 'settled', settled: 0, chunks: 0, paidOut: 0 });
		expect(report.users).toEqual([]);
		expect((await sessionOf(store, THURSDAY)).status).toBe('settled');
	});

	it('releases the claim when the store throws, so the day can be retried', async () => {
		await newUser('priya');
		await place('priya', { underlying: 'nifty', deltaPoints: 50, odds: 6 });
		await publishMoves(THURSDAY, { nifty: 50 });

		const realSettleBets = store.settleBets.bind(store);
		store.settleBets = async () => {
			throw new Error('connection reset');
		};
		await expect(settle(store, THURSDAY)).rejects.toThrow('connection reset');
		expect((await sessionOf(store, THURSDAY)).status).toBe('open');

		store.settleBets = realSettleBets as typeof store.settleBets;
		const report = await settle(store, THURSDAY);
		expect(report.status).toBe('settled');
		expect(report.settled).toBe(1);
		await expectMoneyInvariants(store, THURSDAY);
	});
});

describe('prevTradingDay', () => {
	it('skips weekends without stopping at them', () => {
		expect(prevTradingDay(THURSDAY)).toBe(WEDNESDAY);
		expect(prevTradingDay(FRIDAY)).toBe(THURSDAY);
		expect(prevTradingDay(MONDAY)).toBe(FRIDAY);
		expect(prevTradingDay(TUESDAY)).toBe(MONDAY);
	});
});
