/**
 * PostgresStore — GameStore over postgres.js (https://github.com/porsager/postgres).
 *
 * WHY RAW SQL, NOT supabase-js: money operations need `SELECT … FOR UPDATE` to
 * serialize concurrent bets on the same wallet (PLAN §3) and PostgREST cannot express
 * row locks or multi-statement transactions. So the game store talks Postgres directly
 * over `DATABASE_URL` (Supabase's own connection string), while `supabase-js`
 * (../supabaseAdmin) is reserved for auth admin calls — which have no such requirement.
 *
 * CONNECTION POOLING NOTES
 * ------------------------
 * Supabase exposes three ways in, and the right one depends on how we deploy:
 *
 *   • Session pooler  (port 5432, `…pooler.supabase.com:5432/postgres`) — a real
 *     session per client, prepared statements fine. PREFERRED.
 *   • Transaction pooler (port 6543) — PgBouncer in transaction mode: the connection
 *     is reassigned after every statement, so PREPARE/`Bind` with named statements
 *     breaks. Set `prepare: false` (this driver auto-detects port 6543) and never
 *     rely on session state (temp tables, `SET LOCAL`, advisory locks) across
 *     statements. Transactions still work — PgBouncer keeps one server connection
 *     for the whole `BEGIN … COMMIT`.
 *   • Direct (port 5432 on `db.<ref>.supabase.co`) — for migrations only, and for
 *     DDL like scripts/partitions.ts.
 *
 * Everything here is parameterized SQL (never string-interpolated), so there is no
 * injection surface; `sql.unsafe` is not used anywhere in this file.
 *
 * All snake_case → camelCase mapping happens in the `map*` functions at the bottom —
 * the only place in the codebase that knows the column spellings.
 */
import postgres from 'postgres';
import {
	AlreadySettledError,
	BetExistsError,
	DbError,
	DuplicatePayoutError,
	InsufficientFundsError,
	NotFoundError,
	leaderboardLimit,
	type BetPageOptions,
	type BetRepo,
	type CloseRepo,
	type GameStore,
	type LedgerRepo,
	type PotRepo,
	type ProfileRepo,
	type SessionRepo,
	type StatsRepo,
	type TickRepo,
	type TopBalanceRow,
	type TopStreakRow,
	type TopWinRow,
	type TxStore
} from './interface';
import {
	placeBetInTx,
	settleBetsInTx,
	type PlaceBetInput,
	type SettleBetsInput,
	type SettleBetsResult
} from './money';
import type {
	Bet,
	CasTickRow,
	CloseSource,
	DailyPot,
	DailySession,
	IndexClose,
	LedgerEntry,
	NewLedgerEntry,
	PotDelta,
	Profile,
	SessionStatus,
	SettlementTier,
	StatsDelta,
	Underlying,
	UserStats
} from './types';

/**
 * The query handle. Both the pool (`Sql`) and an open transaction (`TransactionSql`)
 * satisfy it, which is what lets `tx()` hand the repos a transaction-scoped handle.
 */
type SqlClient = postgres.ISql;

/** A raw driver row. Everything is `unknown` until a mapper vouches for it. */
type Row = Record<string, unknown>;

/** Postgres error codes we translate into domain errors. */
const UNIQUE_VIOLATION = '23505';

/** Postgres unique-constraint names created by supabase/migrations/0001_init.sql. */
const CONSTRAINT = {
	profilesPkey: 'profiles_pkey',
	profilesHandleKey: 'profiles_handle_key',
	// Postgres derives this from the inline `unique (user_id, session_id, underlying)`.
	betsUnique: 'bets_user_id_session_id_underlying_key',
	ledgerPayoutOnce: 'ledger_payout_once'
} as const;

// ---------------------------------------------------------------------------
// Connection-string helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

export type PoolOptions = {
	prepare: boolean;
	max: number;
	idle_timeout: number;
	connect_timeout: number;
	/**
	 * Absent when `DATABASE_URL` already carries `sslmode` — postgres.js reads that
	 * itself, and an explicit `ssl` here would silently override it (its option merge
	 * prefers the passed object over the query string). Never set this to loosen TLS.
	 */
	ssl?: 'require' | boolean;
	onnotice: () => void;
};

/**
 * `prepare` must be OFF for Supabase's transaction-mode pooler (port 6543, PgBouncer) —
 * named prepared statements do not survive a reassignment of the server connection.
 * Everywhere else (session pooler, direct, local Postgres) prepared statements are
 * faster, so they stay on. Passing `DATABASE_URL` verbatim is respected; this only
 * adds the flag the URL cannot express.
 */
