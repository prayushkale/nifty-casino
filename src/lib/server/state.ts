/**
 * `/api/state` — THE one-request screen rebuild (PLAN §2 "refresh/reconnect
 * contract", §5 T10). A client that lands on the game page cold, refreshes,
 * comes back from another tab or returns the next morning calls this once and
 * has everything it needs: who it is, what the day is doing, what it bet, what
 * the room has staked and what is bettable next.
 *
 * Deliberately a READ-ONLY projection. Nothing here calls `ensure*`, so a
 * refresh before anyone has played creates no rows and mutates nothing — a GET
 * must be free to repeat. Absent data is synthesized in the payload instead:
 * an empty pot is a zeroed row shape, a missing session is `exists: false`.
 *
 * One `now` is captured at the top and used for EVERY time flag and for
 * `serverNow`. Three flags derived from three different `Date.now()` reads would
 * let a payload disagree with itself across the 15:15/15:20:00 seams;
 * one instant cannot. `serverNow` travels with the payload so the client can
 * drift-correct its countdown against the server's clock (PLAN §6 R3) instead
 * of trusting its own.
 *
 * PRIVACY: the payload is per-user but it is still a JSON body in a browser, so
 * it carries nothing a stranger could use. No `email`, ever; no `user_id`/`id`
 * either — the handle is the public key and the uuid buys nothing here. See the
 * note on {@link toStateBet} for what a bet row keeps.
 */
import { AUCTION_END_HMS, AUCTION_START_HMS, BETTING_START_HMS, CUTOFF_HMS } from '$lib/config/app';
import { isBetweenHMS, istDateStr, shiftIstDate } from '$lib/time/ist';
import type { LadderOption, LadderUnderlying } from '$lib/config/ladder';
import { getLadderForDateWithLiveFallback } from '$lib/server/ladder';
import type { LiveCloseDeps } from '$lib/server/live-closes';
import { getStore, type GameStore } from '$lib/server/db';
import { buildCrowdDistribution, type CrowdDistribution } from '$lib/game/crowd';
import type {
	Bet,
	DailyPot,
	DailySession,
	SessionStatus,
	SettlementTier,
	Underlying,
	UserStats
} from '$lib/server/db/types';

// ---------------------------------------------------------------------------
// Payload shapes — the contract T11 builds the whole game page on
// ---------------------------------------------------------------------------

/**
 * The public shape of one day's `daily_pots` row. Same numbers, one less thing
 * for the client to learn about the schema; `updatedAt` is 0 on a synthesized
 * zero row because there is no row to have been updated.
 */
export type PotView = {
	tradeDate: string;
	totalBets: number;
	totalStaked: number;
	totalPaidOut: number;
	playersCount: number;
	/** epoch ms — 0 when this view was synthesized for a day with no row yet. */
	updatedAt: number;
};

/** Today plus the day before it, for the pot ticker's comparison. */
export type PotSnapshot = {
	/** Always present — zeroed when today has no counters yet. */
	today: PotView;
	/** `null` when there is no row for yesterday: "no game yesterday", not "0 NC". */
	yesterday: PotView | null;
};

/** What the session/state machine looked like at the instant of the request. */
export type StateSession = {
	/** False when nobody has touched this trade date yet — no row was created by asking. */
	exists: boolean;
	/** `null` when {@link exists} is false. */
	status: SessionStatus | null;
	/** 15:20:00 IST of the trade date, epoch ms. `null` when {@link exists} is false. */
	cutoffAtMs: number | null;
	/** 15:15:00–15:20:00 IST inclusive — bets are being accepted. */
	bettingWindowOpen: boolean;
	/** 15:13:30–15:42:00 IST inclusive — the auction is on and charts go live. */
	auctionLive: boolean;
	/** The day has been settled and its results are final. */
	settled: boolean;
};

/**
 * A bet as the client may see it. Only the fields the game page renders:
 * `userId`/`sessionId`/`settledAt` are dropped (`settledAt` is implied by
 * `settlementTier !== null`, and the ids are server bookkeeping).
 */
export type StateBet = {
	id: string;
	underlying: Underlying;
	targetKind: 'up' | 'down';
	deltaPoints: number;
	odds: number;
	stake: number;
	settlementTier: SettlementTier | null;
	payout: number | null;
	/** epoch ms. */
	createdAt: number;
};

/** The signed-in player's own numbers — never another player's. */
export type StateUser = {
	handle: string;
	balance: number;
	xp: number;
	streakDays: number;
	/** IST 'YYYY-MM-DD' of the user's last bet; null until their first settles. */
	lastBetDate: string | null;
	/** Which session mechanism answered — the same field `/api/auth/me` exposes. */
	authSource: 'supabase' | 'dev';
	stats: Pick<UserStats, 'betsPlaced' | 'betsWon' | 'totalStaked' | 'totalWon' | 'bestPayout'>;
};

