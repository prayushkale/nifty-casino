/**
 * The complete server env bag — PUBLIC_* plus everything else.
 *
 * SvelteKit splits env into two modules: `$env/dynamic/public` (vars starting
 * with `PUBLIC_` and nothing else — the only names allowed to reach the browser)
 * and `$env/dynamic/private` (every other var, with `PUBLIC_*` names deliberately
 * filtered OUT by the prefix rule). Server code that needs a `PUBLIC_*` name —
 * the auth modules read `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` —
 * therefore cannot rely on `$env/dynamic/private` alone: it always looks
 * unconfigured, the dev-auth guard never closes, and every auth API answers
 * `AUTH_NOT_CONFIGURED` even when `.env` is complete.
 *
 * Merging both halves reconstructs the full bag the process actually received.
 * The halves are disjoint by construction (prefix partition), so spread order
 * is irrelevant.
 */
import { env as publicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';

export const serverEnv: Record<string, string | undefined> = { ...publicEnv, ...privateEnv };