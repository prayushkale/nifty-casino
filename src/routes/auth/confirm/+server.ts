import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSupabaseForEvent } from '$lib/server/auth/supabaseServer';
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * GET /auth/confirm — the landing page for every link Supabase emails out.
 *
 * Two link shapes arrive here and both are handled, because which one you get
 * depends on how the project's email templates are written:
 *
 *   • `?token_hash=<hash>&type=signup|recovery|…`  (the shape the Supabase SSR
 *     guides recommend building templates from — `{{ .TokenHash }}`)
 *   • `?code=<verifier>`                            (a PKCE `{{ .ConfirmationURL }}`)
 *
 * The exchange has to happen server-side: it is the only place the resulting
 * session can be turned into cookies, and a session cookie is exactly what
 * `/auth/reset` needs in order to call `updateUser({ password })`.
 *
 * Unauthenticated by design — it is the one route that exists to consume an
 * emailed token, so it never checks `locals.userId` first. Where it sends you:
 * signup → `/`, recovery → `/auth/reset`, anything wrong → `/auth/login?error=`.
 */
export const GET: RequestHandler = async (event) => {
	const supabase = getSupabaseForEvent(event);
	if (!supabase) {
		return redirect(
			303,
			`/auth/login?error=${encodeURIComponent('Auth is not configured on this deployment.')}`
		);
	}

	const code = event.url.searchParams.get('code');
	const tokenHash = event.url.searchParams.get('token_hash');
	const rawType = event.url.searchParams.get('type');
	const type = EMAIL_OTP_TYPES.find((t) => t === rawType) ?? null;

	// A recovery link must end at the new-password form; everything else goes home.
	const next = type === 'recovery' ? '/auth/reset' : '/';

	if (code) {
		const { error } = await supabase.auth.exchangeCodeForSession(code);
		return confirmRedirect(next, error);
	}

	if (tokenHash && type) {
		const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
		return confirmRedirect(next, error);
	}

	// No token at all. Usually a link clicked twice (the first use consumed it) or
	// a hand-typed URL — both are harmless, so send them home rather than scolding.
	return redirect(303, next);
};

/** Map a failed exchange onto the login page with a readable banner message. */
function confirmRedirect(next: string, error: { message: string } | null): never {
	if (error) {
		const message = /already|confirmed/i.test(error.message)
			? 'That link was already used — try logging in instead.'
			: `Could not confirm: ${error.message}`;
		return redirect(303, `/auth/login?error=${encodeURIComponent(message)}`);
	}
	return redirect(303, next);
}

/** The OTP types that can arrive by email; anything else in `?type=` is rejected. */
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
	'signup',
	'invite',
	'magiclink',
	'recovery',
	'email_change',
	'email'
];

export const prerender = false;
