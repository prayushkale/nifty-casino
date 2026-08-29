/**
 * The four T14 readers — contract tests for the shapes `/leaderboard` and
 * `/history` are built on (PLAN §5 T14).
 *
 * ONE SUITE, TWO DRIVERS. `runScenarios` is written once and driven twice:
 *
 *   • against `MemoryStore` ALWAYS — it needs no env vars, no network;
 *   • against `PostgresStore` under `describe.skipIf(!DATABASE_URL)`, the same
 *     gate the driver's own integration suite (`./postgres.test.ts`) uses, so the
 *     SQL is exercised wherever a database is actually pointed at:
 *       DATABASE_URL="postgresql://…" npx vitest run src/lib/server/db/leaderboard-readers.test.ts
 *
 * The harness is what makes that possible: it hands the scenarios a store, the
 * user ids to bet with, and an `advance()` that moves the SEEDED clock forward.
 * Memory owns its clock, so `advance` really moves `created_at`; Postgres stamps
 * `now()` itself, so `advance` is a no-op there — but rows inserted in successive
 * statements are still time-ordered, which is all the ordering scenarios need.
 * The one test that must FORCE equal timestamps is memory-only, because
 * Postgres' clock cannot be pinned.
 *
 * Throwaway keys only: fixed uuids under throwaway trade dates, wiped before AND
 * after the run, so re-running against the same database is idempotent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { MemoryStore } from './memory';
import { PostgresStore } from './postgres';
import type { GameStore } from './interface';
import { MAX_LEADERBOARD_ROWS } from '$lib/config/app';
import { shiftIstDate } from '$lib/time/ist';

/** Deterministic uuid-shaped ids — valid values for Postgres' `uuid` columns. */
const testUuid = (n: number): string =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The player ids the balance-cap and streak-cap scenarios mint, in one place so the wipe covers them. */
const capUserId = (i: number): string => testUuid(100 + i);
const streakUserId = (i: number): string => testUuid(200 + i);

/** IST 15:20:00 of `dateStr` (the session's cutoff), from its UTC-midnight form. */
const cutoffOf = (dateStr: string): number => Date.parse(`${dateStr}T09:50:00.000Z`);

// ---------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------

type PlayerKey = 'priya' | 'arjun' | 'meera' | 'zoya';

type Harness = {
	/** The store under test. Fresh per test in memory, shared (and wiped) in Postgres. */
	store: GameStore;
	/** Fixed ids per player alias, so a scenario never has to look one up. */
	users: Record<PlayerKey, string>;
	/**
	 * Move the seeded clock forward one step before the next write. A no-op when
	 * the driver owns the clock.
	 */
	advance: () => Promise<void>;
	/** The trade date the ⚡ section is asked about, and the two days before it. */
	tradeDate: string;
	prevDate: string;
	prev2Date: string;
};

/** The four players every scenario starts from — wallet, XP, streak, counters. */
const PLAYERS: Record<
	PlayerKey,
	{ handle: string; balance: number; xp: number; streak: number; placed: number; won: number }
> = {
	// arjun and meera TIE on balance; meera's higher XP must rank first.
	arjun: { handle: 'arjun', balance: 9_000, xp: 300, streak: 0, placed: 12, won: 4 },
	meera: { handle: 'meera', balance: 9_000, xp: 1_500, streak: 3, placed: 8, won: 2 },
	priya: { handle: 'priya', balance: 5_000, xp: 4_000, streak: 6, placed: 30, won: 18 },
	zoya: { handle: 'zoya', balance: 100, xp: 30, streak: 0, placed: 3, won: 0 }
};

/** Insert the players (wallet, XP, streak, precomputed counters) and today's session. */
async function seedPlayers(h: Harness): Promise<void> {
	await h.store.sessions.ensureSession(h.tradeDate, cutoffOf(h.tradeDate));
	for (const key of Object.keys(PLAYERS) as PlayerKey[]) {
		const userId = h.users[key];
		const player = PLAYERS[key];
		await h.store.profiles.insertProfile({
			userId,
			handle: player.handle,
			// Never leaves the store: the leaderboard is asserted not to carry it.
			email: `${player.handle}@example.com`,
			balance: player.balance
		});
		await h.store.profiles.applyProfileProgress(userId, {
			xpDelta: player.xp,
			streakDays: player.streak,
			lastBetDate: player.streak > 0 ? h.tradeDate : h.prevDate
		});
		await h.store.stats.applyStatsDelta(userId, {
			betsPlaced: player.placed,
			betsWon: player.won,
			totalStaked: player.placed * 100,
			totalWon: player.won * 250,
			bestPayout: player.won > 0 ? 600 : 0
		});
	}
}

