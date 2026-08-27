/**
 * Postgres driver tests.
 *
 * Two layers:
 *  1. Always-on unit tests for the parts that need no database — the pool/pooler
 *     decisions derived from DATABASE_URL, log masking, and the snake_case→camelCase
 *     row mapping (which is where a driver silently mangles dates).
 *  2. An integration suite that only runs when DATABASE_URL points at a real Postgres
 *     (`describe.skipIf`), so CI and every local run stay green with zero env vars:
 *       DATABASE_URL="postgresql://…" npx vitest run src/lib/server/db/postgres.test.ts
 *     It writes only its own throwaway keys and cleans up after itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
	AlreadySettledError,
	DuplicatePayoutError,
	InsufficientFundsError,
	NotFoundError
} from './interface';
import {
	PostgresStore,
	buildPoolOptions,
	maskDatabaseUrl,
	resolvePrepareFlag,
	resolveSsl,
	rowMappers
} from './postgres';

// ---------------------------------------------------------------------------
// 1. pure — connection-string decisions
// ---------------------------------------------------------------------------

describe('pool options from DATABASE_URL', () => {
	it.each([
		[
			'session pooler (port 5432)',
			'postgresql://postgres.ab:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
			true
		],
		['direct connection (no port)', 'postgresql://postgres:pw@db.ab.supabase.co/postgres', true],
		['localhost', 'postgresql://postgres:pw@localhost:5432/nifty', true],
		[
			'transaction pooler (port 6543)',
			'postgresql://postgres.ab:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
			false
		]
	])('%s → prepare %j', (_name, url, expected) => {
		expect(resolvePrepareFlag(url)).toBe(expected);
	});

	it('defaults to prepared statements when the URL is unusable', () => {
		expect(resolvePrepareFlag('not-a-url')).toBe(true);
	});

	it.each([
		[
			'requires TLS for an off-host URL',
			'postgresql://postgres:pw@aws-0.pooler.supabase.com:5432/postgres',
			'require'
		],
		['skips TLS for a local Postgres', 'postgresql://postgres:pw@localhost:5432/nifty', false],
		['skips TLS for the loopback address', 'postgresql://postgres:pw@127.0.0.1:5432/nifty', false],
		['defers to an explicit sslmode', 'postgresql://postgres:pw@h/db?sslmode=require', undefined],
		['defers to sslmode=disable', 'postgresql://postgres:pw@h/db?sslmode=disable', undefined]
	])('%s', (_name, url, expected) => {
		expect(resolveSsl(url)).toBe(expected);
	});

	it('never turns TLS on for an unparseable URL', () => {
		expect(resolveSsl('garbage')).toBeUndefined();
	});

	it('builds a bounded pool and forces prepare off for the transaction pooler', () => {
		const opts = buildPoolOptions(
			'postgresql://postgres:pw@aws-0.pooler.supabase.com:6543/postgres',
			3
		);
		expect(opts).toMatchObject({
			prepare: false,
			max: 3,
			idle_timeout: 30,
			connect_timeout: 10,
			ssl: 'require'
		});
	});

	it('does not override an sslmode the URL already carries', () => {
		// postgres.js prefers a passed `ssl` over the query string, so the key must be
		// absent for `?sslmode=...` to reach the driver.
		const opts = buildPoolOptions(
			'postgresql://postgres:pw@db.x.supabase.co:5432/postgres?sslmode=disable'
		);
		expect('ssl' in opts).toBe(false);
	});
});

describe('maskDatabaseUrl', () => {
	it('hides the password but keeps the shape of the connection', () => {
		expect(
			maskDatabaseUrl('postgresql://postgres:s3cr3t@aws-0.pooler.supabase.com:5432/postgres')
		).toBe('postgresql://postgres:***@aws-0.pooler.supabase.com:5432/postgres');
	});

	it('never throws on a bad URL, and never leaks a password it cannot parse', () => {
		expect(maskDatabaseUrl('garbage')).toBe('DATABASE_URL (unparseable)');
	});
});

// ---------------------------------------------------------------------------
// 2. pure — row mapping (snake_case → camelCase, and the driver's type quirks)
// ---------------------------------------------------------------------------

describe('row mapping', () => {
	it('reads a DATE column as the same calendar day whether the driver hands back text or a Date', () => {
		expect(rowMappers.date('2026-08-27')).toBe('2026-08-27');
		expect(rowMappers.date('2026-08-27T00:00:00')).toBe('2026-08-27');

		// postgres.js parses DATE into a Date at LOCAL midnight; toISOString() would
		// return the previous day on any positive UTC offset (IST included).
		const localMidnight = new Date(2026, 7, 27);
		expect(rowMappers.date(localMidnight)).toBe('2026-08-27');
	});

	it('reads timestamptz as epoch ms from a Date or an ISO string', () => {
		const instant = Date.parse('2026-08-27T09:50:00.000Z');
		expect(rowMappers.ms(new Date(instant))).toBe(instant);
		expect(rowMappers.ms('2026-08-27T09:50:00.000Z')).toBe(instant);
		expect(rowMappers.ms(instant)).toBe(instant);
		expect(rowMappers.ms(null)).toBe(0);
	});

	it('reads numeric/int/bigint columns as numbers even when they arrive as text', () => {
		expect(rowMappers.num('25012.25')).toBe(25012.25);
		expect(rowMappers.num(42)).toBe(42);
		expect(rowMappers.num('1000000')).toBe(1_000_000); // bigint as text
		expect(rowMappers.num(null)).toBe(0);
		expect(rowMappers.numOrNull(null)).toBeNull();
		expect(rowMappers.numOrNull('600')).toBe(600);
	});

	it('maps a bets row to a Bet', () => {
		const settled = Date.parse('2026-08-27T10:15:00.000Z');
		expect(
			rowMappers.bet({
				id: '11111111-1111-1111-1111-111111111111',
				user_id: '22222222-2222-2222-2222-222222222222',
				session_id: '7',
				underlying: 'nifty',
				target_kind: 'up',
				delta_points: '50.00',
				odds: '6.00',
				stake: 100,
				settlement_tier: 'hit',
				payout: 600,
				settled_at: new Date(settled),
				created_at: new Date(settled - 1000)
			})
		).toEqual({
			id: '11111111-1111-1111-1111-111111111111',
			userId: '22222222-2222-2222-2222-222222222222',
			sessionId: 7,
			underlying: 'nifty',
			targetKind: 'up',
			deltaPoints: 50,
			odds: 6,
			stake: 100,
			settlementTier: 'hit',
			payout: 600,
			settledAt: settled,
			createdAt: settled - 1000
		});
	});

	it('keeps pre-settlement NULLs as null', () => {
		const bet = rowMappers.bet({
			id: 'a',
			user_id: 'b',
			session_id: 1,
			underlying: 'sensex',
			target_kind: 'down',
			delta_points: '250',
			odds: '4.5',
			stake: 10,
			settlement_tier: null,
			payout: null,
			settled_at: null,
			created_at: new Date(0)
		});
		expect(bet.settlementTier).toBeNull();
		expect(bet.payout).toBeNull();
		expect(bet.settledAt).toBeNull();
	});

	it('maps profiles, sessions, pots, stats, ledger, ticks and closes', () => {
		const created = Date.parse('2026-08-27T04:00:00.000Z');
		expect(
			rowMappers.profile({
				user_id: 'u',
				handle: 'priya',
				email: 'P@X.dev',
				balance: 1000,
				xp: '10',
				streak_days: 3,
				last_bet_date: null,
				created_at: new Date(created)
			})
		).toEqual({
			userId: 'u',
			handle: 'priya',
			email: 'P@X.dev',
			balance: 1000,
			xp: 10,
			streakDays: 3,
			lastBetDate: null,
			createdAt: created
		});
		expect(
			rowMappers.session({
				id: 1,
				trade_date: new Date(2026, 7, 27),
				status: 'open',
				cutoff_at: new Date(created),
				created_at: new Date(created)
			})
		).toEqual({
			id: 1,
			tradeDate: '2026-08-27',
			status: 'open',
			cutoffAt: created,
			createdAt: created
		});
		expect(
			rowMappers.pot({
				trade_date: '2026-08-27',
				total_bets: '2',
				total_staked: '350',
				total_paid_out: '0',
				players_count: '1',
				updated_at: new Date(created)
			})
		).toMatchObject({
			tradeDate: '2026-08-27',
			totalBets: 2,
			totalStaked: 350,
			totalPaidOut: 0,
			playersCount: 1
		});
		expect(
			rowMappers.stats({
				user_id: 'u',
				bets_placed: 2,
				bets_won: 1,
				total_staked: '150',
				total_won: '300',
				best_payout: 300,
				updated_at: new Date(created)
			})
		).toMatchObject({
			userId: 'u',
			betsPlaced: 2,
			betsWon: 1,
			totalStaked: 150,
			totalWon: 300,
			bestPayout: 300
		});
		expect(
			rowMappers.ledger({
				id: 9,
				user_id: 'u',
				kind: 'payout',
				amount: 600,
				ref_bet_id: 'r',
				balance_after: 1500,
				created_at: new Date(created)
			})
		).toEqual({
			id: 9,
			userId: 'u',
			kind: 'payout',
			amount: 600,
			refBetId: 'r',
			balanceAfter: 1500,
			createdAt: created
		});
		expect(
			rowMappers.tick({
				trade_date: '2026-08-27',
				underlying: 'nifty',
				ts: new Date(created),
				value: '25012.25',
				change_pts: '12.5',
				change_pct: '0.05'
			})
		).toEqual({
			tradeDate: '2026-08-27',
			underlying: 'nifty',
			ts: created,
			value: 25012.25,
			changePts: 12.5,
			changePct: 0.05
		});
		expect(
			rowMappers.close({
				trade_date: '2026-08-27',
				underlying: 'sensex',
				close: '82110.4',
				source: 'official'
			})
		).toEqual({
			tradeDate: '2026-08-27',
			underlying: 'sensex',
			close: 82110.4,
			source: 'official'
		});
	});
});

// ---------------------------------------------------------------------------
// 3. integration — only with a live DATABASE_URL
// ---------------------------------------------------------------------------

const databaseUrl = process.env['DATABASE_URL']?.trim();
const describeIntegration = describe.skipIf(!databaseUrl);

describeIntegration('PostgresStore (integration)', () => {
	const DATE = '2099-12-31';
	const CUTOFF = Date.parse('2099-12-31T09:50:00.000Z');
	const USER = '00000000-0000-4000-8000-00000000d001';

	let store: PostgresStore;
	let sql: postgres.Sql;

	beforeAll(() => {
		store = new PostgresStore(databaseUrl as string);
		// A second, independent handle purely for cleanup/verification.
		sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
	});

	afterAll(async () => {
		// Throwaway keys only: a date nobody will ever trade, and a fixed test uuid.
		await sql`delete from ledger where user_id = ${USER}`;
		await sql`delete from bets where user_id = ${USER}`;
		await sql`delete from user_stats where user_id = ${USER}`;
		await sql`delete from daily_pots where trade_date = ${DATE}`;
		await sql`delete from daily_sessions where trade_date = ${DATE}`;
		await sql.end({ timeout: 5 });
		await store.close();
	});

	it('connects', async () => {
		expect(await store.profiles.getProfile(USER)).toBeNull();
	});

	it('ensureSession is idempotent and first-write-wins on the cutoff', async () => {
		const first = await store.sessions.ensureSession(DATE, CUTOFF);
		const second = await store.sessions.ensureSession(DATE, CUTOFF + 5000);
		expect(second.id).toBe(first.id);
		expect(second.cutoffAt).toBe(CUTOFF);
	});

	it('enforces the wallet invariant and rolls the whole tx back on failure', async () => {
		await store.tx(async (t) => {
			await t.profiles.insertProfile({
				userId: USER,
				handle: 'pg_test_user',
				email: 'pg-test@example.com',
				balance: 1000
			});
			await t.ledger.appendLedger({
				userId: USER,
				kind: 'signup_bonus',
				amount: 1000,
				balanceAfter: 1000
			});
		});

		await expect(
			store.tx(async (t) => {
				await t.profiles.applyBalanceDelta(USER, -400); // would be rolled back
				await t.profiles.applyBalanceDelta(USER, -1000); // insufficient → throws
			})
		).rejects.toBeInstanceOf(InsufficientFundsError);

		expect((await store.profiles.getProfile(USER))?.balance).toBe(1000);
	});

	it('serializes concurrent balance ops (no lost update) via lockForUpdate', async () => {
		const concurrency = 10;
		await Promise.all(
			Array.from({ length: concurrency }, () =>
				store.tx(async (t) => {
					const profile = await t.profiles.lockForUpdate(USER);
					if (!profile) throw new NotFoundError('profile');
					await new Promise((r) => setTimeout(r, 5));
					return t.profiles.applyBalanceDelta(USER, 1);
				})
			)
		);
		expect((await store.profiles.getProfile(USER))?.balance).toBe(1000 + concurrency);
	});

	it('enforces payout-once from the ledger_payout_once index', async () => {
		const betId = await store.tx(async (t) => {
			const session = await t.sessions.getSessionByDate(DATE);
			const bet = await t.bets.upsertBet({
				userId: USER,
				sessionId: session?.id ?? 0,
				underlying: 'nifty',
				targetKind: 'up',
				deltaPoints: 50,
				odds: 6,
				stake: 10
			});
			await t.ledger.appendLedger({
				userId: USER,
				kind: 'payout',
				amount: 60,
				refBetId: bet.id,
				balanceAfter: 1010
			});
			return bet.id;
		});

		await expect(
			store.ledger.appendLedger({
				userId: USER,
				kind: 'payout',
				amount: 60,
				refBetId: betId,
				balanceAfter: 1020
			})
		).rejects.toBeInstanceOf(DuplicatePayoutError);
	});

	it('marks a bet settled once and refuses a second outcome', async () => {
		const bet = (await store.bets.getBetsForUserOnDate(USER, DATE))[0];
		await store.bets.setBetOutcome(bet.id, 'hit', 60, Date.now());
		await expect(store.bets.setBetOutcome(bet.id, 'miss', 0, Date.now())).rejects.toBeInstanceOf(
			AlreadySettledError
		);
	});

	it('applies pot and stats deltas with upsert arithmetic', async () => {
		await store.pots.applyPotDelta(DATE, { totalBets: 1, totalStaked: 10, playersCount: 1 });
		await store.pots.applyPotDelta(DATE, { totalBets: 1, totalStaked: 10, totalPaidOut: 60 });
		await store.stats.applyStatsDelta(USER, {
			betsPlaced: 1,
			betsWon: 1,
			totalStaked: 10,
			totalWon: 60,
			bestPayout: 60
		});
		await store.stats.applyStatsDelta(USER, { bestPayout: 5 });

		expect(await store.pots.getDailyPot(DATE)).toMatchObject({
			totalBets: 2,
			totalStaked: 20,
			totalPaidOut: 60
		});
		expect(await store.stats.getUserStats(USER)).toMatchObject({
			betsPlaced: 1,
			totalWon: 60,
			bestPayout: 60
		});
	});

	it('reads back a half-open tick window [fromTs, toTs)', async () => {
		const base = Date.parse('2099-12-31T10:00:00.000Z');
		await store.ticks.insertCasTicks(
			[1000, 2000, 3000].map((offset) => ({
				tradeDate: DATE,
				underlying: 'nifty' as const,
				ts: base + offset,
				value: 25000 + offset,
				changePts: offset,
				changePct: offset / 100
			}))
		);
		expect(
			await store.ticks.insertCasTicks([
				{
					tradeDate: DATE,
					underlying: 'nifty',
					ts: base + 1000,
					value: 1,
					changePts: 0,
					changePct: 0
				}
			])
		).toBe(0);

		const ticks = await store.ticks.getCasTicksRange(DATE, 'nifty', base + 1000, base + 3000, 100);
		expect(ticks.map((t) => t.ts)).toEqual([base + 1000, base + 2000]);
	});

	it('anchors off the latest close before a date', async () => {
		await store.closes.upsertIndexClose({
			tradeDate: '2099-12-30',
			underlying: 'nifty',
			close: 24950.5,
			source: 'official'
		});
		expect(await store.closes.getLatestCloseBefore(DATE, 'nifty')).toMatchObject({
			close: 24950.5
		});
	});

	it('upserts a bet on (user, session, underlying) instead of adding a second row', async () => {
		const session = await store.sessions.getSessionByDate(DATE);
		const first = await store.tx(async (t) =>
			t.bets.upsertBet({
				userId: USER,
				sessionId: session?.id ?? 0,
				underlying: 'sensex',
				targetKind: 'up',
				deltaPoints: 150,
				odds: 6,
				stake: 10
			})
		);
		const edited = await store.tx(async (t) =>
			t.bets.upsertBet({
				userId: USER,
				sessionId: session?.id ?? 0,
				underlying: 'sensex',
				targetKind: 'down',
				deltaPoints: 500,
				odds: 3.2,
				stake: 20
			})
		);
		expect(edited.id).toBe(first.id);
		expect(
			(await store.bets.getBetsForUserOnDate(USER, DATE)).filter((b) => b.underlying === 'sensex')
		).toHaveLength(1);
	});
});
