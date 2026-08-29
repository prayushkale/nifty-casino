/**
 * The public profile projection (PLAN §0 "totals visibility", §5 T10) — the one
 * shape both `/api/u/<handle>` and the `/u/<handle>` page return.
 *
 * This is a projection, not a row dump. `profiles` and `user_stats` carry things
 * a stranger must never see, and the only way this module can leak one is by
 * copying a field it should not — so every key below is written out by hand and
 * nothing is spread in. Absent by construction:
 *
 *   email        — the login secret's other half; a handle is public, this is not
 *   user_id      — the uuid behind every other table; the handle is the public key
 *   authSource   — how a player authenticates, which is nobody else's business
 *   ledger       — a complete history of a wallet, i.e. of a person's activity
 *   session rows — server bookkeeping
 *
 * Both routes that serve it are public (no `locals` anywhere), so the projection
 * is also the whole security boundary: nothing else in the chain filters.
 */
import { istDateStr } from '$lib/time/ist';
import { rankViewFor, type RankView } from '$lib/config/ranks';
import { getStore, type GameStore } from '$lib/server/db';
import type { Bet, Profile, SettlementTier, Underlying, UserStats } from '$lib/server/db/types';

/** How many settled bets the public profile shows. Capped server-side, always. */
export const PROFILE_RECENT_BETS = 20;

/** One settled bet on the public strip. Outcome fields only — no ids, no ledger. */
export type PublicBet = {
	underlying: Underlying;
	targetKind: 'up' | 'down';
	deltaPoints: number;
	stake: number;
	tier: SettlementTier;
	payout: number;
	/** IST date the bet settled on ('YYYY-MM-DD') — the strip is grouped by day. */
	settledOn: string;
};

export type PublicProfile = {
	handle: string;
	/** Whole NC chips — the live wallet, not a lifetime figure. */
	balance: number;
	xp: number;
	streakDays: number;
	/**
	 * `betsWon / betsPlaced` as 0..1, or `null` when the player has never settled
	 * a bet. `null` rather than 0 so "never played" cannot render as "loses every
	 * time" — the UI shows a dash for it.
	 */
	winRate: number | null;
	/** All-time aggregates from `user_stats` (one row lookup, never a scan). */
	totals: Pick<UserStats, 'betsPlaced' | 'betsWon' | 'totalStaked' | 'totalWon' | 'bestPayout'>;
	/** Last {@link PROFILE_RECENT_BETS} settled bets, newest settlement first. */
	recentBets: PublicBet[];
	/** IST date the account was created ('YYYY-MM-DD'). */
	joined: string;
	/**
	 * The rank title, DERIVED from `xp` at render time — never stored, never a
	 * column. A rank is a pure function of the XP the wallet already carries
	 * (`$lib/config/ranks`), so re-tuning the ladder re-titles every player
	 * retroactively with no migration, and there is no second number that can
	 * drift away from `xp`. Carries only `{level, title, tagline}`: the
	 * thresholds stay in config, where they are tuned and tested.
	 */
	rank: RankView;
};

/** Dependencies overridable per call — tests inject a store. */
export type ProfileOptions = {
	/** Defaults to the process store (`getStore()`). */
	store?: GameStore;
	/** Overrides {@link PROFILE_RECENT_BETS} (tests use a small one). */
	recentLimit?: number;
};

/** The public projection of one settled bet row. */
export function toPublicBet(bet: Bet): PublicBet {
	return {
		underlying: bet.underlying,
		targetKind: bet.targetKind,
		deltaPoints: bet.deltaPoints,
		stake: bet.stake,
		// A settled row always carries both — a miss writes tier 'miss' and payout 0 —
		// so these `??` arms are unreachable; they exist because the columns are
		// nullable in the schema for the sake of open bets.
		tier: bet.settlementTier ?? 'miss',
		payout: bet.payout ?? 0,
		settledOn: istDateStr(new Date(bet.settledAt ?? bet.createdAt))
	};
}

/** A profile with no settled bets yet has no win rate to speak of. */
export function winRateOf(stats: Pick<UserStats, 'betsPlaced' | 'betsWon'>): number | null {
	return stats.betsPlaced > 0 ? stats.betsWon / stats.betsPlaced : null;
}

/**
 * Build the public profile for a handle, or `null` when nobody owns it — the
 * caller's 404. Reads only; `user_stats.getUserStats` materializes a zeroed row
 * for a player who has never settled, which is that repo's documented contract
 * (one row per user, bounded, and never a counter).
 */
export async function buildPublicProfile(
	handle: string,
	options: ProfileOptions = {}
): Promise<PublicProfile | null> {
	const store = options.store ?? getStore();
	const limit = Math.max(0, options.recentLimit ?? PROFILE_RECENT_BETS);

	const profile: Profile | null = await store.profiles.getProfileByHandle(handle);
	if (!profile) return null;

	const [stats, bets] = await Promise.all([
		store.stats.getUserStats(profile.userId),
		store.bets.listRecentSettledBets(profile.userId, limit)
	]);

	return {
		handle: profile.handle,
		balance: profile.balance,
		xp: profile.xp,
		streakDays: profile.streakDays,
		winRate: winRateOf(stats),
		totals: {
			betsPlaced: stats.betsPlaced,
			betsWon: stats.betsWon,
			totalStaked: stats.totalStaked,
			totalWon: stats.totalWon,
			bestPayout: stats.bestPayout
		},
		recentBets: bets.map(toPublicBet),
		joined: istDateStr(new Date(profile.createdAt)),
		rank: rankViewFor(profile.xp)
	};
}
