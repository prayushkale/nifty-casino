/**
 * The XP → rank ladder (PLAN §0 "Gamification", §5 T13).
 *
 * PURE and client-safe: imported by the game page's XP strip, by the public
 * profile projection on the server (`$lib/server/profile`) and by the tests. No
 * store, no fetch, no clock — a rank is a pure function of an XP number, which
 * is why it is *derived at render time everywhere* and never stored: the
 * `profiles.xp` column is the only persisted fact, and a re-tune of this table
 * re-titles every player retroactively with zero migration.
 *
 * ── How the thresholds were shaped ───────────────────────────────────────────
 *
 * The only XP sources are `XP_PER_BET` (10, every bet that settles) and
 * `XP_PER_HIT` (+100, on top). Three bets a day is the hard ceiling
 * (`bets` UNIQUE per user/session/index), so:
 *
 *   • a player who never hits earns exactly 30 XP/day — the floor;
 *   • a casual player (PLAN's 30–40/day) lands one hit every few days;
 *   • a good player who calls one of three right most days earns 130–330/day,
 *     call it ~200/day sustained.
 *
 * Each rung is placed on that curve so the *feeling* is right at every speed:
 *
 *   30       one full session of three calls, no luck required → the first
 *            promotion lands inside the first session, before a player has
 *            decided whether to come back
 *   150      ~4 casual days, or one good hit-day (130) plus change
 *   500      ~2 weeks of showing up
 *   1,500    ~6 weeks casual, ~10 days for a good player
 *   4,000    ~a season; casual players meet it around month three
 *   10,000   a genuine habit — roughly three months of near-daily play
 *   20,000   LEGEND: ~100 days for a strong player at 200/day (a multi-month
 *            grind), and ~570 days for someone who never hits. Reaching it
 *            should be a story, not a checklist.
 *
 * Spacing widens monotonically (×3–×5 per rung) so early progress is fast and
 * the top of the ladder is never cheapened by inflation — the classic shape for
 * a title ladder people read out loud on a leaderboard.
 */
export type Rank = {
	/** 1-based position in the ladder — the number shown as “L4”. */
	readonly level: number;
	/** The title a player reads, and a stranger reads on their profile. */
	readonly title: string;
	/** One line of flavour — the tooltip, never load-bearing. */
	readonly tagline: string;
	/** Inclusive: `xp >= minXp` holds this rank. Ascending, `RANKS[0].minXp === 0`. */
	readonly minXp: number;
};

export const RANKS: readonly Rank[] = [
	{ level: 1, title: 'Rookie', tagline: 'First chips on the felt.', minXp: 0 },
	{ level: 2, title: 'Floor Walker', tagline: 'Knows which table is running hot.', minXp: 30 },
	{
		level: 3,
		title: 'Chip Stack',
		tagline: 'Shows up, calls the close, stacks a little more.',
		minXp: 150
	},
	{
		level: 4,
		title: 'Card Counter',
		tagline: 'Reads the tape before the auction opens.',
		minXp: 500
	},
	{
		level: 5,
		title: 'High Roller',
		tagline: 'Treats the stake limit as a suggestion.',
		minXp: 1_500
	},
	{
		level: 6,
		title: 'Pit Boss',
		tagline: 'The floor keeps an eye on them, not the other way round.',
		minXp: 4_000
	},
	{ level: 7, title: 'Whale', tagline: 'Moves the pot by walking in.', minXp: 10_000 },
	{ level: 8, title: 'Legend', tagline: 'The room still tells stories about them.', minXp: 20_000 }
] as const;

/**
 * The rank that holds `xp`. Junk clamps instead of throwing — a corrupted
 * payload must degrade to a title, never to a blank screen: negative and NaN
 * read as a fresh account, +Infinity as the top rung.
 */
export function rankFor(xp: number): Rank {
	if (xp === Number.POSITIVE_INFINITY) return RANKS[RANKS.length - 1];
	const safe = Number.isFinite(xp) && xp > 0 ? xp : 0;
	let current = RANKS[0];
	for (const rank of RANKS) {
		if (safe < rank.minXp) break;
		current = rank;
	}
	return current;
}

/** The next rank above `xp`, or `null` when the player already sits at the top. */
export function nextRank(xp: number): Rank | null {
	const current = rankFor(xp);
	return RANKS[current.level] ?? null;
}

/**
 * 0..1 through the CURRENT rung toward the next one — the XP bar's fill.
 *
 * Guarded on all four edges: non-finite/negative XP reads 0, a player exactly on
 * a threshold reads 0 of the new rung, and a max-rank player has no next rung so
 * the bar reads full (1) rather than lying about being one step from something.
 */
export function progressToNext(xp: number): number {
	const current = rankFor(xp);
	const next = nextRank(xp);
	if (next === null) return 1;
	const span = next.minXp - current.minXp;
	if (span <= 0) return 1;
	const value = (xp - current.minXp) / span;
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** Whole XP still owed before the next title, or `null` at the top of the ladder. */
export function xpToNext(xp: number): number | null {
	const next = nextRank(xp);
	if (next === null) return null;
	return Math.max(0, next.minXp - xp);
}

/** The four fields a UI renders for an XP value, computed once. */
export type RankView = {
	level: number;
	title: string;
	tagline: string;
};

/** The compact rank projection for a payload that must stay small (server → client). */
export function rankViewFor(xp: number): RankView {
	const rank = rankFor(xp);
	return { level: rank.level, title: rank.title, tagline: rank.tagline };
}
