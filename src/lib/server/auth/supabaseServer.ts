/**
 * Supabase server client for the *session* side of auth (T6) — the anon-key
 * client bound to the request's cookies.
 *
 * Three clients now exist and each has exactly one job; do not blur them:
 *
 *   • `src/lib/supabaseBrowser.ts`   — browser, anon key, session in localStorage
 *   • `supabaseServer.ts` (here)     — server, anon key, session in request cookies
 *   • `src/lib/server/supabaseAdmin.ts` — server, SERVICE ROLE, auth admin only
 *
 * Per-request by construction: `createServerClient` is called fresh on every
 * invocation because the client is bound to one request's cookies, and a
 * token refresh on request A must be written to A's response, never B's.
 *
 * `getUser()` — never `getSession()`. The session cookies are client-controlled
 * storage; `getSession()` reads them back without asking Supabase, so a forged
 * or stale pair would be trusted. `getUser()` revalidates the JWT against the
 * auth server on every call, which is the documented SSR contract.
 *
 * Returns `null` when the project is not configured, exactly like the browser
 * module: auth is optional, the game is not, and a throw here would take out
 * every request. Callers fall back to the dev-auth path or answer 400.
 */
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cookies } from '@sveltejs/kit';
import { serverEnv as env } from '$lib/server/env';

/** Same value as `PUBLIC_SUPABASE_URL` in ../supabaseAdmin.ts and $lib/supabaseBrowser.ts. */
export const SUPABASE_AUTH_URL_VARS = ['SUPABASE_URL', 'PUBLIC_SUPABASE_URL'] as const;
export const SUPABASE_ANON_KEY_VARS = ['SUPABASE_ANON_KEY', 'PUBLIC_SUPABASE_ANON_KEY'] as const;

export type SupabaseAuthConfig = { url: string; anonKey: string };

/** The anon-key pair, or `null` when either half is missing/blank. */
export function resolveSupabaseAuthConfig(
	source: Record<string, string | undefined> = env
): SupabaseAuthConfig | null {
	const url = SUPABASE_AUTH_URL_VARS.map((name) => source[name]?.trim()).find((v) => !!v) ?? '';
	const anonKey = SUPABASE_ANON_KEY_VARS.map((name) => source[name]?.trim()).find((v) => !!v) ?? '';
	if (!url || !anonKey) return null;
	return { url, anonKey };
}

/** True when a real Supabase project is wired up (drives the dev-auth guard). */
export function isSupabaseAuthConfigured(
	source: Record<string, string | undefined> = env
): boolean {
	return resolveSupabaseAuthConfig(source) !== null;
}

/** Anything with a `cookies` jar and a `url` — i.e. a SvelteKit RequestEvent. */
export type CookieEvent = { cookies: Cookies; url: URL };

/**
 * A server client bound to `event`'s cookies, or `null` when unconfigured.
 *
 * `setAll` is what makes token refresh work in SSR: when Supabase rotates the
 * access token it hands back every cookie it wants written, and we forward them
 * to this request's `Set-Cookie` headers. `path` is explicit because SvelteKit
 * refuses to set a cookie without one, and `secure` follows the request scheme
 * so a cookie minted on http (local dev) is not silently dropped.
 */
export function getSupabaseForEvent(
	event: CookieEvent,
	source: Record<string, string | undefined> = env
): SupabaseClient | null {
	const config = resolveSupabaseAuthConfig(source);
	if (!config) return null;

	return createServerClient(config.url, config.anonKey, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				const secure = event.url.protocol === 'https:';
				for (const { name, value, options } of cookiesToSet) {
					event.cookies.set(name, value, { ...options, path: options.path ?? '/', secure });
				}
			}
		}
	});
}
