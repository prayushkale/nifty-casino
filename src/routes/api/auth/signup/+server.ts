import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStore } from '$lib/server/db';
import { ensureDevProfile, isDevAuthEnabled, setDevSessionCookie } from '$lib/server/auth/devAuth';
import {
	authNotConfigured,
	readJsonObject,
	supabaseErrorResponse,
	validationFailed
} from '$lib/server/auth/http';
import { validateSignupRequest } from '$lib/server/auth/signup';
import { ensureSupabaseProfile } from '$lib/server/auth/supabaseBackfill';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/signup — { email, password, handle?, tos }
 *
 * Configured (Supabase):
 *   hands the credentials to `auth.signUp`. The handle travels in
 *   `options.data.handle` because that is where migration 0002's trigger reads
 *   it (`raw_user_meta_data->>'handle'`) — this is the only way to request one.
 *   Email confirmations ON  → `{ needsVerify: true }`, wait for the link.
 *   Email confirmations OFF → signUp already returned a session and the
 *   @supabase/ssr cookie write happened inside `setAll`, so the very next
 *   request is authenticated. Both shapes are handled; the client reads
 *   `needsVerify`.
 *
 * Unconfigured (dev fallback):
 *   provisions the wallet in the local store and mints the `nc_dev_uid` cookie.
 *   ⚠ This branch is an unauthenticated identity-claim endpoint — see devAuth.ts
 *   for why that is survivable and how it is fenced off.
 */
export const POST: RequestHandler = async (event) => {
	const body = await readJsonObject(event.request);
	const parsed = validateSignupRequest(body);
	if (!parsed.ok) return validationFailed(parsed.fieldErrors);
	const { email, password, handle } = parsed.value;

	// ---------------------------------------------------------------- Supabase
	const supabase = getSupabaseForEvent(event);
	if (supabase) {
		const { data, error } = await supabase.auth.signUp({
			email,
			password,
			options: {
				// `undefined` drops the key entirely, so the trigger generates a handle
				// exactly as if the player had left the field blank.
				data: { handle: handle ?? undefined },
				emailRedirectTo: `${event.url.origin}/auth/confirm`
			}
		});
		if (error) return supabaseErrorResponse(error);
		// Confirmations-off means the session is live right now but the trigger
		// may not have written the wallet — same backfill as login, best effort.
		let confirmedHandle = handle;
		if (data.session && data.user) {
			try {
				const { profile } = await ensureSupabaseProfile(getStore(), {
					userId: data.user.id,
					email,
					requestedHandle: handle
				});
				confirmedHandle = profile.handle;
			} catch {
				/* login-time repair covers it — signup itself succeeded */
			}
		}
		return json({ needsVerify: !data.session, handle: confirmedHandle });
	}

	// ------------------------------------------------------------- dev fallback
	if (!isDevAuthEnabled()) return authNotConfigured();
	const { profile } = await ensureDevProfile(getStore(), { handle, email });
	setDevSessionCookie(event.cookies, profile.userId, event.url);
	return json({ dev: true, handle: profile.handle });
};

export const prerender = false;
