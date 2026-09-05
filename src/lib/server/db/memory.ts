/**
 * MemoryStore — the complete in-memory GameStore.
 *
 * This is why the app runs end-to-end with NO Supabase project and NO env vars: tests,
 * `npm run dev`, and the dry-run scripts all get a real (if ephemeral) game store.
 *
 * Semantics, chosen to mirror Postgres closely enough that service code cannot tell
 * them apart:
 *  - Map-based, last-write wins, deterministic iteration (every list method sorts).
 *  - `tx()` holds a process-wide async mutex (./mutex), so tx bodies never interleave —
 *    the same read-committed-plus-row-lock behaviour `BEGIN … SELECT … FOR UPDATE`
 *    gives us in Postgres. `profiles.lockForUpdate` is therefore a plain read here.
 *  - `tx()` really rolls back: the state is snapshotted when the transaction starts and
 *    restored if the body throws, so a service method that fails mid-way leaves NO
 *    partial write — exactly what T7/T9 rely on Postgres for. The snapshot is
 *    `structuredClone` of everything, i.e. O(state) per transaction, which is one more
 *    reason this driver is for tests and laptops, never production.
 *  - Invariants are enforced, not assumed: `balance >= 0` on every balance-affecting
 *    op, and payout-once on the ledger.
 *  - Lost on restart, by design — production durability is the Postgres driver's job.
 */
import {
	AlreadySettledError,
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
import { Mutex } from './mutex';
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
	DailyPot,
	DailySession,
	IndexClose,
	LedgerEntry,
	LedgerKind,
	NewLedgerEntry,
	Profile,
	SettlementTier,
	Underlying,
	UserStats
} from './types';

/** Composite key for anything scoped by (date, underlying). */
const tickKey = (tradeDate: string, underlying: Underlying): string => `${tradeDate}|${underlying}`;

/** Stable, human-greppable ordering for bets (createdAt then id). */
const byCreatedThenId = (a: Bet, b: Bet): number =>
	a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * Newest settlement first, the exact inverse of the reader contract on
 * {@link BetRepo.listRecentSettledBets}: `settled_at` wins, and because one day
 * settles in a single instant, placement order breaks the tie.
 */
const bySettledDesc = (a: Bet, b: Bet): number =>
	(b.settledAt ?? 0) - (a.settledAt ?? 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);

/**
 * Newest first — the exact inverse of {@link byCreatedThenId}, and the order
 * {@link BetRepo.listBetsForUserPage} promises the /history page. The id breaks
 * same-instant ties the same way the Postgres keyset cursor does.
 */
const byCreatedDesc = (a: Bet, b: Bet): number =>
	b.createdAt - a.createdAt || b.id.localeCompare(a.id);

/** Richest first, then most XP, then handle — see the interface note on `listTopBalances`. */
const byBalanceDesc = (a: TopBalanceRow, b: TopBalanceRow): number =>
	b.balance - a.balance || b.xp - a.xp || a.handle.localeCompare(b.handle);

/** Longest streak first, then most XP, then handle. */
const byStreakDesc = (a: TopStreakRow, b: TopStreakRow): number =>
	b.streakDays - a.streakDays || b.xp - a.xp || a.handle.localeCompare(b.handle);

/**
 * Biggest payout first, then handle, then bet id — the documented tie-break order
 * of {@link BetRepo.listTopWinsForDate}. The bet id only breaks ties here (the
 * Postgres driver orders on the column directly); it never leaves the driver, so
 * the row the caller sees carries no ids.
 */
const byPayoutDesc = (a: [TopWinRow, string], b: [TopWinRow, string]): number =>
	b[0].payout - a[0].payout || a[0].handle.localeCompare(b[0].handle) || a[1].localeCompare(b[1]);

export type MemoryStoreOptions = {
	/** Injectable clock — tests pin it so `createdAt`/`updatedAt` are deterministic. */
	now?: () => number;
	/** Starting values for the synthetic id sequences (tests assert on them). */
	firstSessionId?: number;
};

/** Point-in-time copy of the whole store, taken at the start of every transaction. */
type Snapshot = {
	profiles: [string, Profile][];
	userIdByHandle: [string, string][];
	sessions: [string, DailySession][];
	bets: [string, Bet][];
	pots: [string, DailyPot][];
	stats: [string, UserStats][];
	ledger: LedgerEntry[];
	ticks: [string, CasTickRow[]][];
	closes: [string, IndexClose][];
	sessionSeq: number;
	betSeq: number;
	ledgerSeq: number;
};

