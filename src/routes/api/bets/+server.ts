/**
 * POST /api/bets — place a bet (PLAN §5 T7).
 *
 * Body `{ underlying, targetKind, deltaPoints, stake }` → 201 `{ bet }`, or a
 * typed error: 400 `INVALID_*`, 409 `MARKET_CLOSED` / `WINDOW_NOT_OPEN` /
 * `CUTOFF_PASSED` / `SESSION_CLOSED` / `BET_EXISTS` / `INSUFFICIENT_BALANCE`.
 *
 * TWO things this route deliberately cannot do:
 *  • accept an `odds` field. There is no such input anywhere in the chain — odds
 *    are resolved from today's ladder by the service (`$lib/server/bets`), so a
 *    client sending `"odds": 1000` is sending an ignored field, not a payout.
 *  • decide the time. `now` is the server's, the trade date and the cutoff are
 *    derived from it, and the driver re-checks both against the session row.
 *
 * Every failure is the service's own {@link BetError} code, so the body is always
 * `{ error: CODE, ...details }` and never a driver message or a stack trace.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { placeBet } from '$lib/server/bets';
import {
	BET_RESPONSE_HEADERS,
	betErrorResponse,
	readBetBody,
	unauthenticated
} from '$lib/server/bets-http';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (locals.userId === null) return unauthenticated();

	const parsed = await readBetBody(request);
	if (!parsed.ok) return parsed.response;
	const { body } = parsed;

	try {
		const bet = await placeBet(
			locals.userId,
			{
				underlying: body.underlying,
				targetKind: body.targetKind,
				deltaPoints: body.deltaPoints,
				stake: body.stake
			},
			{ live: {} }
		);
		return json({ bet }, { status: 201, headers: BET_RESPONSE_HEADERS });
	} catch (err: unknown) {
		return betErrorResponse(err);
	}
};

export const prerender = false;
