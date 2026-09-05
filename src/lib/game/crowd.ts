/**
 * The crowd consensus (STRIKE-distribution feature): how the day's bets spread
 * across the strike ladder, per index.
 *
 * A player picking a strike is guessing where the CAS close will land. Showing
 * where EVERYONE's money guesses turns the board into a crowd read — "most
 * players think the close is near 24,850" — the same social signal a betting
 * ring or a poll gives, computed from the one active bet per (user, index) the
 * UNIQUE key already guarantees.
 *
 * Pure module: bets in, distribution out. The server (`$lib/server/state`)
 * feeds it the session's bet rows; the client only renders the payload — the
 * percentages are always the server's numbers, never a local guess.
 *
 * PRIVACY: the output is aggregate counts and shares per strike. No handles,
 * no user ids — a stranger may see that 34% of players picked a level, never
 * who.
 */

/**
 * One strike's share of an index's bets. `deltaPoints` + `targetKind` identify
 * the strike the same way a bet row does (the absolute level is
 * `anchor ± deltaPoints`, which the client derives from the ladder payload —
 * the aggregate never needs the anchor).
 */
export type CrowdPick = {
	targetKind: 'up' | 'down';
	/** Points from the anchor — matches `bets.delta_points`. */
	deltaPoints: number;
	/** How many active bets sit on this strike. */
	count: number;
	/** Share of the index's bets, in percent, rounded to 1 dp (0–100). */
	pct: number;
};

/**
 * The shape `/api/state` carries: per index, one row per picked strike,
 * biggest count first (ties broken by the strike key for determinism), and the
 * index's total so the UI can say "34% of 12 bets".
 */
export type CrowdDistribution = Record<string, CrowdPick[]>;

/** The minimal bet shape the aggregation reads — `Bet` satisfies it. */
export type CrowdBet = {
	underlying: string;
	targetKind: 'up' | 'down';
	deltaPoints: number;
};

/**
 * Group the day's bets per index by strike and compute shares.
 *
 * An index with no bets is absent from the record (the UI renders nothing
 * rather than rows of "0%"), and a bet with a malformed direction is skipped —
 * an aggregate must not crash on a row the CHECK constraint should have kept
 * out anyway.
 */
export function buildCrowdDistribution(bets: CrowdBet[]): CrowdDistribution {
	const counts = new Map<string, Map<string, number>>();
	for (const bet of bets) {
		if (bet.targetKind !== 'up' && bet.targetKind !== 'down') continue;
		const key = `${bet.underlying}`;
		const perIndex = counts.get(key) ?? new Map<string, number>();
		const strikeKey = `${bet.targetKind}:${bet.deltaPoints}`;
		perIndex.set(strikeKey, (perIndex.get(strikeKey) ?? 0) + 1);
		counts.set(key, perIndex);
	}

	const distribution: CrowdDistribution = {};
	for (const [underlying, perIndex] of counts) {
		const total = [...perIndex.values()].reduce((sum, n) => sum + n, 0);
		const picks: CrowdPick[] = [...perIndex.entries()]
			.map(([strikeKey, count]) => {
				const sep = strikeKey.indexOf(':');
				return {
					targetKind: strikeKey.slice(0, sep) as 'up' | 'down',
					deltaPoints: Number(strikeKey.slice(sep + 1)),
					count,
					pct: Math.round((count / total) * 1000) / 10
				};
			})
			// Biggest first; ties break by direction then distance so every node
			// renders the same order from the same data.
			.sort(
				(a, b) =>
					b.count - a.count ||
					a.targetKind.localeCompare(b.targetKind) ||
					a.deltaPoints - b.deltaPoints
			);
		distribution[underlying] = picks;
	}
	return distribution;
}

/** The index's total bets behind a distribution — 0 when the index is absent. */
export function crowdTotal(distribution: CrowdDistribution, underlying: string): number {
	return (distribution[underlying] ?? []).reduce((sum, pick) => sum + pick.count, 0);
}

/**
 * The most-picked strike of an index — the row the UI badges. `null` when
 * nobody has bet the index yet; ties resolve to the FIRST pick of the sorted
 * list (deterministic — see the sort in {@link buildCrowdDistribution}).
 */
export function crowdLeader(picks: CrowdPick[] | undefined): CrowdPick | null {
	if (!picks || picks.length === 0) return null;
	return picks[0];
}
