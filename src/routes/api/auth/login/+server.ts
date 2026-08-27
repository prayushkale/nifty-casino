import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authNotConfigured, readJsonObject, supabaseErrorResponse } from '$lib/server/auth/http';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/login — { email, password } → signInWithPassword.
 *
 * On success @supabase/ssr has written the session cookies, so the browser is
 * logged in without a token ever reaching JS. There is deliberately no dev
 * fallback here: a dev "login" would be an unauthenticated identity claim, and
 * dev players simply use the signup endpoint with an existing handle (the dev
 * panel on /auth/login does exactly that). Hence `AUTH_NOT_CONFIGURED`, which
 * is what makes the UI show the dev panel.
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

	const { error } = await supabase.auth.signInWithPassword({ email, password });
	if (error) return supabaseErrorResponse(error);

	return json({ authenticated: true });
};

export const prerender = false;
