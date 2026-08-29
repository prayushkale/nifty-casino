/**
 * The /history projection (PLAN §5 T14: "own bets with outcomes") — the shape
 * `src/routes/history/+page.server.ts` and `GET /api/history` both serve.
 *
 * This is the /history twin of `$lib/server/profile`: a hand-written projection,
 * not a row dump, because the ONLY reader of this payload is the player themself
 * and the page must still not carry more than it renders. Written out field by
 * field — nothing is spread — so a column added to `bets` tomorrow cannot reach
 * the wire by accident.
 *
 *   `userId` / `sessionId`  — server bookkeeping; the player identifies their rows
 *                             by what they are, not by a uuid
 *   `settlementTier`/`payout` stay nullable ON PURPOSE: a live bet is the most
 *   interesting row on your own history, and the page renders it as LIVE rather
 *   than as a fabricated verdict.
 */
import { HISTORY_PAGE_SIZE, MAX_LEADERBOARD_ROWS } from '$lib/config/app';
import { getStore, type GameStore } from '$lib/server/db';
import type { Bet, SettlementTier, Underlying } from '$lib/server/db/types';
import { winRateOf } from '$lib/server/profile';

/** Rows the page loads per "page", and the only size `GET /api/history` serves. */
export const HISTORY_ROWS = HISTORY_PAGE_SIZE;

/** One row of the player's own bet log. */
export type HistoryBet = {
	/** Kept so "Load more" can carry the keyset cursor back up. Not a secret to its owner. */
	id: string;
	underlying: Underlying;
	targetKind: 'up' | 'down';
	/** The round-number move the player called, in points. */
	deltaPoints: number;
	/** Multiplier frozen at bet time. */
	odds: number;
	stake: number;
	/** `null` while the bet is live — rendered as LIVE, never as a verdict. */
	settlementTier: SettlementTier | null;
	/** `null` while the bet is live. 0 for a miss, which is the verdict, not an absence. */
	payout: number | null;
	/** epoch ms — placed. */
	createdAt: number;
	/** epoch ms — settled; `null` while live. */
	settledAt: number | null;
};

/** The personal totals header, all from `user_stats` (one row, never a scan). */
export type HistoryTotals = {
	betsPlaced: number;
	betsWon: number;
	/** `betsWon / betsPlaced`, or `null` when nothing has settled yet. */
	winRate: number | null;
	totalStaked: number;
	totalWon: number;
	bestPayout: number;
};

/** One page of the log, plus what the client needs to ask for the next one. */
export type HistoryPage = {
	/** Newest first. */
	bets: HistoryBet[];
	/**
	 * Send these back as `?before=`/`?beforeId=` for the next page, or `null` when
	 * there is no next page — the button disappears instead of returning an empty
	 * one.
	 */
	nextCursor: { before: string; beforeId: string } | null;
	hasMore: boolean;
};

/** The public projection of one bet row — see {@link HistoryBet} for what is dropped. */
export function toHistoryBet(bet: Bet): HistoryBet {
	return {
		id: bet.id,
		underlying: bet.underlying,
		targetKind: bet.targetKind,
		deltaPoints: bet.deltaPoints,
		odds: bet.odds,
		stake: bet.stake,
		settlementTier: bet.settlementTier,
		payout: bet.payout,
		createdAt: bet.createdAt,
		settledAt: bet.settledAt
	};
}

export type HistoryOptions = {
	/** Defaults to the process store. */
	store?: GameStore;
};

/** The header numbers. `getUserStats` materializes a zeroed row, so a new player reads zeros, not a 404. */
export async function buildHistoryTotals(
	userId: string,
	options: HistoryOptions = {}
): Promise<HistoryTotals> {
	const stats = await (options.store ?? getStore()).stats.getUserStats(userId);
	return {
		betsPlaced: stats.betsPlaced,
		betsWon: stats.betsWon,
		winRate: winRateOf(stats),
		totalStaked: stats.totalStaked,
		totalWon: stats.totalWon,
		bestPayout: stats.bestPayout
	};
}

export type ListHistoryPageOptions = HistoryOptions & {
	/** epoch ms — the previous page's last `createdAt`. Absent on the first page. */
	beforeCreatedAt?: number;
	/** Keyset tie-break for rows that share {@link beforeCreatedAt}. */
	beforeId?: string;
	/** Rows to return, clamped to {@link MAX_LEADERBOARD_ROWS}. Defaults to {@link HISTORY_ROWS}. */
	limit?: number;
};

/**
 * One page of the player's own bets, newest first, keyset-paginated.
 *
 * The reader fetches `limit + 1` rows and only returns `limit`: the extra row is
 * the "is there another page?" probe, so `hasMore` is a fact rather than a guess
 * from a full page, and the UI never renders a "Load more" that comes back
 * empty. The cursor is derived from the last row actually returned.
 */
export async function listHistoryPage(
	userId: string,
	options: ListHistoryPageOptions = {}
): Promise<HistoryPage> {
	const limit = Math.min(
		Math.max(1, Math.trunc(options.limit ?? HISTORY_ROWS)),
		MAX_LEADERBOARD_ROWS
	);
	const rows = await (options.store ?? getStore()).bets.listBetsForUserPage(userId, {
		beforeCreatedAt: options.beforeCreatedAt,
		beforeId: options.beforeId,
		// +1 is the probe; the driver's own cap still bounds this read.
		limit: limit + 1
	});

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);

	return {
		bets: page.map(toHistoryBet),
		hasMore,
		// `Date.toISOString()` is the wire form of the cursor — unambiguous, sortable
		// and parseable back to the exact millisecond on the way in.
		nextCursor:
			hasMore && last ? { before: new Date(last.createdAt).toISOString(), beforeId: last.id } : null
	};
}