/** One bet, placed and immediately settled. Uses `h.advance()` for its timestamp. */
async function seedBet(
	h: Harness,
	input: {
		user: PlayerKey;
		underlying: 'nifty' | 'banknifty' | 'sensex';
		targetKind: 'up' | 'down';
		deltaPoints: number;
		odds: number;
		stake: number;
		tier: 'hit' | 'flat' | 'miss';
		payout: number;
		day?: string;
	}
): Promise<string> {
	const day = input.day ?? h.tradeDate;
	const session = await h.store.sessions.ensureSession(day, cutoffOf(day));
	await h.advance();
	const bet = await h.store.bets.upsertBet({
		userId: h.users[input.user],
		sessionId: session.id,
		underlying: input.underlying,
		targetKind: input.targetKind,
		deltaPoints: input.deltaPoints,
		odds: input.odds,
		stake: input.stake
	});
	await h.store.bets.setBetOutcome(bet.id, input.tier, input.payout, Date.now());
	return bet.id;
}

/** A full day of settled bets for one player — the most one index-set allows. */
async function seedSettledDay(h: Harness, user: PlayerKey, day?: string): Promise<void> {
	const calls = [
		{ underlying: 'nifty' as const, deltaPoints: 50, odds: 6 },
		{ underlying: 'banknifty' as const, deltaPoints: 200, odds: 4.5 },
		{ underlying: 'sensex' as const, deltaPoints: 250, odds: 4.5 }
	];
	for (const call of calls) {
		await seedBet(h, { user, ...call, targetKind: 'up', stake: 10, tier: 'hit', payout: 60, day });
	}
}

// ---------------------------------------------------------------------------
// the scenarios — run verbatim against both drivers
// ---------------------------------------------------------------------------

