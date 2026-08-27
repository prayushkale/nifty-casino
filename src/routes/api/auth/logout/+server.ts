import type { RequestHandler } from './$types';
import { clearDevSessionCookie } from '$lib/server/auth/devAuth';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/logout → 204, empty body.
 *
 * Clears whichever session mechanism is live, and both cookies when both are
 * present: a developer who ran the app unconfigured and then pointed it at a
 * real project carries a `nc_dev_uid` that must not survive a logout. Supabase
 * session cookies are revoked server-side by `signOut()` and dropped by the
 * @supabase/ssr cookie write that follows.
 */
export const POST: RequestHandler = async (event) => {
	const supabase = getSupabaseForEvent(event);
	if (supabase) await supabase.auth.signOut();
	clearDevSessionCookie(event.cookies, event.url);
	return new Response(null, { status: 204 });
};

export const prerender = false;
