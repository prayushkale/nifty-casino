import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authNotConfigured, readJsonObject, supabaseErrorResponse } from '$lib/server/auth/http';
import { readEmail } from '$lib/server/auth/signup';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/resend — { email } → resend the signup confirmation.
 *
 * Rate limited by Supabase (60s per address on the default provider); the 429
 * comes back through `supabaseErrorResponse` and the verify page shows it.
 */
export const POST: RequestHandler = async (event) => {
	const body = await readJsonObject(event.request);
	const email = readEmail(body?.email);
	if (!email) return json({ error: 'Enter a valid email address.' }, { status: 400 });

	const supabase = getSupabaseForEvent(event);
	if (!supabase) return authNotConfigured();

	const { error } = await supabase.auth.resend({
		type: 'signup',
		email,
		options: { emailRedirectTo: `${event.url.origin}/auth/confirm` }
	});
	if (error) return supabaseErrorResponse(error);

	return json({ ok: true });
};

export const prerender = false;