function runScenarios(makeHarness: () => Promise<Harness>): void {
	describe('profiles.listTopBalances', () => {
		it('orders by balance, breaks ties on XP, and carries the joined counters', async () => {
			const h = await makeHarness();
			await seedPlayers(h);

			const rows = await h.store.profiles.listTopBalances(10);

			expect(rows.map((row) => row.handle)).toEqual(['meera', 'arjun', 'priya', 'zoya']);
			// The tie-break is why this is asserted field by field: two equal wallets
			// must rank the same way on every node, on every render.
			expect(rows[0]).toEqual({
				handle: 'meera',
				balance: 9_000,
				xp: 1_500,
				streakDays: 3,
				betsPlaced: 8,
				betsWon: 2
			});
		});

		it('carries no email and no user id — only the public identity', async () => {
			const h = await makeHarness();
			await seedPlayers(h);

			const text = JSON.stringify(await h.store.profiles.listTopBalances(10)).toLowerCase();
			expect(text).not.toContain('email');
			expect(text).not.toContain('example.com');
			expect(text).not.toContain('user_id');
			expect(text).not.toContain('userid');
			expect(text).not.toContain(testUuid(1).slice(0, 18));
		});

		it('keeps a funded player who has no user_stats row yet, with zeroed counters', async () => {
			const h = await makeHarness();
			await h.store.profiles.insertProfile({
				userId: h.users.priya,
				handle: 'newcomer',
				email: 'newcomer@example.com',
				balance: 500
			});

			expect(await h.store.profiles.listTopBalances(10)).toEqual([
				{ handle: 'newcomer', balance: 500, xp: 0, streakDays: 0, betsPlaced: 0, betsWon: 0 }
			]);
		});

		it('honours the caller limit and clamps to the documented product cap', async () => {
			const h = await makeHarness();
			for (let i = 0; i < 12; i += 1) {
				await h.store.profiles.insertProfile({
					userId: capUserId(i),
					handle: `board${String(i).padStart(2, '0')}`,
					email: `board${i}@example.com`,
					balance: 1_000 - i
				});
			}

			expect(await h.store.profiles.listTopBalances(3)).toHaveLength(3);
			const over = await h.store.profiles.listTopBalances(MAX_LEADERBOARD_ROWS + 500);
			expect(over.length).toBeLessThanOrEqual(MAX_LEADERBOARD_ROWS);
			expect(over[0]?.balance).toBe(1_000);
		});

		it('reads a zero limit as "no rows", never as "unbounded"', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			expect(await h.store.profiles.listTopBalances(0)).toEqual([]);
		});
	});

	describe('profiles.listTopStreaks', () => {
		it('ranks only the players with a streak, longest first, XP alongside', async () => {
			const h = await makeHarness();
			await seedPlayers(h);

			const rows = await h.store.profiles.listTopStreaks(10);

			expect(rows).toEqual([
				{ handle: 'priya', streakDays: 6, xp: 4_000 },
				{ handle: 'meera', streakDays: 3, xp: 1_500 }
			]);
			expect(JSON.stringify(rows).toLowerCase()).not.toContain('example.com');
		});

		it('answers nothing on a fresh instance rather than rows of "0 days"', async () => {
			const h = await makeHarness();
			await h.store.profiles.insertProfile({
				userId: h.users.priya,
				handle: 'priya',
				email: 'priya@example.com',
				balance: 1_000
			});
			expect(await h.store.profiles.listTopStreaks(10)).toEqual([]);
		});

		it('caps at the requested limit', async () => {
			const h = await makeHarness();
			for (let i = 0; i < 7; i += 1) {
				const userId = streakUserId(i);
				await h.store.profiles.insertProfile({
					userId,
					handle: `streak${i}`,
					email: `streak${i}@example.com`,
					balance: 1_000
				});
				await h.store.profiles.applyProfileProgress(userId, {
					xpDelta: 10,
					streakDays: i + 1,
					lastBetDate: h.tradeDate
				});
			}
			expect((await h.store.profiles.listTopStreaks(3)).map((row) => row.streakDays)).toEqual([
				7, 6, 5
			]);
		});
	});

	describe('bets.listTopWinsForDate', () => {
		it("ranks the day's settled payouts with the player and the call attached", async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			// One bet per index, spread over three players so nothing collides.
			await seedBet(h, {
				user: 'priya',
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 100,
				tier: 'hit',
				payout: 600
			});
			await seedBet(h, {
				user: 'arjun',
				underlying: 'sensex',
				targetKind: 'down',
				deltaPoints: 250,
				odds: 4.5,
				stake: 300,
				tier: 'hit',
				payout: 1_350
			});
			await seedBet(h, {
				user: 'zoya',
				underlying: 'banknifty',
				targetKind: 'up',
				deltaPoints: 100,
				odds: 6,
				stake: 50,
				tier: 'miss',
				payout: 0
			});

			const rows = await h.store.bets.listTopWinsForDate(h.tradeDate, 10);

			expect(rows.map((row) => row.payout)).toEqual([1_350, 600, 0]);
			expect(rows[0]).toEqual({
				handle: 'arjun',
				underlying: 'sensex',
				targetKind: 'down',
				deltaPoints: 250,
				stake: 300,
				payout: 1_350,
				odds: 4.5,
				settlementTier: 'hit'
			});
			// A miss is a ranked row too — it lost, it did not vanish.
			expect(rows[2]).toMatchObject({ handle: 'zoya', settlementTier: 'miss', payout: 0 });
		});

		it('breaks payout ties on handle, deterministically', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			const call = { odds: 6, stake: 100, tier: 'hit' as const, payout: 600 };
			await seedBet(h, {
				...call,
				user: 'zoya',
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50
			});
			await seedBet(h, {
				...call,
				user: 'priya',
				underlying: 'banknifty',
				targetKind: 'up',
				deltaPoints: 100
			});
			await seedBet(h, {
				...call,
				user: 'meera',
				underlying: 'sensex',
				targetKind: 'up',
				deltaPoints: 150
			});

			const rows = await h.store.bets.listTopWinsForDate(h.tradeDate, 10);
			expect(rows.map((row) => row.handle)).toEqual(['meera', 'priya', 'zoya']);
		});

		it("does not leak another day's settled bets into the day asked about", async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			await h.store.sessions.ensureSession(h.prevDate, cutoffOf(h.prevDate));
			await seedBet(h, {
				user: 'priya',
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 100,
				tier: 'hit',
				payout: 900,
				day: h.prevDate
			});

			expect(await h.store.bets.listTopWinsForDate(h.tradeDate, 10)).toEqual([]);
			expect(await h.store.bets.listTopWinsForDate(h.prevDate, 10)).toHaveLength(1);
		});

		it('leaves open bets off a public board and honours the cap', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			await seedBet(h, {
				user: 'priya',
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 100,
				tier: 'hit',
				payout: 600
			});
			await seedBet(h, {
				user: 'arjun',
				underlying: 'banknifty',
				targetKind: 'down',
				deltaPoints: 200,
				odds: 4.5,
				stake: 100,
				tier: 'flat',
				payout: 100
			});
			// meera's bet is placed but never settled — no outcome, no board row.
			const session = await h.store.sessions.getSessionByDate(h.tradeDate);
			await h.advance();
			await h.store.bets.upsertBet({
				userId: h.users.meera,
				sessionId: session?.id ?? 0,
				underlying: 'sensex',
				targetKind: 'up',
				deltaPoints: 150,
				odds: 6,
				stake: 25
			});

			const rows = await h.store.bets.listTopWinsForDate(h.tradeDate, 10);
			expect(rows.map((row) => row.handle)).toEqual(['priya', 'arjun']);
			expect(await h.store.bets.listTopWinsForDate(h.tradeDate, 1)).toHaveLength(1);
		});
	});

	describe('bets.listBetsForUserPage', () => {
		it('serves every status, newest first, capped by the caller', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			// Yesterday's three settled bets …
			await h.store.sessions.ensureSession(h.prevDate, cutoffOf(h.prevDate));
			await seedSettledDay(h, 'priya', h.prevDate);
			// … and one LIVE bet today (it takes today's nifty slot, which was empty).
			const session = await h.store.sessions.getSessionByDate(h.tradeDate);
			await h.advance();
			await h.store.bets.upsertBet({
				userId: h.users.priya,
				sessionId: session?.id ?? 0,
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 100,
				odds: 4.5,
				stake: 20
			});

			const page = await h.store.bets.listBetsForUserPage(h.users.priya, { limit: 10 });
			expect(page).toHaveLength(4);
			// Newest first, and the LIVE bet is on the player's own log.
			expect(page[0]).toMatchObject({ settlementTier: null, stake: 20 });
			expect(page.map((bet) => bet.settlementTier)).toEqual([null, 'hit', 'hit', 'hit']);
			expect(await h.store.bets.listBetsForUserPage(h.users.priya, { limit: 2 })).toHaveLength(2);
		});

		it('paginates: page after page joins to the full set with no repeat and no gap', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			await h.store.sessions.ensureSession(h.prevDate, cutoffOf(h.prevDate));
			await h.store.sessions.ensureSession(h.prev2Date, cutoffOf(h.prev2Date));
			// Two days × three indices = six rows for one player.
			await seedSettledDay(h, 'arjun', h.prevDate);
			await seedSettledDay(h, 'arjun', h.prev2Date);

			const ids: string[] = [];
			let cursor: { beforeCreatedAt?: number; beforeId?: string } = {};
			for (let page = 0; page < 6; page += 1) {
				const rows = await h.store.bets.listBetsForUserPage(h.users.arjun, {
					...cursor,
					limit: 2
				});
				ids.push(...rows.map((bet) => bet.id));
				if (rows.length < 2) break;
				const last = rows[1];
				cursor = { beforeCreatedAt: last.createdAt, beforeId: last.id };
			}

			expect(ids).toHaveLength(6);
			expect(new Set(ids).size).toBe(6);
		});

		it('answers an empty page at the end of the log and for a player who never bet', async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			await seedSettledDay(h, 'meera');

			const page = await h.store.bets.listBetsForUserPage(h.users.meera, { limit: 3 });
			expect(page).toHaveLength(3);
			const oldest = page[2];
			expect(
				await h.store.bets.listBetsForUserPage(h.users.meera, {
					limit: 3,
					beforeCreatedAt: oldest.createdAt,
					beforeId: oldest.id
				})
			).toEqual([]);
			expect(await h.store.bets.listBetsForUserPage(h.users.zoya, { limit: 3 })).toEqual([]);
		});

		it("never hands one player another player's rows", async () => {
			const h = await makeHarness();
			await seedPlayers(h);
			await seedSettledDay(h, 'arjun');
			expect(await h.store.bets.listBetsForUserPage(h.users.priya, { limit: 10 })).toEqual([]);
		});
	});
}

