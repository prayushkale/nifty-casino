/**
 * `/leaderboard` — the server load (PLAN §5 T14, §4 "top balances, today's best
 * calls").
 *
 * One call to the shared service, which is cached for 30s per process, so the
 * page costs no more than a cached object read on a hot path and every visitor
 * sees the same board. Nothing here reads `locals`: the board is public and
 * identical for everyone, which is also why the payload is safe to hand to SSR
 * without a per-user cache key.
 */
import type { PageServerLoad } from './$types';
import { getLeaderboard } from '$lib/server/leaderboard';

export const load: PageServerLoad = async () => {
	return { board: await getLeaderboard() };
};

export const prerender = false;