export class MemoryStore implements GameStore {
	private readonly now: () => number;
	// Storage is named by *key*, not by domain, so these never shadow the GameStore
	// members above (`profiles` is a repo on the interface, a Map here).
	// Not `readonly`: tx() swaps in a restored snapshot on rollback. The repo objects
	// below are readonly — they are behaviour, not state.
	private profilesById = new Map<string, Profile>();
	private userIdByHandle = new Map<string, string>();
	private sessionsByDate = new Map<string, DailySession>();
	private betsById = new Map<string, Bet>();
	private potsByDate = new Map<string, DailyPot>();
	private statsByUser = new Map<string, UserStats>();
	private ledgerRows: LedgerEntry[] = [];
	private ticksByKey = new Map<string, CasTickRow[]>();
	private closesByKey = new Map<string, IndexClose>();

	private sessionSeq = 0;
	private betSeq = 0;
	private ledgerSeq = 0;
	private readonly mutex = new Mutex();

	constructor(options: MemoryStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		if (options.firstSessionId !== undefined) this.sessionSeq = options.firstSessionId - 1;
	}

	// -- sessions -------------------------------------------------------------

	private readonly sessionRepo: SessionRepo = {
		ensureSession: async (tradeDate, cutoffAt) => {
			const existing = this.sessionsByDate.get(tradeDate);
			if (existing) return existing; // idempotent: first write wins, never move the cutoff
			const session: DailySession = {
				id: (this.sessionSeq += 1),
				tradeDate,
				status: 'open',
				cutoffAt,
				createdAt: this.now()
			};
			this.sessionsByDate.set(tradeDate, session);
			return session;
		},
		getSessionByDate: async (tradeDate) => this.sessionsByDate.get(tradeDate) ?? null,
		getSessionById: async (sessionId) => {
			for (const session of this.sessionsByDate.values())
				if (session.id === sessionId) return session;
			return null;
		},
		setSessionStatus: async (sessionId, status) => {
			const session = await this.sessionRepo.getSessionById(sessionId);
			if (!session) throw new NotFoundError(`session ${sessionId}`);
			session.status = status;
		},
		// The tx mutex serializes tx bodies and this body awaits nothing before the
		// check-and-set, so the conditional update is atomic here the way a single
		// `UPDATE … WHERE status = any(...)` is in Postgres.
		setSessionStatusIf: async (sessionId, status, expected) => {
			const session = await this.sessionRepo.getSessionById(sessionId);
			if (!session) return false;
			if (!(expected as readonly string[]).includes(session.status)) return false;
			session.status = status;
			return true;
		}
	};

	// -- profiles -------------------------------------------------------------