// ---------------------------------------------------------------------------
// memory — always
// ---------------------------------------------------------------------------

describe('MemoryStore T14 readers', () => {
	const START = Date.parse('2026-08-27T09:30:00.000Z');
	let clock = START;

	const makeHarness = async (): Promise<Harness> => ({
		store: new MemoryStore({ now: () => clock }),
		users: {
			priya: testUuid(1),
			arjun: testUuid(2),
			meera: testUuid(3),
			zoya: testUuid(4)
		},
		advance: async () => {
			clock += 60_000;
		},
		tradeDate: '2026-08-27',
		prevDate: shiftIstDate('2026-08-27', -1),
		prev2Date: shiftIstDate('2026-08-27', -2)
	});

	beforeEach(() => {
		clock = START;
	});

	runScenarios(makeHarness);
});

// ---------------------------------------------------------------------------
// postgres — only with a live DATABASE_URL
// ---------------------------------------------------------------------------

const databaseUrl = process.env['DATABASE_URL']?.trim();
const describeIntegration = describe.skipIf(!databaseUrl);

describeIntegration('PostgresStore T14 readers (integration)', () => {
	const DATE = '2099-12-31';
	const DATES = [DATE, shiftIstDate(DATE, -1), shiftIstDate(DATE, -2)];
	const USERS = {
		priya: testUuid(0xd1),
		arjun: testUuid(0xd2),
		meera: testUuid(0xd3),
		zoya: testUuid(0xd4)
	} as const;
	const CAP_IDS = Array.from({ length: 12 }, (_, i) => capUserId(i));
	const STREAK_IDS = Array.from({ length: 7 }, (_, i) => streakUserId(i));
	const ALL_IDS = [...Object.values(USERS), ...CAP_IDS, ...STREAK_IDS];

	let store: PostgresStore;
	let sql: postgres.Sql;

	const wipe = async (): Promise<void> => {
		await sql`delete from ledger where user_id = any(${ALL_IDS})`;
		await sql`delete from bets where user_id = any(${ALL_IDS})`;
		await sql`delete from user_stats where user_id = any(${ALL_IDS})`;
		await sql`delete from profiles where user_id = any(${ALL_IDS})`;
		await sql`delete from daily_pots where trade_date = any(${DATES})`;
		await sql`delete from daily_sessions where trade_date = any(${DATES})`;
	};

	beforeAll(async () => {
		store = new PostgresStore(databaseUrl as string);
		sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
		await wipe();
	});

	afterAll(async () => {
		await wipe();
		await sql.end({ timeout: 5 });
		await store.close();
	});

	const makeHarness = async (): Promise<Harness> => ({
		store,
		users: USERS as Record<PlayerKey, string>,
		// Postgres owns `created_at`; successive statements are time-ordered already.
		advance: async () => {},
		tradeDate: DATE,
		prevDate: DATES[1] as string,
		prev2Date: DATES[2] as string
	});

	runScenarios(makeHarness);
});

