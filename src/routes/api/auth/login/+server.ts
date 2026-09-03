import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authNotConfigured, readJsonObject, supabaseErrorResponse } from '$lib/server/auth/http';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';
import { ensureSupabaseProfile } from '$lib/server/auth/supabaseBackfill';
import { getStore } from '$lib/server/db';

/**
 * POST /api/auth/login — { email, password } → signInWithPassword.
 *
 * On success @supabase/ssr has written the session cookies, so the browser is
 * logged in without a token ever reaching JS. There is deliberately no dev
 * fallback here: a dev "login" would be an unauthenticated identity claim, and
 * dev players simply use the signup endpoint with an existing handle (the dev
 * panel on /auth/login does exactly that). Hence `AUTH_NOT_CONFIGURED`, which
 * is what makes the UI show the dev panel.
 *
 * Answers `{ authenticated: true, handle }` — the handle is what the header
 * chrome renders, so the client must not have to wait for a second round trip
 * to know who just logged in. When the 0002 trigger never created the wallet
 * (migrations unpushed, pre-trigger user), the row is backfilled here so the
 * very next request already resolves a full identity instead of
 * `{ authenticated: true, handle: null }` with an empty header.
 */
export const POST: RequestHandler = async (event) => {
	const body = await readJsonObject(event.request);
	const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
	const password = typeof body?.password === 'string' ? body.password : '';
	if (email === '' || password === '') {
		return json({ error: 'Enter your email and password.' }, { status: 400 });
	}

	const supabase = getSupabaseForEvent(event);
	if (!supabase) return authNotConfigured();

	const { data, error } = await supabase.auth.signInWithPassword({ email, password });
	if (error) return supabaseErrorResponse(error);

	// The session cookies are set; make sure the wallet row exists too. A user
	// whose profile is missing would otherwise log in to an empty header —
	// authenticated with no handle, no balance, and Login buttons still showing.
	let handle: string | null = null;
	const user = data.user ?? null;
	if (user) {
		try {
			const { profile } = await ensureSupabaseProfile(getStore(), {
				userId: user.id,
				email: user.email ?? email,
				requestedHandle: (user.user_metadata as Record<string, unknown> | null)?.handle
			});
			handle = profile.handle;
		} catch {
			// A wallet repair must never fail the login itself — the session is
			// live and `/api/auth/me` still answers `authenticated: true`.
			handle = null;
		}
	}

	return json({ authenticated: true, handle });
};

export const prerender = false;
