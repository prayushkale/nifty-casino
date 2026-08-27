/**
 * Identity resolution — the one function that decides who a request is from.
 * `src/hooks.server.ts` calls it for every request and stores the result on
 * `event.locals`, so no route ever talks to Supabase or peeks at a cookie.
 *
 * Two modes, chosen by configuration and never by the caller:
 *
 *   1. Supabase configured  → `supabase.auth.getUser()` revalidates the session
 *      cookies against the auth server. The handle comes from the `profiles`
 *      row, which is what the 0002 trigger wrote and the one place the
 *      *unique* handle lives (`user_metadata.handle` may have lost a race).
 *   2. Supabase unconfigured → the dev-auth cookie (see ./devAuth), whose
 *      id is looked up in the same `profiles` table. The guard is checked
 *      again here, so a leftover dev cookie cannot outlive the mode it was
 *      minted in.
 *
 * Anything else is anonymous — and anonymous is a normal state, not an error:
 * the game page, `/terms` and the auth pages are all readable signed out.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cookies } from '@sveltejs/kit';
import { getStore, type GameStore } from '$lib/server/db';
import { env } from '$env/dynamic/private';
import { DEV_COOKIE_NAME, isDevAuthEnabled, readDevUserId } from './devAuth';
import { getSupabaseForEvent, type CookieEvent } from './supabaseServer';

/** Where the identity came from — the header chrome shows it, `/api/auth/me` returns it. */
export type AuthSource = 'supabase' | 'dev' | null;

export type Identity = {
	userId: string | null;
	handle: string | null;
	source: AuthSource;
};

export const ANONYMOUS: Identity = { userId: null, handle: null, source: null };

/**
 * Paths that must not pay a `profiles` round trip: the SSE stream is the hottest
 * endpoint in the app (one connection per player, held open for the auction) and
 * hashed assets are browser-cached, and neither can ever render a handle.
 */
const PROFILE_LOOKUP_SKIPPED = ['/_app/', '/api/stream', '/favicon'];

export function needsProfileRow(pathname: string): boolean {
	return !PROFILE_LOOKUP_SKIPPED.some((prefix) => pathname.startsWith(prefix));
}

/** What `resolveIdentity` needs from the request — a subset of RequestEvent. */
export type SessionEvent = CookieEvent & { url: URL; cookies: Cookies };

export type ResolveIdentityDeps = {
	/** Defaults to the process-wide store. */
	store?: GameStore;
	/** Defaults to `$env/dynamic/private`. */
	env?: Record<string, string | undefined>;
	/** Test seam: stand in for `getSupabaseForEvent`, which would hit the network. */
	supabase?: SupabaseClient | null;
};

export async function resolveIdentity(
	event: SessionEvent,
	deps: ResolveIdentityDeps = {}
): Promise<Identity> {
	const store = deps.store ?? getStore();

	// -- 1. Supabase session -------------------------------------------------
	const supabase = deps.supabase ?? getSupabaseForEvent(event, deps.env ?? env);
	if (supabase) {
		const { data, error } = await supabase.auth.getUser();
		const user = error ? null : (data.user ?? null);
		if (!user) return ANONYMOUS;

		const profile = needsProfileRow(event.url.pathname)
			? await store.profiles.getProfile(user.id)
			: null;
		return { userId: user.id, handle: profile?.handle ?? null, source: 'supabase' };
	}

	// -- 2. Dev cookie -------------------------------------------------------
	// Guard re-checked here rather than trusted to the caller: if Supabase is now
	// configured, a `nc_dev_uid` cookie left over from a dev run must be worthless.
	if (!isDevAuthEnabled(deps.env ?? env)) return ANONYMOUS;

	const userId = readDevUserId(event.cookies);
	if (!userId) return ANONYMOUS;

	const profile = await store.profiles.getProfile(userId);
	if (!profile) {
		// Stale cookie (memory store restarted, or the row was removed). Forget it
		// rather than leaving the browser to send a dead id on every request.
		event.cookies.delete(DEV_COOKIE_NAME, { path: '/' });
		return ANONYMOUS;
	}
	return { userId: profile.userId, handle: profile.handle, source: 'dev' };
}