/** The day's bettable rungs — the UI computes payout previews from these locally. */
export type StateLadder = {
	tradeDate: string;
	anchors: Record<LadderUnderlying, number | null>;
	options: LadderOption[];
};

export type StatePayload = {
	/** epoch ms — the single instant every flag in this payload was judged at. */
	serverNow: number;
	/** IST trade date ('YYYY-MM-DD'). */
	tradeDate: string;
	session: StateSession;
	/** `null` when the request carried no resolvable identity. */
	user: StateUser | null;
	/** Today's bets, newest first. Empty when anonymous or when nothing was placed. */
	myBets: StateBet[];
	pot: PotSnapshot;
	ladder: StateLadder;
	/**
	 * The crowd consensus: per index, one row per picked strike with its share
	 * of that index's bets (`$lib/game/crowd`). Aggregate counts only — no
	 * handles, no ids. Empty per index when nobody has bet it yet.
	 */
	crowd: CrowdDistribution;
};

// ---------------------------------------------------------------------------
// The pot projection (shared with GET /api/pot)
// ---------------------------------------------------------------------------

/** The zero shape, so a fresh day reads as 0s rather than as a missing field. */
export function zeroPotView(tradeDate: string): PotView {
	return {
		tradeDate,
		totalBets: 0,
		totalStaked: 0,
		totalPaidOut: 0,
		playersCount: 0,
		updatedAt: 0
	};
}

function toPotView(row: DailyPot): PotView {
	return {
		tradeDate: row.tradeDate,
		totalBets: row.totalBets,
		totalStaked: row.totalStaked,
		totalPaidOut: row.totalPaidOut,
		playersCount: row.playersCount,
		updatedAt: row.updatedAt
	};
}

/**
 * Today and yesterday's pot counters in one round trip, WITHOUT creating either
 * row: `getDailyPot` is a plain read, unlike `ensureDailyPot`, which is for
 * write paths. A day nobody has bet on is a zero view, not a row.
 */
export async function buildPotSnapshot(store: GameStore, tradeDate: string): Promise<PotSnapshot> {
	const [today, yesterday] = await Promise.all([
		store.pots.getDailyPot(tradeDate),
		store.pots.getDailyPot(shiftIstDate(tradeDate, -1))
	]);
	return {
		today: today ? toPotView(today) : zeroPotView(tradeDate),
		yesterday: yesterday ? toPotView(yesterday) : null
	};
}

// ---------------------------------------------------------------------------
// The crowd consensus (strike distribution)
// ---------------------------------------------------------------------------

/** The last (tradeDate, totalBets) the crowd payload was computed at. */
let crowdCache: {
	tradeDate: string;
	totalBets: number;
	distribution: CrowdDistribution;
} | null = null;

/** Test seam — clears the module cache between cases. */
export function resetCrowdCache(): void {
	crowdCache = null;
}

/** A cache miss means the day's bets moved (or a new day started). */
function crowdCacheHit(tradeDate: string, totalBets: number): CrowdDistribution | null {
	return crowdCache !== null &&
		crowdCache.tradeDate === tradeDate &&
		crowdCache.totalBets === totalBets
		? crowdCache.distribution
		: null;
}

/**
 * How the day's bets spread across the strikes, per index. The walk is bounded
 * by the `daily_pots.totalBets` delta counter as the cache key (PLAN §3 keeps
 * counters off SUM paths — here the counter gates the one aggregate the product
 * needs): an unchanged pot is a cache hit and re-reads nothing.
 */
export async function buildCrowdPayload(
	store: GameStore,
	tradeDate: string,
	totalBets: number
): Promise<CrowdDistribution> {
	if (totalBets === 0) return {};
	const hit = crowdCacheHit(tradeDate, totalBets);
	if (hit) return hit;
	const session = await store.sessions.getSessionByDate(tradeDate);
	if (!session) return {};
	const bets = await store.bets.listBetsForSession(session.id);
	const distribution = buildCrowdDistribution(bets);
	crowdCache = { tradeDate, totalBets, distribution };
	return distribution;
}

// ---------------------------------------------------------------------------
// The consolidated payload
// ---------------------------------------------------------------------------

