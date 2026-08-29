/**
 * GET /api/state — THE one-request screen rebuild (PLAN §2 "refresh/reconnect
 * contract", §5 T10). One call answers "what is on my screen right now" for a
 * cold load, a refresh, a tab switch, a reconnect after the network dropped and
 * a return the next morning; no client-held state is authoritative.
 *
 *   { serverNow, tradeDate,
 *     session: { exists, status, cutoffAtMs, bettingWindowOpen, auctionLive, settled },
 *     user:    { handle, balance, xp, streakDays, lastBetDate, authSource, stats } | null,
 *     myBets:  [ { id, underlying, targetKind, deltaPoints, odds, stake,
 *                  settlementTier, payout, createdAt } ],        — today's, newest first
 *     pot:     { today, yesterday },
 *     ladder:  { tradeDate, anchors, options } }
 *
 * Deliberately absent:
 *  • `preview` — the projected "if closed now" payout strip is the ladder plus
 *    `computeTier`, which is pure and browser-safe; shipping 24 pre-computed
 *    verdicts per request to save the client 24 subtractions would be the wrong
 *    trade on the payload that every client polls.
 *  • `email`, `user_id` — see the privacy note in `$lib/server/state`. The
 *    handle is the only identity this payload carries.
 *
 * `serverNow` is the single instant every time flag was computed at, so the
 * client can drift-correct its countdown (PLAN §6 R3) from one number.
 *
 * Anonymous requests get the same payload with `user: null` and `myBets: []` —
 * the room is public, your wallet is not. `private, no-store`: the answer is
 * per-user, so neither a CDN nor a browser cache may keep it.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildStatePayload } from '$lib/server/state';

export const GET: RequestHandler = async ({ locals }) => {
	const payload = await buildStatePayload({ userId: locals.userId, authSource: locals.authSource });
	return json(payload, { headers: { 'cache-control': 'private, no-store' } });
};

export const prerender = false;
