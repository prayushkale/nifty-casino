/**
 * GET /api/pot — the platform counters behind the always-on pot ticker
 * (PLAN §0 "totals visibility", §5 T10).
 *
 *   { serverNow, tradeDate,
 *     today:     { tradeDate, totalBets, totalStaked, totalPaidOut, playersCount, updatedAt },
 *     yesterday: same | null }
 *
 * `today` is ALWAYS present: a day nobody has bet on yet reads as a zeroed row,
 * so the ticker never has to branch on a missing field. `yesterday` is `null`
 * when there is no row for it — "no game yesterday" is a different sentence from
 * "0 NC staked yesterday".
 *
 * No auth (it is room-wide, not per-user) and NO WRITES: `buildPotSnapshot` reads
 * `daily_pots` with `getDailyPot`, never `ensureDailyPot`, so a poll loop that
 * hits this every second cannot mint rows. The counters themselves are only ever
 * moved by the money paths inside a bet transaction (PLAN §3 — deltas, never a
 * SUM over `bets` at read time).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStore } from '$lib/server/db';
import { buildPotSnapshot } from '$lib/server/state';
import { istDateStr } from '$lib/time/ist';

export const GET: RequestHandler = async () => {
	const now = new Date();
	const tradeDate = istDateStr(now);
	const pot = await buildPotSnapshot(getStore(), tradeDate);
	return json(
		{ serverNow: now.getTime(), tradeDate, ...pot },
		{ headers: { 'cache-control': 'no-store' } }
	);
};

export const prerender = false;