/** Derive the time flags from ONE instant — see the module doc. */
export function sessionFlags(now: Date, session: DailySession | null): StateSession {
	return {
		exists: session !== null,
		status: session?.status ?? null,
		cutoffAtMs: session?.cutoffAt ?? null,
		bettingWindowOpen: isBetweenHMS(now, BETTING_START_HMS, CUTOFF_HMS),
		auctionLive: isBetweenHMS(now, AUCTION_START_HMS, AUCTION_END_HMS),
		settled: session?.status === 'settled'
	};
}

/** The public projection of one bet row — see {@link StateBet} for what is dropped. */
export function toStateBet(bet: Bet): StateBet {
	return {
		id: bet.id,
		underlying: bet.underlying,
		targetKind: bet.targetKind,
		deltaPoints: bet.deltaPoints,
		odds: bet.odds,
		stake: bet.stake,
		settlementTier: bet.settlementTier,
		payout: bet.payout,
		createdAt: bet.createdAt
	};
}

/** Dependencies overridable per call — tests inject a store and a clock. */
export type StateOptions = {
	/** Defaults to the process store (`getStore()`). */
	store?: GameStore;
	/** The instant the payload is judged at. Defaults to now; tests pin it. */
	now?: Date;
	/**
	 * Live previous-close fallback for the ladder (see
	 * `getLadderForDateWithLiveFallback`). Defaults to the real feeds: when the
	 * DB has no anchor yet, the ladder is built from the last closing price
	 * NSE/BSE carry right now so a logged-in player sees bettable ladders.
	 * Pass `false` to keep the DB-only ladder (hermetic tests), or inject
	 * fetchers to simulate the feeds.
	 */
	live?: LiveCloseDeps | false;
	/**
	 * The identity resolved by `hooks.server.ts`. `null`/`undefined` ⇒ the
	 * anonymous payload (`user: null`, `myBets: []`). Never a handle: the handle
	 * is looked up from the profile so the payload cannot disagree with the row.
	 */
	userId?: string | null;
	/** Which session mechanism answered; echoed back so the UI can label dev mode. */
	authSource?: 'supabase' | 'dev' | null;
};

/**
 * Build the whole screen-rebuild payload. One store, one clock, four to six row
 * reads and no writes.
 */
export async function buildStatePayload(options: StateOptions = {}): Promise<StatePayload> {
	const store = options.store ?? getStore();
	const now = options.now ?? new Date();
	const serverNow = now.getTime();
	const tradeDate = istDateStr(now);

	// Independent reads, so they run together. The DB ladder is process-cached
	// per trade date, so this is a DB walk once a day and a cache hit after that;
	// the live fallback only fires while some anchor is still null (fresh deploy
	// or pre-15:13:30), is best-effort, and never writes — the GET stays free to
	// repeat.
	const [session, pot, ladder] = await Promise.all([
		store.sessions.getSessionByDate(tradeDate),
		buildPotSnapshot(store, tradeDate),
		getLadderForDateWithLiveFallback(store, tradeDate, options.live ?? {})
	]);
	// Depends on the pot just read (its totalBets is the cache key), so it runs
	// after — usually a cache hit, at most one session read + one bets walk.
	const crowd = await buildCrowdPayload(store, tradeDate, pot.today.totalBets);

	const head = {
		serverNow,
		tradeDate,
		session: sessionFlags(now, session),
		pot,
		ladder: { tradeDate: ladder.tradeDate, anchors: ladder.anchors, options: ladder.options },
		crowd
	};

	const userId = options.userId ?? null;
	if (userId === null) {
		return { ...head, user: null, myBets: [] };
	}

	// A cookie can outlive the profile it named; that reads as signed out rather
	// than as a 500 — the same answer `/api/auth/me` gives.
	const profile = await store.profiles.getProfile(userId);
	if (!profile) return { ...head, user: null, myBets: [] };

	const [stats, bets] = await Promise.all([
		store.stats.getUserStats(profile.userId),
		store.bets.getBetsForUserOnDate(profile.userId, tradeDate)
	]);

	return {
		...head,
		user: {
			handle: profile.handle,
			balance: profile.balance,
			xp: profile.xp,
			streakDays: profile.streakDays,
			lastBetDate: profile.lastBetDate,
			// `authSource` is always set by the hooks for a resolvable user, so the
			// fallback is for direct/internal callers only.
			authSource: options.authSource ?? 'dev',
			stats: {
				betsPlaced: stats.betsPlaced,
				betsWon: stats.betsWon,
				totalStaked: stats.totalStaked,
				totalWon: stats.totalWon,
				bestPayout: stats.bestPayout
			}
		},
		// `getBetsForUserOnDate` is oldest-first (the edit/cancel order); the strip
		// reads newest-first.
		myBets: [...bets].reverse().map(toStateBet)
	};
}