export function resolvePrepareFlag(databaseUrl: string): boolean {
	let port = '';
	try {
		port = new URL(databaseUrl).port;
	} catch {
		return true; // not a URL we understand — default to the faster, stricter mode
	}
	return port !== '6543';
}

/**
 * TLS policy: `require` for anything off-host, off for a local Postgres, and
 * `undefined` (decide nothing) when the URL states its own `sslmode`.
 */
export function resolveSsl(databaseUrl: string): 'require' | boolean | undefined {
	try {
		const url = new URL(databaseUrl);
		if (url.searchParams.has('sslmode')) return undefined;
		const host = url.hostname;
		return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? false : 'require';
	} catch {
		return undefined;
	}
}

/** `postgresql://user:SECRET@host/db` → `postgresql://user:***@host/db` — for logs. */
export function maskDatabaseUrl(databaseUrl: string): string {
	try {
		const url = new URL(databaseUrl);
		if (url.password) url.password = '***';
		return url.toString();
	} catch {
		return 'DATABASE_URL (unparseable)';
	}
}

export function buildPoolOptions(databaseUrl: string, max = 10): PoolOptions {
	const ssl = resolveSsl(databaseUrl);
	return {
		prepare: resolvePrepareFlag(databaseUrl),
		max,
		idle_timeout: 30,
		connect_timeout: 10,
		// Spread rather than always assigning: an absent key means "the URL decides".
		...(ssl === undefined ? {} : { ssl }),
		// NOTICE logs (e.g. from partition DDL) are noise in a request path.
		onnotice: () => {}
	};
}

// ---------------------------------------------------------------------------
// Row mappers — the ONLY place that knows snake_case column names
// ---------------------------------------------------------------------------

/** `numeric` arrives as text; `int`/`bigint` arrive as number (or text when unsafe). */
function toNum(value: unknown, fallback = 0): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		return Number.isNaN(n) ? fallback : n;
	}
	return fallback;
}

/** Nullable numeric column (`payout`, `settled_at` are NULL until settlement). */
function toNumOrNull(value: unknown): number | null {
	return value === null || value === undefined ? null : toNum(value);
}

