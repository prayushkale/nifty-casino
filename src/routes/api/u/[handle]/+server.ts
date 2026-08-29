/**
 * GET /api/u/<handle> — the public profile as JSON (PLAN §0 "totals visibility",
 * §5 T10). Same projection the `/u/<handle>` page server-renders, for anything
 * that wants the numbers without the chrome (and for T14's leaderboard links).
 *
 *   200 { profile: { handle, balance, xp, streakDays, winRate, totals,
 *                    recentBets, joined, rank } }
 *   404 { error: 'NOT_FOUND' }      — nobody owns that handle
 *   400 { error: 'INVALID_HANDLE' } — it cannot be a handle, so it is not a lookup
 *
 * PUBLIC, and therefore the privacy boundary: `$lib/server/profile` is a
 * hand-written projection with no email, no user_id, no authSource and no
 * ledger. A malformed handle is a 400 rather than a 404 so a crawler probing
 * `/api/u/<script>` learns only that the name was never possible, not that the
 * lookup ran.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HANDLE_PATTERN } from '$lib/server/auth/handles';
import { buildPublicProfile } from '$lib/server/profile';

export const GET: RequestHandler = async ({ params }) => {
	const handle = (params.handle ?? '').trim().toLowerCase();
	if (!HANDLE_PATTERN.test(handle)) {
		return json({ error: 'INVALID_HANDLE' }, { status: 400 });
	}

	const profile = await buildPublicProfile(handle);
	if (!profile) return json({ error: 'NOT_FOUND' }, { status: 404 });

	// no-store: the balance and the streak move during the day, and the numbers on
	// a public page must not outlive the request that served them.
	return json({ profile }, { headers: { 'cache-control': 'no-store' } });
};

export const prerender = false;