	private readonly profileRepo: ProfileRepo = {
		getProfile: async (userId) => this.profilesById.get(userId) ?? null,
		getProfileByHandle: async (handle) => {
			const userId = this.userIdByHandle.get(handle);
			return userId ? (this.profilesById.get(userId) ?? null) : null;
		},
		listProfilesByHandles: async (handles) => {
			const out: Profile[] = [];
			const seen = new Set<string>();
			for (const handle of handles) {
				if (seen.has(handle)) continue;
				seen.add(handle);
				const profile = await this.profileRepo.getProfileByHandle(handle);
				if (profile) out.push(profile);
			}
			return out;
		},
		insertProfile: async (input) => {
			if (this.profilesById.has(input.userId)) {
				throw new DbError(`profile ${input.userId} already exists`, 'DUPLICATE_PROFILE');
			}
			if (this.userIdByHandle.has(input.handle)) {
				throw new DbError(`handle "${input.handle}" is taken`, 'DUPLICATE_HANDLE');
			}
			const profile: Profile = {
				userId: input.userId,
				handle: input.handle,
				email: input.email,
				balance: input.balance ?? 0,
				xp: 0,
				streakDays: 0,
				lastBetDate: null,
				createdAt: this.now()
			};
			if (profile.balance < 0) throw new InsufficientFundsError(input.userId, 0, profile.balance);
			this.profilesById.set(profile.userId, profile);
			this.userIdByHandle.set(profile.handle, profile.userId);
			return profile;
		},
		setHandle: async (userId, handle) => {
			const profile = this.profilesById.get(userId);
			if (!profile) throw new NotFoundError(`profile ${userId}`);
			const owner = this.userIdByHandle.get(handle);
			if (owner !== undefined && owner !== userId) {
				throw new DbError(`handle "${handle}" is taken`, 'DUPLICATE_HANDLE');
			}
			if (profile.handle !== handle) this.userIdByHandle.delete(profile.handle);
			profile.handle = handle;
			this.userIdByHandle.set(handle, userId);
			return profile;
		},
		// The tx mutex already serializes the whole body, so a plain read IS the
		// "locked" read. Postgres needs the explicit `FOR UPDATE`; we do not.
		lockForUpdate: async (userId) => this.profilesById.get(userId) ?? null,
		applyBalanceDelta: async (userId, delta) => {
			const profile = this.profilesById.get(userId);
			if (!profile) throw new NotFoundError(`profile ${userId}`);
			if (delta < 0 && profile.balance + delta < 0) {
				throw new InsufficientFundsError(userId, -delta, profile.balance);
			}
			profile.balance += delta;
			return profile;
		},
		// Settlement's gamification write (T9). `xpDelta` accumulates, the streak
		// fields are absolutes — see the interface note on ProfileProgress.
		applyProfileProgress: async (userId, next) => {
			const profile = this.profilesById.get(userId);
			if (!profile) throw new NotFoundError(`profile ${userId}`);
			profile.xp += next.xpDelta;
			profile.streakDays = next.streakDays;
			profile.lastBetDate = next.lastBetDate;
			return profile;
		},
		// 🏆 Top balances (T14). The wallet is a precomputed column, so this is a
		// sort over `profiles` plus a Map lookup per row — the memory twin of the
		// `left join user_stats`, right down to keeping a player whose stats row
		// does not exist yet (their counters read 0).
		listTopBalances: async (limit) => {
			const rows: TopBalanceRow[] = [];
			for (const profile of this.profilesById.values()) {
				const stats = this.statsByUser.get(profile.userId);
				rows.push({
					handle: profile.handle,
					balance: profile.balance,
					xp: profile.xp,
					streakDays: profile.streakDays,
					betsPlaced: stats?.betsPlaced ?? 0,
					betsWon: stats?.betsWon ?? 0
				});
			}
			return rows.sort(byBalanceDesc).slice(0, leaderboardLimit(limit));
		},
		// 🔥 Longest streaks (T14): a zero streak is "no streak", not a rank.
		listTopStreaks: async (limit) =>
			[...this.profilesById.values()]
				.filter((profile) => profile.streakDays > 0)
				.sort(byStreakDesc)
				.slice(0, leaderboardLimit(limit))
				.map((profile) => ({
					handle: profile.handle,
					streakDays: profile.streakDays,
					xp: profile.xp
				}))
	};

	// -- bets -----------------------------------------------------------------

