/**
 * Handle rules — the single source of truth for the public identity (PLAN T6).
 *
 * A handle is the *public* name: it lands in `/u/<handle>` URLs and on the
 * leaderboard, so it is deliberately constrained to a boring, lowercase,
 * URL-safe shape. The rules are identical to the SQL side
 * (`public.sanitize_nc_handle` in supabase/migrations/0002_handle_new_user.sql):
 *
 *     lower(btrim(raw)) ~ '^[a-z0-9_]{3,20}$'
 *
 * Keep the two in sync — this file sanitizes the handle the user *asked* for at
 * the HTTP boundary, the trigger sanitizes it again at the database boundary.
 */

/** The shape a stored handle must have. Lowercase by construction. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

/** Human-readable rule, for form errors. */
export const HANDLE_RULE = '3-20 characters: lowercase letters, digits and underscores.';

/** Generated handles look like `trader0042` — the shape 0002 produces. */
export const GENERATED_HANDLE_PATTERN = /^trader\d{4}$/;

/** Injectable source of randomness, so tests can force collisions deterministically. */
export type Rng = () => number;

/**
 * Sanitize a raw, untrusted handle exactly like the SQL function does:
 * trim, lowercase, then require the pattern. Returns `null` for anything
 * unusable so the caller falls through to a generated handle.
 */
export function sanitizeHandle(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const handle = raw.trim().toLowerCase();
	return HANDLE_PATTERN.test(handle) ? handle : null;
}

/**
 * `trader` + 4 zero-padded random digits — the same generator as 0002's
 * `lpad((floor(random() * 10000))::int::text, 4, '0')`. 10,000 names is not
 * unique by construction, which is why callers retry on collision.
 */
export function generateHandle(rng: Rng = Math.random): string {
	const raw = Math.floor(rng() * 10_000);
	// Clamped and NaN-guarded so even a degenerate injected rng can never produce a
	// fifth digit: the `^trader\d{4}$` shape is part of the contract.
	const n = Number.isFinite(raw) ? Math.min(9999, Math.max(0, raw)) : 0;
	return `trader${String(n).padStart(4, '0')}`;
}

/**
 * Deterministic last resort: derived from the user id itself, so it is unique
 * per user and can never collide with another user's fallback. Mirrors 0002's
 * `'trader_' || left(md5(new.id::text), 10)` — both are 10 hex chars derived
 * from the uuid, so both have the same shape and the same collision-freeness.
 */
export function fallbackHandle(userId: string): string {
	const hex = userId.replace(/-/g, '').toLowerCase();
	return `trader_${(hex || '0000000000').slice(0, 10).padEnd(10, '0')}`;
}

/** How many *generated* names to try after the requested one (0002 tries 4). */
export const GENERATED_ATTEMPTS = 4;

/**
 * The candidate sequence, in 0002's order: the requested handle (if it passed
 * sanitization), 4 generated names, then the uuid-derived fallback. Never empty,
 * so a signup only fails to get a name if all six are somehow taken.
 *
 * Callers walk this list and retry on a duplicate-handle failure — see
 * `ensureDevProfile` and the trigger's `unique_violation` handler.
 */
export function handleCandidates(
	desired: string | null,
	userId: string,
	rng: Rng = Math.random
): string[] {
	const candidates = desired ? [desired] : [];
	for (let i = 0; i < GENERATED_ATTEMPTS; i += 1) candidates.push(generateHandle(rng));
	candidates.push(fallbackHandle(userId));
	return candidates;
}
