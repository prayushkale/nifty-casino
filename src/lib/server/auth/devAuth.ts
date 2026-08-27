/**
 * Dev-auth fallback — how the app logs people in when there is no Supabase
 * project (the default on a fresh clone, and the only option on a machine with
 * no Supabase credentials).
 *
 * ⚠ SECURITY — READ BEFORE TOUCHING
 *
 * `POST /api/auth/signup` in dev mode is an **unauthenticated identity-claim
 * endpoint**: whoever sends a handle *becomes* that handle, wallet and all.
 * That is acceptable only because {@link isDevAuthEnabled} gates it on
 * `PUBLIC_SUPABASE_URL` being unset, and the guard is fail-closed both ways:
 *
 *   • Supabase configured → dev auth is dead code, and a stale `nc_dev_uid`
 *     cookie from an earlier dev run is ignored by hooks (./session). A real
 *     deployment therefore cannot be talked into trusting a claimed identity.
 *   • Supabase unconfigured → the cookie is the only session mechanism, and the
 *     wallet lives in RAM (or a Postgres with no auth provider), so nothing of
 *     value is at stake.
 *
 * A half-configured deployment (URL set, anon key missing) keeps dev auth OFF:
 * partial config disables the fallback instead of silently switching modes.
 *
 * Wallet provisioning mirrors `public.handle_new_user()` (migration 0002) row
 * for row, so a dev wallet is indistinguishable from a production one:
 *
 *   profiles(user_id, handle, email, balance = SIGNUP_BONUS)
 *   ledger(kind = 'signup_bonus', amount = +SIGNUP_BONUS, balance_after = SIGNUP_BONUS)
 *   user_stats(user_id, …all zero)
 *
 * all inside ONE `store.tx`. The ledger row is what makes the PLAN §8 gate
 * `sum(ledger) == balance − SIGNUP_BONUS` hold from the very first row.
 */
import { SIGNUP_BONUS } from '$lib/config/app';
import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';
import { DbError, type GameStore, type Profile } from '$lib/server/db';
import { handleCandidates, sanitizeHandle, type Rng } from './handles';

/** Same variable the browser client and supabaseAdmin read. */
export const PUBLIC_SUPABASE_URL_VAR = 'PUBLIC_SUPABASE_URL';

export const DEV_COOKIE_NAME = 'nc_dev_uid';

/** 30 days — long enough that a player is not logged out between sessions. */
export const DEV_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * The guard. True ONLY while `PUBLIC_SUPABASE_URL` is unset or blank.
 * Deliberately a one-liner: every auth route branches on this, so it has to be
 * mechanically obvious rather than clever.
 */
export function isDevAuthEnabled(source: Record<string, string | undefined> = env): boolean {
	return !source[PUBLIC_SUPABASE_URL_VAR]?.trim();
}

/** Cookie props for `event.cookies.set` — httpOnly, lax, 30 days, site-wide. */
export function devCookieOptions(event: { url: URL }): {
	path: string;
	httpOnly: boolean;
	sameSite: 'lax';
	secure: boolean;
	maxAge: number;
} {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// Never mint a Secure cookie over http: browsers drop it and dev login breaks.
		secure: event.url.protocol === 'https:',
		maxAge: DEV_COOKIE_MAX_AGE_S
	};
}

/** The claimed user id from the dev cookie, or `null`. */
export function readDevUserId(cookies: Pick<Cookies, 'get'>): string | null {
	const value = cookies.get(DEV_COOKIE_NAME);
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function setDevSessionCookie(cookies: Cookies, userId: string, url: URL): void {
	cookies.set(DEV_COOKIE_NAME, userId, devCookieOptions({ url }));
}

export function clearDevSessionCookie(cookies: Cookies, url: URL): void {
	cookies.delete(DEV_COOKIE_NAME, { path: devCookieOptions({ url }).path });
}

export type DevProfileResult = {
	profile: Profile;
	/** False when the name already existed → this call was a login, not a signup. */
	created: boolean;
};

export type EnsureDevProfileInput = {
	/** The handle the player asked for. Unusable or absent → a generated one. */
	handle?: unknown;
	/** Stable id for a brand-new profile. Defaults to a fresh uuid. */
	userId?: string;
	/** Only keeps the NOT NULL column happy; email is never shown publicly. */
	email?: string;
};

export type EnsureDevProfileOptions = {
	/** Injected so tests can force handle collisions deterministically. */
	rng?: Rng;
};

/**
 * Log a dev player in, provisioning their wallet on first sight.
 *
 * Dev login is *name-based* on purpose: pass `trader` and you get `trader`'s
 * wallet back, which is what makes multi-user testing on one laptop trivial.
 * A name that already exists logs that player in; a fresh name mints a wallet.
 */
export async function ensureDevProfile(
	store: GameStore,
	input: EnsureDevProfileInput = {},
	options: EnsureDevProfileOptions = {}
): Promise<DevProfileResult> {
	const userId = input.userId ?? crypto.randomUUID();
	// The trigger stores lower(coalesce(new.email, '')) — same normalization here.
	const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
	const desired = sanitizeHandle(input.handle);

	// 1) Name-based login — no password, no email check, by design (see the header).
	if (desired) {
		const existing = await store.profiles.getProfileByHandle(desired);
		if (existing) return { profile: existing, created: false };
	}

	// 2) Idempotent re-provision for a user id that already has a wallet — the
	//    trigger's "already provisioned → return new" early return.
	if (!desired) {
		const byId = await store.profiles.getProfile(userId);
		if (byId) return { profile: byId, created: false };
	}

	// 3) Provision. Same candidate order as the trigger: requested name, then
	//    GENERATED_ATTEMPTS generated ones, then a uuid-derived last resort.
	for (const handle of handleCandidates(desired, userId, options.rng)) {
		try {
			const profile = await store.tx(async (tx) => {
				// Availability is re-checked INSIDE the transaction so two concurrent dev
				// signups cannot both claim a name; the unique index is the final word.
				if ((await tx.profiles.getProfileByHandle(handle)) !== null) {
					throw new DbError(`handle "${handle}" is taken`, 'DUPLICATE_HANDLE');
				}
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
				await tx.stats.applyStatsDelta(userId, {}); // creates the zeroed stats row
				return created;
			});
			return { profile, created: true };
		} catch (err) {
			// Collision → roll this attempt back and try the next name. Any other
			// failure is a bug and must not be swallowed.
			if (err instanceof DbError && err.code === 'DUPLICATE_HANDLE') continue;
			throw err;
		}
	}

	throw new DbError(`no free handle for ${userId} after 6 candidates`, 'NO_FREE_HANDLE');
}
