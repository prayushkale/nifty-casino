/**
 * HTTP glue for the bet routes (`/api/bets`, `/api/bets/[id]`).
 *
 * Kept out of `$lib/server/bets` so the money service stays framework-free and
 * reusable from the dry-run/load scripts (PLAN T17). All the route-specific
 * policy in one place: the auth check, the error mapping and the cache headers.
 */
import { json } from '@sveltejs/kit';
import { BET_ERROR_STATUS, BetError } from '$lib/server/bets';
import { readJsonObject } from '$lib/server/auth/http';

/** Map a service error onto the auth folder's `{ error }` convention. */
export function betErrorResponse(err: unknown): Response {
	if (err instanceof BetError) {
		return json({ error: err.code, ...err.details }, { status: BET_ERROR_STATUS[err.code] });
	}
	// A non-BetError here is a bug or an outage — 500 with no internals attached.
	console.error('[api/bets] unexpected failure', err);
	return json({ error: 'BET_FAILED' }, { status: 500 });
}

/** 401 for a request whose identity the auth hooks could not resolve. */
export function unauthenticated(): Response {
	return json({ error: 'UNAUTHENTICATED' }, { status: 401 });
}

/** The parsed body, or the 400 response to return instead. */
export type ParsedBetBody =
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; response: Response };

/** The JSON body, or the 400 the route returns when it is absent or not an object. */
export async function readBetBody(request: Request): Promise<ParsedBetBody> {
	const body = await readJsonObject(request);
	return body
		? { ok: true, body }
		: { ok: false, response: json({ error: 'VALIDATION_FAILED' }, { status: 400 }) };
}

/** Success headers: a bet response is per-user, so nothing may cache it. */
export const BET_RESPONSE_HEADERS = { 'cache-control': 'private, no-store' } as const;
