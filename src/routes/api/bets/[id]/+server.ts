/**
 * PATCH /api/bets/[id] — edit a bet before the cutoff → 200 `{ bet }`.
 * DELETE /api/bets/[id] — cancel it before the cutoff → 200 `{ refunded }`.
 *
 * The patch accepts `{ targetKind?, deltaPoints?, stake? }`; an absent field means
 * "unchanged", and a moved target is re-priced from today's ladder (never from the
 * body — see the note on `odds` in ../+server.ts).
 *
 * Errors, all typed codes from the service: 404 `BET_NOT_FOUND` (someone else's
 * bet reads exactly the same as a missing one), 409 `BET_SETTLED`,
 * `SESSION_CLOSED`, `CUTOFF_PASSED`, `INSUFFICIENT_BALANCE`, 400 `INVALID_*`.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelBet, editBet } from '$lib/server/bets';
import {
	BET_RESPONSE_HEADERS,
	betErrorResponse,
	readBetBody,
	unauthenticated
} from '$lib/server/bets-http';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (locals.userId === null) return unauthenticated();

	const parsed = await readBetBody(request);
	if (!parsed.ok) return parsed.response;
	const { body } = parsed;

	try {
		const bet = await editBet(locals.userId, params.id, {
			// An absent field stays `undefined`, which the service reads as "unchanged".
			targetKind: body.targetKind,
			deltaPoints: body.deltaPoints,
			stake: body.stake
		});
		return json({ bet }, { status: 200, headers: BET_RESPONSE_HEADERS });
	} catch (err: unknown) {
		return betErrorResponse(err);
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (locals.userId === null) return unauthenticated();

	try {
		const { refunded } = await cancelBet(locals.userId, params.id);
		return json({ refunded }, { status: 200, headers: BET_RESPONSE_HEADERS });
	} catch (err: unknown) {
		return betErrorResponse(err);
	}
};

export const prerender = false;