// ---------------------------------------------------------------------------
// memory-only — the cursor edge that needs to own the clock
// ---------------------------------------------------------------------------

describe('MemoryStore listBetsForUserPage — same-instant keyset', () => {
	/**
	 * The scenario the shared runner cannot express: three bets stamped with the
	 * SAME millisecond, walked two at a time. A pure `created_at <` cursor drops
	 * the third row here; the `beforeId` half of the cursor is what keeps it.
	 */
	it('does not drop a row whose timestamp ties with the page boundary', async () => {
		const at = Date.parse('2026-08-27T09:30:00.000Z');
		const store = new MemoryStore({ now: () => at });
		const session = await store.sessions.ensureSession('2026-08-27', cutoffOf('2026-08-27'));
		await store.profiles.insertProfile({
			userId: 'u_tie',
			handle: 'ticktock',
			email: 'tick@example.com',
			balance: 1_000
		});

		const placed: string[] = [];
		for (const underlying of ['nifty', 'banknifty', 'sensex'] as const) {
			const bet = await store.bets.upsertBet({
				userId: 'u_tie',
				sessionId: session.id,
				underlying,
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 10
			});
			placed.push(bet.id);
		}
		expect(new Set(placed).size).toBe(3);

		const first = await store.bets.listBetsForUserPage('u_tie', { limit: 2 });
		expect(first).toHaveLength(2);
		expect(first[0].createdAt).toBe(first[1].createdAt); // the tie the cursor must beat

		const second = await store.bets.listBetsForUserPage('u_tie', {
			limit: 2,
			beforeCreatedAt: first[1].createdAt,
			beforeId: first[1].id
		});
		expect(second.map((bet) => bet.id)).toEqual([placed[0]]);

		// Lossless end to end, and the page after the last row is genuinely empty.
		expect([...first, ...second].map((bet) => bet.id).sort()).toEqual([...placed].sort());
		expect(
			await store.bets.listBetsForUserPage('u_tie', {
				limit: 2,
				beforeCreatedAt: second[0].createdAt,
				beforeId: second[0].id
			})
		).toEqual([]);
	});
});