	private readonly betRepo: BetRepo = {
		getBetById: async (betId) => this.betsById.get(betId) ?? null,
		getBetsForUserOnDate: async (userId, tradeDate) => {
			const session = this.sessionsByDate.get(tradeDate);
			if (!session) return [];
			return (await this.betRepo.listBetsForSession(session.id)).filter((b) => b.userId === userId);
		},
		// The public profile strip (T10): outcomes only, capped by the caller.
		listRecentSettledBets: async (userId, limit) =>
			[...this.betsById.values()]
				.filter((b) => b.userId === userId && b.settledAt !== null)
				.sort(bySettledDesc)
				.slice(0, Math.max(0, limit)),
		// ⚡ Today's biggest calls (T14). The trade date lives on the session, not
		// on the bet, so the filter goes through `sessionsByDate` — the same join
		// the Postgres driver writes in SQL. A bet with no profile row is dropped,
		// exactly as the `join profiles` drops it there.
		listTopWinsForDate: async (tradeDate, limit) => {
			const sessionIds = new Set<number>();
			for (const session of this.sessionsByDate.values()) {
				if (session.tradeDate === tradeDate) sessionIds.add(session.id);
			}
			const ranked: [TopWinRow, string][] = [];
			for (const bet of this.betsById.values()) {
				if (!sessionIds.has(bet.sessionId) || bet.settledAt === null) continue;
				const profile = this.profilesById.get(bet.userId);
				if (!profile) continue;
				ranked.push([
					{
						handle: profile.handle,
						underlying: bet.underlying,
						targetKind: bet.targetKind,
						deltaPoints: bet.deltaPoints,
						stake: bet.stake,
						payout: bet.payout ?? 0,
						odds: bet.odds,
						// Unreachable as null: only settled bets survive the filter above.
						settlementTier: bet.settlementTier ?? 'miss'
					},
					bet.id
				]);
			}
			return ranked
				.sort(byPayoutDesc)
				.slice(0, leaderboardLimit(limit))
				.map(([row]) => row);
		},
		// The /history page (T14): every status, newest first, keyset-paginated. The
		// `beforeId` half of the cursor is what keeps two same-millisecond bets from
		// straddling a page boundary and losing one on the next page.
		listBetsForUserPage: async (userId, options: BetPageOptions) =>
			[...this.betsById.values()]
				.filter((b) => {
					if (b.userId !== userId) return false;
					if (options.beforeCreatedAt === undefined) return true;
					if (b.createdAt !== options.beforeCreatedAt) {
						return b.createdAt < options.beforeCreatedAt;
					}
					return options.beforeId !== undefined && b.id < options.beforeId;
				})
				.sort(byCreatedDesc)
				.slice(0, Math.max(0, Math.trunc(options.limit))),
		listBetsForSession: async (sessionId) =>
			[...this.betsById.values()].filter((b) => b.sessionId === sessionId).sort(byCreatedThenId),
		upsertBet: async (input) => {
			const existing = [...this.betsById.values()].find(
				(b) =>
					b.userId === input.userId &&
					b.sessionId === input.sessionId &&
					b.underlying === input.underlying
			);
			// Same (user, session, underlying) → replace in place (edit). Keeps id + createdAt,
			// clears any prior outcome: an edit is a new position, not a mutation of a result.
			if (existing) {
				const updated: Bet = {
					...existing,
					targetKind: input.targetKind,
					deltaPoints: input.deltaPoints,
					odds: input.odds,
					stake: input.stake,
					settlementTier: null,
					payout: null,
					settledAt: null
				};
				this.betsById.set(updated.id, updated);
				return updated;
			}
			if (input.stake <= 0) {
				throw new DbError(`stake must be > 0 (got ${input.stake})`, 'INVALID_STAKE');
			}
			const bet: Bet = {
				id: input.id ?? `bet_${(this.betSeq += 1)}`,
				userId: input.userId,
				sessionId: input.sessionId,
				underlying: input.underlying,
				targetKind: input.targetKind,
				deltaPoints: input.deltaPoints,
				odds: input.odds,
				stake: input.stake,
				settlementTier: null,
				payout: null,
				settledAt: null,
				createdAt: this.now()
			};
			this.betsById.set(bet.id, bet);
			return bet;
		},
		setBetOutcome: async (betId, tier, payout, settledAt) => {
			const bet = this.betsById.get(betId);
			if (!bet) throw new NotFoundError(`bet ${betId}`);
			if (bet.settledAt !== null) throw new AlreadySettledError(`bet ${betId}`);
			bet.settlementTier = tier satisfies SettlementTier;
			bet.payout = payout;
			bet.settledAt = settledAt;
		},
		// Cancel path: the row goes away so the (user, session, underlying) slot frees
		// up. No FK to satisfy here, so the ledger keeps its ref_bet_id — see the
		// interface note on deleteBet for how Postgres differs.
		deleteBet: async (betId) => {
			this.betsById.delete(betId);
		}
	};

	// -- pots / stats ---------------------------------------------------------

	private readonly potRepo: PotRepo = {
		getDailyPot: async (tradeDate) => this.potsByDate.get(tradeDate) ?? null,
		ensureDailyPot: async (tradeDate) => {
			const existing = this.potsByDate.get(tradeDate);
			if (existing) return existing;
			const pot: DailyPot = {
				tradeDate,
				totalBets: 0,
				totalStaked: 0,
				totalPaidOut: 0,
				playersCount: 0,
				updatedAt: this.now()
			};
			this.potsByDate.set(tradeDate, pot);
			return pot;
		},
		applyPotDelta: async (tradeDate, delta) => {
			const pot = { ...(await this.potRepo.ensureDailyPot(tradeDate)) };
			pot.totalBets += delta.totalBets ?? 0;
			pot.totalStaked += delta.totalStaked ?? 0;
			pot.totalPaidOut += delta.totalPaidOut ?? 0;
			pot.playersCount += delta.playersCount ?? 0;
			pot.updatedAt = this.now();
			this.potsByDate.set(tradeDate, pot);
			return pot;
		}
	};

