/**
 * Supabase-profile backfill — repairs a wallet the 0002 trigger never created.
 *
 * WHY THIS EXISTS: `resolveIdentity` reads the handle from the app store's
 * `profiles` row, which migration 0002's `handle_new_user` trigger writes at
 * signup. If that trigger never ran (migrations not pushed to the Supabase
 * project, a pre-trigger user, a swallowed trigger warning), the player is
 * authenticated but has no row: `/api/auth/me` answers
 * `{ authenticated: true, handle: null }`, `/api/state` answers `user: null`,
 * and the header keeps showing Log in / Sign up even though login succeeded.
 *
 * The repair point is the login POST (a write path), never the session reader:
 * when a Supabase-authenticated user has no profile row, mint one — same shape
 * as the trigger (profile + signup_bonus ledger + zeroed stats, one tx).
 *
 * ⚠ Unlike `ensureDevProfile`, this NEVER returns another user's row. A
 * requested handle that is taken is skipped like any other collision; the
 * uuid-derived fallback is per-user so it cannot collide.
 */
import { SIGNUP_BONUS } from '$lib/config/app';
import { DbError, type GameStore, type Profile } from '$lib/server/db';
import { handleCandidates, sanitizeHandle, type Rng } from './handles';

export type EnsureSupabaseProfileInput = {
	/** auth.users id — the row owner, never negotiated. */
	userId: string;
	/** Stored lowercased; never shown publicly. */
	email?: string | null;
	/** e.g. `user_metadata.handle` from the signup call. Unusable → generated. */
	requestedHandle?: unknown;
};

export type EnsureSupabaseProfileOptions = {
	/** Injected so tests can force collisions deterministically. */
	rng?: Rng;
};

export type EnsureSupabaseProfileResult = {
	profile: Profile;
	/** False when the row already existed — a plain login, not a repair. */
	created: boolean;
};

export async function ensureSupabaseProfile(
	store: GameStore,
	input: EnsureSupabaseProfileInput,
	options: EnsureSupabaseProfileOptions = {}
): Promise<EnsureSupabaseProfileResult> {
	const { userId } = input;
	const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
	const desired = sanitizeHandle(input.requestedHandle);

	// The common case: the trigger did its job.
	const existing = await store.profiles.getProfile(userId);
	if (existing) return { profile: existing, created: false };

	for (const handle of handleCandidates(desired, userId, options.rng)) {
		try {
			const result = await store.tx(async (tx) => {
				// Re-check INSIDE the transaction so two concurrent logins for fresh
				// users cannot claim the same name; the unique index is final.
				if ((await tx.profiles.getProfileByHandle(handle)) !== null) {
					throw new DbError(`handle "${handle}" is taken`, 'DUPLICATE_HANDLE');
				}
				// Another request may have repaired this same user between our first
				// read and now — reuse that row instead of double-provisioning.
				const raced = await tx.profiles.getProfile(userId);
				if (raced) return { profile: raced, repaired: false };
				const created = await tx.profiles.insertProfile({
					userId,
					handle,
					email,
					balance: SIGNUP_BONUS
				});
				await tx.ledger.appendLedger({
					userId,
					kind: 'signup_bonus',
					amount: SIGNUP_BONUS,
					refBetId: null,
					balanceAfter: SIGNUP_BONUS
				});
				await tx.stats.applyStatsDelta(userId, {});
				return { profile: created, repaired: true };
			});
			return { profile: result.profile, created: result.repaired };
		} catch (err) {
			if (err instanceof DbError && err.code === 'DUPLICATE_HANDLE') continue;
			throw err;
		}
	}

	throw new DbError(`no free handle for ${userId} after 6 candidates`, 'NO_FREE_HANDLE');
}