/** `timestamptz` → epoch ms (postgres.js hands back a Date). */
function toMs(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * `date` → 'YYYY-MM-DD'. postgres.js parses DATE columns into a Date at LOCAL midnight,
 * so read the local fields — `toISOString()` would hand back the previous day on any
 * positive UTC offset, which would silently corrupt every trade_date.
 */
function toDateStr(value: unknown): string {
	if (typeof value === 'string') return value.slice(0, 10);
	if (value instanceof Date) {
		const pad = (n: number): string => String(n).padStart(2, '0');
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	return String(value ?? '').slice(0, 10);
}

function mapProfile(row: Row): Profile {
	return {
		userId: String(row.user_id),
		handle: String(row.handle),
		email: String(row.email),
		balance: toNum(row.balance),
		xp: toNum(row.xp),
		streakDays: toNum(row.streak_days),
		lastBetDate:
			row.last_bet_date === null || row.last_bet_date === undefined
				? null
				: toDateStr(row.last_bet_date),
		createdAt: toMs(row.created_at)
	};
}

function mapSession(row: Row): DailySession {
	return {
		id: toNum(row.id),
		tradeDate: toDateStr(row.trade_date),
		status: String(row.status) as SessionStatus,
		cutoffAt: toMs(row.cutoff_at),
		createdAt: toMs(row.created_at)
	};
}

function mapBet(row: Row): Bet {
	return {
		id: String(row.id),
		userId: String(row.user_id),
		sessionId: toNum(row.session_id),
		underlying: String(row.underlying) as Underlying,
		targetKind: String(row.target_kind) as 'up' | 'down',
		deltaPoints: toNum(row.delta_points),
		odds: toNum(row.odds),
		stake: toNum(row.stake),
		settlementTier: (row.settlement_tier as SettlementTier | null) ?? null,
		payout: toNumOrNull(row.payout),
		settledAt:
			row.settled_at === null || row.settled_at === undefined ? null : toMs(row.settled_at),
		createdAt: toMs(row.created_at)
	};
}

function mapPot(row: Row): DailyPot {
	return {
		tradeDate: toDateStr(row.trade_date),
		totalBets: toNum(row.total_bets),
		totalStaked: toNum(row.total_staked),
		totalPaidOut: toNum(row.total_paid_out),
		playersCount: toNum(row.players_count),
		updatedAt: toMs(row.updated_at)
	};
}

function mapStats(row: Row): UserStats {
	return {
		userId: String(row.user_id),
		betsPlaced: toNum(row.bets_placed),
		betsWon: toNum(row.bets_won),
		totalStaked: toNum(row.total_staked),
		totalWon: toNum(row.total_won),
		bestPayout: toNum(row.best_payout),
		updatedAt: toMs(row.updated_at)
	};
}

function mapLedger(row: Row): LedgerEntry {
	return {
		id: toNum(row.id),
		userId: String(row.user_id),
		kind: String(row.kind) as LedgerEntry['kind'],
		amount: toNum(row.amount),
		refBetId: (row.ref_bet_id as string | null) ?? null,
		balanceAfter: toNum(row.balance_after),
		createdAt: toMs(row.created_at)
	};
}

function mapTick(row: Row): CasTickRow {
	return {
		tradeDate: toDateStr(row.trade_date),
		underlying: String(row.underlying) as Underlying,
		ts: toMs(row.ts),
		value: toNum(row.value),
		changePts: toNum(row.change_pts),
		changePct: toNum(row.change_pct)
	};
}

function mapClose(row: Row): IndexClose {
	return {
		tradeDate: toDateStr(row.trade_date),
		underlying: String(row.underlying) as Underlying,
		close: toNum(row.close),
		source: String(row.source) as CloseSource
	};
}

/**
 * The scalar coercions plus one mapper per table, exported so the date/numeric
 * handling can be unit-tested without a database (see ./postgres.test.ts). This is the
 * only place in the codebase that knows what a raw Postgres row looks like.
 */
export const rowMappers = {
	date: toDateStr,
	ms: toMs,
	num: toNum,
	numOrNull: toNumOrNull,
	profile: mapProfile,
	session: mapSession,
	bet: mapBet,
	pot: mapPot,
	stats: mapStats,
	ledger: mapLedger,
	tick: mapTick,
	close: mapClose
} as const;

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/** Pull the stable bits out of a driver error without assuming its shape. */
function asPgError(err: unknown): { code: string; constraint: string | null } | null {
	if (!(err instanceof postgres.PostgresError)) return null;
	return { code: err.code, constraint: err.constraint_name ?? null };
}

/** True when the failure is the unique index that makes settlement idempotent. */
function isPayoutOnceViolation(err: unknown): boolean {
	const pg = asPgError(err);
	if (!pg || pg.code !== UNIQUE_VIOLATION) return false;
	// The index is not a constraint, so older Postgres reports it unnamed — match either.
	return pg.constraint === null || pg.constraint === CONSTRAINT.ledgerPayoutOnce;
}

/**
 * True when an INSERT into `bets` lost the one-bet-per-index race. Only that
 * table's unique key can fire on that statement (the id is a generated uuid), so
 * a bare 23505 with an unnamed constraint is accepted for older Postgres.
 */
function isBetUniqueViolation(err: unknown): boolean {
	const pg = asPgError(err);
	if (!pg || pg.code !== UNIQUE_VIOLATION) return false;
	return pg.constraint === null || pg.constraint === CONSTRAINT.betsUnique;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The INSERT path for a bet: the table's PK is `default gen_random_uuid()`, and a
 * default only applies when the column is omitted, so the id is either a parameter or
 * a fragment that calls the server-side generator.
 */
function betIdExpr(sql: SqlClient, id: string | undefined): postgres.Fragment {
	return id ? (sql`${id}` as postgres.Fragment) : (sql`gen_random_uuid()` as postgres.Fragment);
}

/** Repos built over one handle — the pool for reads, or a transaction inside `tx()`. */
function createRepos(sql: SqlClient): TxStore {
	const sessionRepo: SessionRepo = {
		ensureSession: async (tradeDate, cutoffAt) => {
			const inserted = await sql`
				insert into daily_sessions (trade_date, status, cutoff_at)
				values (${tradeDate}, 'open', ${new Date(cutoffAt)})
				on conflict (trade_date) do nothing
				returning *`;
			if (inserted.length > 0) return mapSession(inserted[0]);
			// Lost the race (or the day already existed): first write wins, never move a cutoff.
			const existing = await sql`select * from daily_sessions where trade_date = ${tradeDate}`;
			if (existing.length === 0) throw new NotFoundError(`session ${tradeDate}`);
			return mapSession(existing[0]);
		},
		getSessionByDate: async (tradeDate) => {
			const rows = await sql`select * from daily_sessions where trade_date = ${tradeDate}`;
			return rows.length > 0 ? mapSession(rows[0]) : null;
		},
		getSessionById: async (sessionId) => {
			const rows = await sql`select * from daily_sessions where id = ${sessionId}`;
			return rows.length > 0 ? mapSession(rows[0]) : null;
		},
		setSessionStatus: async (sessionId, status) => {
			const rows =
				await sql`update daily_sessions set status = ${status} where id = ${sessionId} returning id`;
			if (rows.length === 0) throw new NotFoundError(`session ${sessionId}`);
		},
		// One UPDATE with the expected state in the WHERE: the claim is a single row
		// write, so two overlapping settle runs cannot both win. A row that does not
		// exist also answers `false` — callers have already read the session.
		setSessionStatusIf: async (sessionId, status, expected) => {
			const rows = await sql`
				update daily_sessions set status = ${status}
				where id = ${sessionId} and status = any(${expected})
				returning id`;
			return rows.length > 0;
		}
	};

	const profileRepo: ProfileRepo = {
		getProfile: async (userId) => {
			const rows = await sql`select * from profiles where user_id = ${userId}`;
			return rows.length > 0 ? mapProfile(rows[0]) : null;
		},
		getProfileByHandle: async (handle) => {
			const rows = await sql`select * from profiles where handle = ${handle}`;
			return rows.length > 0 ? mapProfile(rows[0]) : null;
		},
		listProfilesByHandles: async (handles) => {
			if (handles.length === 0) return [];
			const unique = [...new Set(handles)];
			const rows = await sql`select * from profiles where handle = any(${unique})`;
			// Preserve the caller's order — leaderboards/profile pages expect it.
			const byHandle = new Map(rows.map((row) => [String(row.handle), mapProfile(row)]));
			return unique.flatMap((handle) => {
				const profile = byHandle.get(handle);
				return profile ? [profile] : [];
			});
		},
		insertProfile: async (input) => {
			const balance = input.balance ?? 0; // a wallet never starts negative or NULL
			try {
				const rows = await sql`
					insert into profiles (user_id, handle, email, balance)
					values (${input.userId}, ${input.handle}, ${input.email}, ${balance})
					returning *`;
				return mapProfile(rows[0]);
			} catch (err: unknown) {
				const pg = asPgError(err);
				if (pg?.code === UNIQUE_VIOLATION) {
					const handleTaken = pg.constraint === CONSTRAINT.profilesHandleKey;
					throw new DbError(
						handleTaken
							? `handle "${input.handle}" is taken`
							: `profile ${input.userId} already exists`,
						handleTaken ? 'DUPLICATE_HANDLE' : 'DUPLICATE_PROFILE'
					);
				}
				throw err;
			}
		},
		setHandle: async (userId, handle) => {
			try {
				const rows =
					await sql`update profiles set handle = ${handle} where user_id = ${userId} returning *`;
				if (rows.length === 0) throw new NotFoundError(`profile ${userId}`);
				return mapProfile(rows[0]);
			} catch (err: unknown) {
				if (asPgError(err)?.code === UNIQUE_VIOLATION) {
					throw new DbError(`handle "${handle}" is taken`, 'DUPLICATE_HANDLE');
				}
				throw err;
			}
		},
		// Serializes concurrent money ops on this wallet. No-op outside a tx (autocommit
		// releases the lock immediately) — always call it from inside store.tx().
		lockForUpdate: async (userId) => {
			const rows = await sql`select * from profiles where user_id = ${userId} for update`;
			return rows.length > 0 ? mapProfile(rows[0]) : null;
		},
		applyBalanceDelta: async (userId, delta) => {
			// The `balance + delta >= 0` predicate is the wallet invariant: it makes the
			// deduction conditional instead of relying on a separate read, so two concurrent
			// withdrawals cannot both pass a balance check taken before the lock.
			const rows = await sql`
				update profiles set balance = balance + ${delta}
				where user_id = ${userId} and balance + ${delta} >= 0
				returning *`;
			if (rows.length > 0) return mapProfile(rows[0]);
			const exists = await sql`select balance from profiles where user_id = ${userId}`;
			if (exists.length === 0) throw new NotFoundError(`profile ${userId}`);
			throw new InsufficientFundsError(userId, Math.max(0, -delta), toNum(exists[0].balance));
		},
		// Settlement's gamification write (T9): XP accrues, the streak is stamped with
		// the values the caller derived under the wallet lock. A date column takes the
		// same 'YYYY-MM-DD' text `ensureSession` already sends.
		applyProfileProgress: async (userId, next) => {
			const rows = await sql`
				update profiles
				set xp = xp + ${next.xpDelta},
				    streak_days = ${next.streakDays},
				    last_bet_date = ${next.lastBetDate}
				where user_id = ${userId}
				returning *`;
			if (rows.length === 0) throw new NotFoundError(`profile ${userId}`);
			return mapProfile(rows[0]);
		},
		// 🏆 Top balances (T14). The counters come from `user_stats` — the row that
		// bet placement and settlement already maintain — so there is no aggregate
		// anywhere in this query (PLAN §3). `left join`, not `join`: a funded player
		// who has never settled a bet belongs on the board with zeroed counters, and
		// `coalesce` spells that out. Ordering ends on `handle` so every node renders
		// the same board from the same rows.
		//
		// No index on `balance` yet: migrations are frozen and 100 rows cached for
		// 30s is a negligible read. If profiles ever reach lakhs, the Tier-2 move is
		// `create index profiles_balance_idx on profiles (balance desc)` — an index,
		// not an aggregate, so the doctrine holds.
		listTopBalances: async (limit) => {
			const rows = await sql`
				select p.handle, p.balance, p.xp, p.streak_days,
				       coalesce(s.bets_placed, 0) as bets_placed,
				       coalesce(s.bets_won, 0) as bets_won
				from profiles p
				left join user_stats s on s.user_id = p.user_id
				order by p.balance desc, p.xp desc, p.handle asc
				limit ${leaderboardLimit(limit)}`;
			return rows.map(
				(row): TopBalanceRow => ({
					handle: String(row.handle),
					balance: toNum(row.balance),
					xp: toNum(row.xp),
					streakDays: toNum(row.streak_days),
					betsPlaced: toNum(row.bets_placed),
					betsWon: toNum(row.bets_won)
				})
			);
		},
		// 🔥 Longest streaks (T14) — one indexed-in-spirit column, already written by
		// the settlement engine's gamification step.
		listTopStreaks: async (limit) => {
			const rows = await sql`
				select handle, streak_days, xp from profiles
				where streak_days > 0
				order by streak_days desc, xp desc, handle asc
				limit ${leaderboardLimit(limit)}`;
			return rows.map(
				(row): TopStreakRow => ({
					handle: String(row.handle),
					streakDays: toNum(row.streak_days),
					xp: toNum(row.xp)
				})
			);
		}
	};

	const betRepo: BetRepo = {
		getBetById: async (betId) => {
			const rows = await sql`select * from bets where id = ${betId}`;
			return rows.length > 0 ? mapBet(rows[0]) : null;
		},
		getBetsForUserOnDate: async (userId, tradeDate) => {
			const rows = await sql`
				select b.* from bets b
				join daily_sessions s on s.id = b.session_id
				where b.user_id = ${userId} and s.trade_date = ${tradeDate}
				order by b.created_at asc, b.id asc`;
			return rows.map(mapBet);
		},
		// The public profile strip (T10). `settled_at is not null` keeps open bets out;
		// the explicit LIMIT is the caller's bound, never a driver default.
		listRecentSettledBets: async (userId, limit) => {
			const rows = await sql`
				select * from bets
				where user_id = ${userId} and settled_at is not null
				order by settled_at desc, created_at desc, id desc
				limit ${Math.max(0, limit)}`;
			return rows.map(mapBet);
		},
		// ⚡ Today's biggest calls (T14). The trade date is reached through
		// `daily_sessions` (the bet's own row has no date column), `join profiles`
		// names the player, and `settled_at is not null` keeps open bets off a public
		// board. Ordering ends on `p.handle, b.id` so equal payouts always rank the
		// same way — see the interface note for why that is load-bearing.
		listTopWinsForDate: async (tradeDate, limit) => {
			const rows = await sql`
				select p.handle, b.underlying, b.target_kind, b.delta_points,
				       b.stake, b.payout, b.odds, b.settlement_tier
				from bets b
				join daily_sessions s on s.id = b.session_id
				join profiles p on p.user_id = b.user_id
				where s.trade_date = ${tradeDate} and b.settled_at is not null
				order by b.payout desc, p.handle asc, b.id asc
				limit ${leaderboardLimit(limit)}`;
			return rows.map(
				(row): TopWinRow => ({
					handle: String(row.handle),
					underlying: String(row.underlying) as TopWinRow['underlying'],
					targetKind: String(row.target_kind) as TopWinRow['targetKind'],
					deltaPoints: toNum(row.delta_points),
					stake: toNum(row.stake),
					payout: toNum(row.payout),
					odds: toNum(row.odds),
					// Unreachable as null: the `settled_at is not null` filter guarantees a tier.
					settlementTier: (row.settlement_tier as TopWinRow['settlementTier'] | null) ?? 'miss'
				})
			);
		},
		// The /history page (T14) — a keyset walk over `bets_user_created
		// (user_id, created_at desc)`. `beforeCreatedAt` alone is a plain `<` cursor;
		// with `beforeId` it becomes `created_at < c OR (created_at = c AND id < i)`,
		// which is what makes rows sharing the cursor instant lossless rather than
		// skipped. The id never crosses back out of this driver.
		listBetsForUserPage: async (userId, options: BetPageOptions) => {
			const cursor =
				options.beforeCreatedAt === undefined
					? (sql`` as postgres.Fragment)
					: options.beforeId === undefined
						? (sql` and created_at < ${new Date(options.beforeCreatedAt)}` as postgres.Fragment)
						: (sql` and (created_at < ${new Date(options.beforeCreatedAt)}
						          or (created_at = ${new Date(options.beforeCreatedAt)}
						              and id < ${options.beforeId}))` as postgres.Fragment);
			const rows = await sql`
				select * from bets
				where user_id = ${userId}${cursor}
				order by created_at desc, id desc
				limit ${Math.max(0, Math.trunc(options.limit))}`;
			return rows.map(mapBet);
		},
		listBetsForSession: async (sessionId) => {
			const rows = await sql`
				select * from bets where session_id = ${sessionId}
				order by created_at asc, id asc`;
			return rows.map(mapBet);
		},
		// "One active bet per index per day" (PLAN §0) — the unique key does the work.
		// Outcome columns are cleared: an edit is a new position, not a mutation of a result.
		upsertBet: async (input) => {
			const rows = await sql`
				insert into bets (id, user_id, session_id, underlying, target_kind, delta_points, odds, stake)
				values (${betIdExpr(sql, input.id)}, ${input.userId}, ${input.sessionId}, ${input.underlying},
				        ${input.targetKind}, ${input.deltaPoints}, ${input.odds}, ${input.stake})
				on conflict (user_id, session_id, underlying) do update set
					target_kind = excluded.target_kind,
					delta_points = excluded.delta_points,
					odds = excluded.odds,
					stake = excluded.stake,
					settlement_tier = null,
					payout = null,
					settled_at = null
				returning *`;
			return mapBet(rows[0]);
		},
		setBetOutcome: async (betId, tier, payout, settledAt) => {
			// `and settled_at is null` makes this write-once at the row level, matching
			// AlreadySettledError rather than silently overwriting a settled bet.
			const rows = await sql`
				update bets set settlement_tier = ${tier}, payout = ${payout}, settled_at = ${new Date(settledAt)}
				where id = ${betId} and settled_at is null
				returning id`;
			if (rows.length > 0) return;
			const exists = await sql`select settled_at from bets where id = ${betId}`;
			if (exists.length === 0) throw new NotFoundError(`bet ${betId}`);
			throw new AlreadySettledError(`bet ${betId}`);
		},
		// Cancel path. Migration 0001 gives `ledger.ref_bet_id` a plain FK to
		// `bets(id)` with no `on delete` action and migrations are frozen, so the
		// references are detached first: without that, the stake row written at
		// placement would make the delete impossible. Only the pointer is dropped —
		// the amounts and `balance_after` that make the ledger an audit trail stay.
		deleteBet: async (betId) => {
			await sql`update ledger set ref_bet_id = null where ref_bet_id = ${betId}`;
			await sql`delete from bets where id = ${betId}`;
		}
	};

	const potRepo: PotRepo = {
		getDailyPot: async (tradeDate) => {
			const rows = await sql`select * from daily_pots where trade_date = ${tradeDate}`;
			return rows.length > 0 ? mapPot(rows[0]) : null;
		},
		ensureDailyPot: async (tradeDate) => {
			const inserted = await sql`
				insert into daily_pots (trade_date) values (${tradeDate})
				on conflict (trade_date) do nothing returning *`;
			if (inserted.length > 0) return mapPot(inserted[0]);
			const pot = await potRepo.getDailyPot(tradeDate);
			if (!pot) throw new NotFoundError(`daily_pots row for ${tradeDate}`);
			return pot;
		},
		// Signed deltas in a single UPDATE — upsert-and-add, no read-modify-write race.
		applyPotDelta: async (tradeDate, delta: PotDelta) => {
			const rows = await sql`
				insert into daily_pots (trade_date, total_bets, total_staked, total_paid_out, players_count)
				values (${tradeDate}, ${delta.totalBets ?? 0}, ${delta.totalStaked ?? 0},
				        ${delta.totalPaidOut ?? 0}, ${delta.playersCount ?? 0})
				on conflict (trade_date) do update set
					total_bets = daily_pots.total_bets + excluded.total_bets,
					total_staked = daily_pots.total_staked + excluded.total_staked,
					total_paid_out = daily_pots.total_paid_out + excluded.total_paid_out,
					players_count = daily_pots.players_count + excluded.players_count,
					updated_at = now()
				returning *`;
			return mapPot(rows[0]);
		}
	};

	const statsRepo: StatsRepo = {
		getUserStats: async (userId) => {
			const rows = await sql`select * from user_stats where user_id = ${userId}`;
			if (rows.length > 0) return mapStats(rows[0]);
			// Absent row == zeroed aggregates; materialize it so callers never special-case.
			const inserted = await sql`
				insert into user_stats (user_id) values (${userId})
				on conflict (user_id) do nothing returning *`;
			if (inserted.length > 0) return mapStats(inserted[0]);
			const existing = await sql`select * from user_stats where user_id = ${userId}`;
			if (existing.length === 0) throw new NotFoundError(`user_stats ${userId}`);
			return mapStats(existing[0]);
		},
		applyStatsDelta: async (userId, delta: StatsDelta) => {
			const rows = await sql`
				insert into user_stats (user_id, bets_placed, bets_won, total_staked, total_won, best_payout)
				values (${userId}, ${delta.betsPlaced ?? 0}, ${delta.betsWon ?? 0},
				        ${delta.totalStaked ?? 0}, ${delta.totalWon ?? 0}, ${delta.bestPayout ?? 0})
				on conflict (user_id) do update set
					bets_placed = user_stats.bets_placed + excluded.bets_placed,
					bets_won = user_stats.bets_won + excluded.bets_won,
					total_staked = user_stats.total_staked + excluded.total_staked,
					total_won = user_stats.total_won + excluded.total_won,
					best_payout = greatest(user_stats.best_payout, excluded.best_payout),
					updated_at = now()
				returning *`;
			return mapStats(rows[0]);
		}
	};

	const ledgerRepo: LedgerRepo = {
		appendLedger: async (entry: NewLedgerEntry) => {
			try {
				const rows = await sql`
					insert into ledger (user_id, kind, amount, ref_bet_id, balance_after)
					values (${entry.userId}, ${entry.kind}, ${entry.amount}, ${entry.refBetId ?? null},
					        ${entry.balanceAfter})
					returning *`;
				return mapLedger(rows[0]);
			} catch (err: unknown) {
				// Partial unique index `ledger_payout_once` — settlement's idempotency guard.
				if (isPayoutOnceViolation(err)) {
					throw new DuplicatePayoutError(entry.refBetId ?? '(no ref)');
				}
				throw err;
			}
		},
		getLedgerForUser: async (userId, limit = 200) => {
			const rows = await sql`
				select * from ledger where user_id = ${userId}
				order by id desc limit ${limit}`;
			return rows.map(mapLedger);
		},
		hasPayoutForBet: async (betId) => {
			const rows = await sql`
				select 1 from ledger where ref_bet_id = ${betId} and kind = 'payout' limit 1`;
			return rows.length > 0;
		}
	};

	const tickRepo: TickRepo = {
		insertCasTicks: async (rows) => {
			if (rows.length === 0) return 0;
			let stored = 0;
			// Chunked so a large backfill can never hit the 65535 bind-parameter ceiling.
			const chunkSize = 500;
			for (let i = 0; i < rows.length; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize).map((r) => ({
					trade_date: r.tradeDate,
					underlying: r.underlying,
					ts: new Date(r.ts),
					value: r.value,
					change_pts: r.changePts,
					change_pct: r.changePct
				}));
				const result = await sql`
					insert into cas_ticks ${sql(
						chunk,
						'trade_date',
						'underlying',
						'ts',
						'value',
						'change_pts',
						'change_pct'
					)}
					on conflict (trade_date, underlying, ts) do nothing`;
				stored += result.count ?? 0;
			}
			return stored;
		},
		// Half-open window [fromTs, toTs): a client's `sinceTs` is never re-sent, and
		// `toTs` becomes the next request's `fromTs` with no gap and no duplicate.
		getCasTicksRange: async (tradeDate, underlying, fromTs, toTs, limit) => {
			const rows = await sql`
				select * from cas_ticks
				where trade_date = ${tradeDate} and underlying = ${underlying}
				  and ts >= ${new Date(fromTs)} and ts < ${new Date(toTs)}
				order by ts asc
				limit ${limit}`;
			return rows.map(mapTick);
		}
	};

	const closeRepo: CloseRepo = {
		upsertIndexClose: async (close) => {
			await sql`
				insert into index_closes (trade_date, underlying, close, source)
				values (${close.tradeDate}, ${close.underlying}, ${close.close}, ${close.source})
				on conflict (trade_date, underlying) do update set
					close = excluded.close,
					source = excluded.source`;
		},
		// The poller's anchor path: an existing row (live_approx OR official) wins, so
		// re-running a poll can never rewrite the day's anchor.
		upsertIndexCloseIfAbsent: async (close) => {
			const rows = await sql`
				insert into index_closes (trade_date, underlying, close, source)
				values (${close.tradeDate}, ${close.underlying}, ${close.close}, ${close.source})
				on conflict (trade_date, underlying) do nothing
				returning underlying`;
			return rows.length > 0;
		},
		getIndexCloses: async (tradeDate) => {
			const rows =
				await sql`select * from index_closes where trade_date = ${tradeDate} order by underlying asc`;
			return rows.map(mapClose);
		},
		getLatestCloseBefore: async (tradeDate, underlying) => {
			const rows = await sql`
				select * from index_closes
				where underlying = ${underlying} and trade_date < ${tradeDate}
				order by trade_date desc limit 1`;
			return rows.length > 0 ? mapClose(rows[0]) : null;
		}
	};

	return {
		sessions: sessionRepo,
		profiles: profileRepo,
		bets: betRepo,
		pots: potRepo,
		stats: statsRepo,
		ledger: ledgerRepo,
		ticks: tickRepo,
		closes: closeRepo
	};
}

export class PostgresStore implements GameStore {
	private readonly pool: postgres.Sql;
	private readonly repos: TxStore;

	/** `new PostgresStore(databaseUrl)` owns a pool; `new PostgresStore(pool)` shares one. */
	constructor(connection: string | postgres.Sql, maxConnections = 10) {
		if (typeof connection === 'string') {
			if (!connection.trim()) throw new DbError('DATABASE_URL is empty', 'BAD_DATABASE_URL');
			this.pool = postgres(connection, buildPoolOptions(connection, maxConnections));
		} else {
			this.pool = connection;
		}
		this.repos = createRepos(this.pool);
	}

	/** Connection target, for logs — never logs the password. */
	get target(): string {
		const host = this.pool.options.host.join(',');
		const port = this.pool.options.port.join(',');
		return `${this.pool.options.user}@${host}:${port}/${this.pool.options.database}`;
	}

	/**
	 * BEGIN → fn → COMMIT, ROLLBACK on throw (postgres.js does all three). `fn` receives
	 * repos bound to the transaction's connection, so `lockForUpdate` row-locks inside
	 * it. Nested calls become SAVEPOINTs, not second transactions.
	 */
	tx<T>(fn: (tx: TxStore) => Promise<T>): Promise<T> {
		// postgres.js types the result as `UnwrapPromiseArray<T>`, which it cannot prove
		// equals `T` for a generic T. At runtime it IS the awaited callback value.
		return this.pool.begin((txSql) => fn(createRepos(txSql))) as Promise<T>;
	}

	async close(): Promise<void> {
		await this.pool.end({ timeout: 5 });
	}

	async placeBet(input: PlaceBetInput): Promise<Bet> {
		try {
			// The money path is the shared body in ./money, one transaction.
			return await this.tx((t) => placeBetInTx(t, input));
		} catch (err: unknown) {
			// Belt to the pre-check inside the body: a writer that skipped the wallet
			// lock can still lose the race, and the unique key says what the pre-check
			// would have. The existing bet's id is fetched so the 409 can point at it.
			if (!isBetUniqueViolation(err)) throw err;
			const rows = await this.pool`
				select b.id from bets b
				join daily_sessions s on s.id = b.session_id
				where b.user_id = ${input.userId} and s.trade_date = ${input.tradeDate}
				  and b.underlying = ${input.underlying}`;
			throw new BetExistsError(rows.length > 0 ? String(rows[0].id) : '(existing bet)');
		}
	}

	settleBets(input: SettleBetsInput): Promise<SettleBetsResult> {
		// The settlement money path is the shared body in ./money, one transaction
		// per chunk. Payout-once comes from the `ledger_payout_once` index (translated
		// to DuplicatePayoutError in the ledger repo), settled-once from
		// `setBetOutcome`'s `settled_at is null` predicate.
		return this.tx((t) => settleBetsInTx(t, input));
	}

	// -- GameStore: the read/write groups, bound to the pool (autocommit) ----------------

	get sessions(): SessionRepo {
		return this.repos.sessions;
	}
	get profiles(): ProfileRepo {
		return this.repos.profiles;
	}
	get bets(): BetRepo {
		return this.repos.bets;
	}
	get pots(): PotRepo {
		return this.repos.pots;
	}
	get stats(): StatsRepo {
		return this.repos.stats;
	}
	get ledger(): LedgerRepo {
		return this.repos.ledger;
	}
	get ticks(): TickRepo {
		return this.repos.ticks;
	}
	get closes(): CloseRepo {
		return this.repos.closes;
	}
}
