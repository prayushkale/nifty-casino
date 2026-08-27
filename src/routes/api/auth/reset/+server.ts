import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	authNotConfigured,
	readJsonObject,
	supabaseErrorResponse,
	validationFailed
} from '$lib/server/auth/http';
import { readPasswordError } from '$lib/server/auth/signup';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';

/**
 * POST /api/auth/reset — { password } → updateUser({ password }).
 *
 * Only meaningful while holding a **recovery session**, which is what
 * `/auth/confirm` establishes after the email link is exchanged. Without one
 * Supabase rejects the call and that rejection is relayed as-is: it is the
 * server's answer, not ours to soften.
 */
export const POST: RequestHandler = async (event) => {
	const body = await readJsonObject(event.request);
	const passwordError = readPasswordError(body?.password);
	if (passwordError) return validationFailed({ password: passwordError });

	const supabase = getSupabaseForEvent(event);
	if (!supabase) return authNotConfigured();

	const password = body?.password as string;
	const { error } = await supabase.auth.updateUser({ password });
	if (error) return supabaseErrorResponse(error);

	return json({ ok: true });
};

export const prerender = false;
