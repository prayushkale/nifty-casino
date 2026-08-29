/**
 * The game page's load — the SAME server function `/api/state` calls (PLAN §5 T11
 * "Server-load from /api/state").
 *
 * Reusing `buildStatePayload` rather than fetching our own endpoint matters for
 * two reasons: the first paint carries the whole board (no client round trip, no
 * loading flash on the money figures), and there is exactly one definition of what
 * a screen rebuild is — a change to the payload shape cannot leave the SSR'd page
 * and the client's re-fetch disagreeing. `locals` supplies the identity the hooks
 * resolved; an anonymous visitor gets the same payload with `user: null`, which is
 * the view-only board.
 */
import type { PageServerLoad } from './$types';
import { buildStatePayload } from '$lib/server/state';

export const load: PageServerLoad = async ({ locals }) => {
	return {
		state: await buildStatePayload({ userId: locals.userId, authSource: locals.authSource })
	};
};