	private readonly statsRepo: StatsRepo = {
		getUserStats: async (userId) => {
			const existing = this.statsByUser.get(userId);
			if (existing) return existing;
			const stats: UserStats = {
				userId,
				betsPlaced: 0,
				betsWon: 0,
				totalStaked: 0,
				totalWon: 0,
				bestPayout: 0,
				updatedAt: this.now()
			};
			this.statsByUser.set(userId, stats);
			return stats;
		},
		applyStatsDelta: async (userId, delta) => {
			const stats = { ...(await this.statsRepo.getUserStats(userId)) };
			stats.betsPlaced += delta.betsPlaced ?? 0;
			stats.betsWon += delta.betsWon ?? 0;
			stats.totalStaked += delta.totalStaked ?? 0;
			stats.totalWon += delta.totalWon ?? 0;
			stats.bestPayout = Math.max(stats.bestPayout, delta.bestPayout ?? 0);
			stats.updatedAt = this.now();
			this.statsByUser.set(userId, stats);
			return stats;
		}
	};

	// -- ledger ---------------------------------------------------------------

	private readonly ledgerRepo: LedgerRepo = {
		appendLedger: async (entry: NewLedgerEntry) => {
			if (
				entry.kind === ('payout' satisfies LedgerKind) &&
				entry.refBetId &&
				this.ledgerRows.some((e) => e.kind === 'payout' && e.refBetId === entry.refBetId)
			) {
				throw new DuplicatePayoutError(entry.refBetId);
			}
			const row: LedgerEntry = {
				id: (this.ledgerSeq += 1),
				userId: entry.userId,
				kind: entry.kind,
				amount: entry.amount,
				refBetId: entry.refBetId ?? null,
				balanceAfter: entry.balanceAfter,
				createdAt: this.now()
			};
			this.ledgerRows.push(row);
			return row;
		},
		getLedgerForUser: async (userId, limit) => {
			const rows = this.ledgerRows.filter((e) => e.userId === userId).sort((a, b) => b.id - a.id);
			return limit === undefined ? rows : rows.slice(0, limit);
		},
		hasPayoutForBet: async (betId) =>
			this.ledgerRows.some((e) => e.kind === 'payout' && e.refBetId === betId)
	};

	// -- ticks / closes -------------------------------------------------------

	private readonly tickRepo: TickRepo = {
		insertCasTicks: async (rows) => {
			let stored = 0;
			const grouped = new Map<string, CasTickRow[]>();
			for (const row of rows) {
				const key = tickKey(row.tradeDate, row.underlying);
				const bucket = grouped.get(key) ?? [];
				bucket.push(row);
				grouped.set(key, bucket);
			}
			for (const [key, batch] of grouped) {
				const existing = this.ticksByKey.get(key) ?? [];
				// Natural key is (trade_date, underlying, ts): a re-inserted poll is a no-op,
				// first tick wins — same resolution the CAS ring buffer uses for stale ts.
				const seen = new Set(existing.map((t) => t.ts));
				const fresh = batch
					.filter((t) => !seen.has(t.ts))
					.sort((a, b) => a.ts - b.ts || a.value - b.value);
				for (const tick of fresh) seen.add(tick.ts);
				if (fresh.length === 0) continue;
				this.ticksByKey.set(
					key,
					[...existing, ...fresh].sort((a, b) => a.ts - b.ts)
				);
				stored += fresh.length;
			}
			return stored;
		},
		getCasTicksRange: async (tradeDate, underlying, fromTs, toTs, limit) =>
			(this.ticksByKey.get(tickKey(tradeDate, underlying)) ?? [])
				.filter((t) => t.ts >= fromTs && t.ts < toTs) // [fromTs, toTs)
				.slice(0, Math.max(0, limit)),
		latestCasTradeDate: async (cutoff) => {
			let newest: string | null = null;
			for (const key of this.ticksByKey.keys()) {
				const date = key.split('|')[0] ?? '';
				if (cutoff !== undefined && date > cutoff) continue;
				if (newest === null || date > newest) newest = date;
			}
			return newest;
		}
	};

