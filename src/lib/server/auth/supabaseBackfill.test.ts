/**
 * Supabase-profile backfill — the login-time wallet repair.
 *
 * The case under test: a Supabase-authenticated user with NO `profiles` row
 * (the 0002 trigger never ran). Before the fix this logged in to
 * `{ authenticated: true, handle: null }` and an empty header; after the fix
 * the login path mints the row and the header renders.
 */
import { describe, expect, it } from 'vitest';
import { SIGNUP_BONUS } from '$lib/config/app';
import { MemoryStore, type GameStore } from '$lib/server/db';
import { fallbackHandle } from './handles';
import { ensureSupabaseProfile } from './supabaseBackfill';
import { fallbackDisplayHandle } from './session';

const store = (): GameStore => new MemoryStore();

describe('ensureSupabaseProfile', () => {
	it('returns the existing row untouched — a plain login, not a repair', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({
				userId: 'u-1',
				handle: 'nifty_nikhil',
				email: 'nikhil@example.com',
				balance: 1234
			});
		});

		const result = await ensureSupabaseProfile(s, {
			userId: 'u-1',
			email: 'nikhil@example.com',
			requestedHandle: 'something_else'
		});

		expect(result.created).toBe(false);
		expect(result.profile.handle).toBe('nifty_nikhil');
		expect(result.profile.balance).toBe(1234); // untouched, no second bonus
		expect(await s.ledger.getLedgerForUser('u-1')).toHaveLength(0);
	});

	it('mints profile + bonus ledger + zeroed stats for a trigger-less user', async () => {
		const s = store();

		const result = await ensureSupabaseProfile(s, {
			userId: 'auth-uuid-1',
			email: 'Priya@Example.com',
			requestedHandle: 'priya_trades'
		});

		expect(result.created).toBe(true);
		expect(result.profile.handle).toBe('priya_trades');
		expect(result.profile.balance).toBe(SIGNUP_BONUS);
		expect(result.profile.email).toBe('priya@example.com');

		const ledger = await s.ledger.getLedgerForUser('auth-uuid-1');
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.kind).toBe('signup_bonus');
		expect(ledger[0]?.amount).toBe(SIGNUP_BONUS);
	});

	it('never hands back another player’s row when the requested handle is taken', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'owner', handle: 'taken_name', email: '' });
		});

		// A name-based lookup (dev auth) would return the OWNER here — the
		// backfill must instead provision a fresh wallet for the new user id.
		const result = await ensureSupabaseProfile(
			s,
			{ userId: 'new-user', requestedHandle: 'taken_name' },
			{ rng: () => 0.25 }
		);

		expect(result.created).toBe(true);
		expect(result.profile.userId).toBe('new-user');
		expect(result.profile.handle).toBe('trader2500');
		expect(result.profile.balance).toBe(SIGNUP_BONUS);
		// The owner's row is untouched.
		expect((await s.profiles.getProfile('owner'))?.handle).toBe('taken_name');
	});

	it('falls back to the uuid-derived handle when everything generated is taken', async () => {
		const s = store();
		const userId = 'repair-me';
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'other', handle: 'trader5000', email: '' });
		});

		const { profile, created } = await ensureSupabaseProfile(s, { userId }, { rng: () => 0.5 });

		expect(created).toBe(true);
		expect(profile.handle).toBe(fallbackHandle(userId));
		expect(await s.ledger.getLedgerForUser(userId)).toHaveLength(1);
	});
});

describe('fallbackDisplayHandle', () => {
	it('prefers the signup metadata handle', () => {
		expect(
			fallbackDisplayHandle({ user_metadata: { handle: 'Priya_Trades' }, email: 'p@x.com' })
		).toBe('priya_trades');
	});

	it('falls back to the email local part when metadata has no handle', () => {
		expect(fallbackDisplayHandle({ user_metadata: {}, email: 'Priya99@x.com' })).toBe('priya99');
	});

	it('is null when nothing usable exists — anonymous stays anonymous', () => {
		expect(fallbackDisplayHandle({})).toBeNull();
		expect(fallbackDisplayHandle({ email: 'ab@x.com' })).toBeNull(); // too short
	});
});
