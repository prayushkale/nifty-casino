import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authNotConfigured, readJsonObject, supabaseErrorResponse } from '$lib/server/auth/http';
import { readEmail } from '$lib/server/auth/signup';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/forgot — { email } → resetPasswordForEmail.
 *
 * `redirectTo` points at `/auth/confirm?type=recovery`, not straight at
 * `/auth/reset`: the token has to be exchanged server-side (which is where
 * cookies can be written) before there is a recovery session to set a password
 * with. `/auth/confirm` then sends the player on to `/auth/reset`. It also works
 * when the project's email template uses the `{{ .TokenHash }}` form, in which
 * case Supabase ignores `redirectTo` and links to our confirm route directly.
 *
 * No dev fallback: there is nothing to reset in dev mode, and pretending
 * otherwise would leak whether a handle exists.
 *
 * The response is identical whether or not the address is registered — password
 * reset must not become a user enumerator.
 */
export const POST: RequestHandler = async (event) => {
	const body = await readJsonObject(event.request);
	const email = readEmail(body?.email);
	if (!email) return json({ error: 'Enter a valid email address.' }, { status: 400 });

	const supabase = getSupabaseForEvent(event);
	if (!supabase) return authNotConfigured();

	const { error } = await supabase.auth.resetPasswordForEmail(email, {
		redirectTo: `${event.url.origin}/auth/confirm?type=recovery`
	});
	if (error) return supabaseErrorResponse(error);

	return json({ ok: true });
};

export const prerender = false;
