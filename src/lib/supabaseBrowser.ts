/**
 * Supabase browser client — the anon-key side of auth (T6 uses it for the OTP flows).
 *
 * LOCATION: `$lib/supabaseBrowser.ts`, NOT `$lib/server/`. SvelteKit makes `$lib/server`
 * un-importable from client code, and this is the one client that UI components have to
 * import (the auth banner, the OTP forms). Its sibling `src/lib/server/supabaseAdmin.ts`
 * is the one that must stay server-only.
 *
 * Returns `null` when the project is not configured instead of throwing: the UI is
 * expected to render an "auth not configured" banner and keep the rest of the game
 * working, because the game itself does not need Supabase (see lib/server/db/index). A
 * throw here would take down every page load in a fresh clone, which is the one outcome
 * we never want from optional config.
 *
 * The anon key is public by design — it is what RLS is for. It can read only the rows
 * the policies in supabase/migrations/0001_init.sql allow, and it can never write
 * money state (no insert/update policies exist for clients at all).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

export const PUBLIC_SUPABASE_URL_VAR = 'PUBLIC_SUPABASE_URL';
export const PUBLIC_SUPABASE_ANON_KEY_VAR = 'PUBLIC_SUPABASE_ANON_KEY';
export const ALL_BROWSER_ENV_VARS: readonly string[] = [
	PUBLIC_SUPABASE_URL_VAR,
	PUBLIC_SUPABASE_ANON_KEY_VAR
];

export type SupabaseBrowserConfig = { url: string; anonKey: string };

/** Null when unconfigured OR when running on the server (a browser client is useless there). */
export function resolveSupabaseBrowserConfig(
	source: Record<string, string | undefined> = env
): SupabaseBrowserConfig | null {
	const url = source[PUBLIC_SUPABASE_URL_VAR]?.trim() ?? '';
	const anonKey = source[PUBLIC_SUPABASE_ANON_KEY_VAR]?.trim() ?? '';
	if (!url || !anonKey) return null;
	return { url, anonKey };
}

export function missingBrowserEnvVars(source: Record<string, string | undefined> = env): string[] {
	return ALL_BROWSER_ENV_VARS.filter((name) => !source[name]?.trim());
}

/**
 * The browser client, or null. Components do:
 *   const supabase = getSupabaseBrowser();
 *   {#if !supabase} <AuthNotConfiguredBanner /> {/if}
 */
export function getSupabaseBrowser(): SupabaseClient | null {
	if (!browser) return null;
	const config = resolveSupabaseBrowserConfig();
	if (!config) return null;
	return createClient(config.url, config.anonKey, {
		auth: {
			// Email OTP links land on /auth/confirm with the token in the URL hash.
			detectSessionInUrl: true,
			persistSession: true,
			autoRefreshToken: true,
			flowType: 'pkce'
		}
	});
}
