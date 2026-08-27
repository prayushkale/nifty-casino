/**
 * Supabase service-role client — SERVER ONLY.
 *
 * Scope is deliberately narrow (PLAN T5/T6): auth administration only — creating
 * users, generating verification links, deleting accounts, listing emails. It is NOT
 * the data layer. Money and game state go through ../db (raw SQL over DATABASE_URL)
 * because bets need `SELECT … FOR UPDATE`, which PostgREST cannot express.
 *
 * This key bypasses Row Level Security entirely. It must never reach a browser: keep
 * it out of `$lib` modules imported by components, out of `PUBLIC_*` vars, and out of
 * anything serialized into a load response. It lives in `$lib/server`, which SvelteKit
 * refuses to let client code import.
 *
 * Lazy singleton: nothing connects at import time, so importing this module is free
 * and a misconfigured deploy fails at the call site with a name-the-variable error
 * rather than anywhere subtler.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

/** `SUPABASE_URL` is the canonical name; `PUBLIC_SUPABASE_URL` is the same value. */
export const SUPABASE_URL_VARS = ['SUPABASE_URL', 'PUBLIC_SUPABASE_URL'] as const;
export const SUPABASE_SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

export type SupabaseAdminConfig = { url: string; serviceRoleKey: string };

/** True when every admin var is present and non-blank (used for a dev-time banner). */
export function isSupabaseAdminConfigured(
	source: Record<string, string | undefined> = env
): boolean {
	return resolveSupabaseAdminConfig(source) !== null;
}

/**
 * Read the admin config out of an env bag, or null when it is incomplete.
 * Returns the MISSING NAMES (not just "not configured") so the thrown error can tell
 * the operator exactly what to paste into `.env`.
 */
export function resolveSupabaseAdminConfig(
	source: Record<string, string | undefined> = env
): SupabaseAdminConfig | null {
	const url = SUPABASE_URL_VARS.map((name) => source[name]?.trim()).find((v) => !!v) ?? '';
	const serviceRoleKey = source[SUPABASE_SERVICE_ROLE_KEY_VAR]?.trim() ?? '';
	if (!url || !serviceRoleKey) return null;
	return { url, serviceRoleKey };
}

/** The names that are absent from `source` — drives the thrown error and the README. */
export function missingAdminEnvVars(source: Record<string, string | undefined> = env): string[] {
	const missing: string[] = [];
	if (!SUPABASE_URL_VARS.some((name) => !!source[name]?.trim())) {
		missing.push(`${SUPABASE_URL_VARS[0]} (or ${SUPABASE_URL_VARS[1]})`);
	}
	if (!source[SUPABASE_SERVICE_ROLE_KEY_VAR]?.trim()) missing.push(SUPABASE_SERVICE_ROLE_KEY_VAR);
	return missing;
}

function configError(source: Record<string, string | undefined>): Error {
	return new Error(
		[
			'Supabase admin client is not configured — cannot call auth admin APIs.',
			`Missing environment variable(s): ${missingAdminEnvVars(source).join(', ')}.`,
			'Fix: copy .env.example to .env, create a Supabase project, and paste the project URL',
			'plus the service_role key (Project Settings → API). See README → "Supabase setup".',
			'Setup is optional for local dev: without it the game runs on the in-memory store,',
			'and only the auth flows are unavailable.'
		].join('\n  ')
	);
}

let cached: SupabaseClient | null = null;

/**
 * The service-role client. Throws a descriptive error when unconfigured — callers
 * (auth routes, signup webhook) are expected to surface it as a 503, not a crash.
 */
export function getSupabaseAdmin(): SupabaseClient {
	if (cached) return cached;
	const config = resolveSupabaseAdminConfig();
	if (!config) throw configError(env);
	cached = createClient(config.url, config.serviceRoleKey, {
		auth: {
			// Server-side: no storage, no session persistence, no auto-refresh — every call
			// is an admin API request with the service role key already attached.
			persistSession: false,
			autoRefreshToken: false,
			detectSessionInUrl: false
		}
	});
	return cached;
}

/** Test/teardown hook — drops the cached client so the next call re-reads env. */
export function resetSupabaseAdminForTests(): void {
	cached = null;
}