	private readonly closeRepo: CloseRepo = {
		upsertIndexClose: async (close) => {
			this.closesByKey.set(tickKey(close.tradeDate, close.underlying), { ...close });
		},
		// First write wins — the memory twin of `on conflict do nothing`.
		upsertIndexCloseIfAbsent: async (close) => {
			const key = tickKey(close.tradeDate, close.underlying);
			if (this.closesByKey.has(key)) return false;
			this.closesByKey.set(key, { ...close });
			return true;
		},
		// The LTP anchor replaces a live_approx fallback row but never an official one.
		upsertIndexLtpAnchor: async (close) => {
			const key = tickKey(close.tradeDate, close.underlying);
			const existing = this.closesByKey.get(key);
			if (existing?.source === 'official') return false;
			if (existing?.source === 'ltp_anchor') return false;
			this.closesByKey.set(key, { ...close, source: 'ltp_anchor' });
			return true;
		},
		getIndexCloses: async (tradeDate) =>
			[...this.closesByKey.values()]
				.filter((c) => c.tradeDate === tradeDate)
				.sort((a, b) => a.underlying.localeCompare(b.underlying)),
		getLatestCloseBefore: async (tradeDate, underlying) =>
			[...this.closesByKey.values()]
				.filter((c) => c.underlying === underlying && c.tradeDate < tradeDate)
				.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0] ?? null
	};

	// -- GameStore ------------------------------------------------------------

	// -- GameStore: the read/write groups (already transaction-safe under the mutex) ----

	get sessions(): SessionRepo {
		return this.sessionRepo;
	}
	get profiles(): ProfileRepo {
		return this.profileRepo;
	}
	get bets(): BetRepo {
		return this.betRepo;
	}
	get pots(): PotRepo {
		return this.potRepo;
	}
	get stats(): StatsRepo {
		return this.statsRepo;
	}
	get ledger(): LedgerRepo {
		return this.ledgerRepo;
	}
	get ticks(): TickRepo {
		return this.tickRepo;
	}
	get closes(): CloseRepo {
		return this.closeRepo;
	}

	/**
	 * The whole body runs under one mutex, so it sees a consistent snapshot and no other
	 * tx can interleave — the memory equivalent of `BEGIN … COMMIT`. Throw inside and the
	 * snapshot taken on entry is restored: no partial write escapes, so service methods
	 * written against this driver behave the same as against Postgres.
	 */
	async tx<T>(fn: (tx: TxStore) => Promise<T>): Promise<T> {
		const snapshot = this.snapshot();
		try {
			return await this.mutex.run(() => fn(this.asTxStore()));
		} catch (err: unknown) {
			this.restore(snapshot);
			throw err;
		}
	}

	/**
	 * Deep copy of every table — cheap at dev scale, and it is what makes rollback real.
	 * The clone happens HERE, on the way in: the repos mutate the live row objects in
	 * place, so a snapshot of references would be corrupted by the very write it is
	 * supposed to undo.
	 */
	private snapshot(): Snapshot {
		return {
			profiles: structuredClone([...this.profilesById]),
			userIdByHandle: [...this.userIdByHandle],
			sessions: structuredClone([...this.sessionsByDate]),
			bets: structuredClone([...this.betsById]),
			pots: structuredClone([...this.potsByDate]),
			stats: structuredClone([...this.statsByUser]),
			ledger: structuredClone(this.ledgerRows),
			ticks: structuredClone([...this.ticksByKey]),
			closes: structuredClone([...this.closesByKey]),
			sessionSeq: this.sessionSeq,
			betSeq: this.betSeq,
			ledgerSeq: this.ledgerSeq
		};
	}

	/** Swap the snapshot back in. The copies are private to this snapshot, so no clone needed. */
	private restore(s: Snapshot): void {
		this.profilesById = new Map(s.profiles);
		this.userIdByHandle = new Map(s.userIdByHandle);
		this.sessionsByDate = new Map(s.sessions);
		this.betsById = new Map(s.bets);
		this.potsByDate = new Map(s.pots);
		this.statsByUser = new Map(s.stats);
		this.ledgerRows = s.ledger;
		this.ticksByKey = new Map(s.ticks);
		this.closesByKey = new Map(s.closes);
		this.sessionSeq = s.sessionSeq;
		this.betSeq = s.betSeq;
		this.ledgerSeq = s.ledgerSeq;
	}

	close(): Promise<void> {
		return Promise.resolve();
	}

	// The money paths are the shared bodies in ./money running as ONE transaction —
	// the memory driver differs from Postgres only in how `tx()` is implemented.
	placeBet(input: PlaceBetInput): Promise<Bet> {
		return this.tx((t) => placeBetInTx(t, input));
	}

	settleBets(input: SettleBetsInput): Promise<SettleBetsResult> {
		return this.tx((t) => settleBetsInTx(t, input));
	}

	/** The same repos; exposed as a distinct type so callers cannot confuse it with the root. */
	private asTxStore(): TxStore {
		return {
			sessions: this.sessionRepo,
			profiles: this.profileRepo,
			bets: this.betRepo,
			pots: this.potRepo,
			stats: this.statsRepo,
			ledger: this.ledgerRepo,
			ticks: this.tickRepo,
			closes: this.closeRepo
		};
	}
}
