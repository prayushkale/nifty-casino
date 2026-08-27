/**
 * Dev-auth fallback — the guard, the wallet math against the real memory store,
 * and the cookie helpers. No network, no Supabase.
 */
import { describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { MemoryStore, type GameStore } from '$lib/server/db';
import { SIGNUP_BONUS } from '$lib/config/app';
import { fallbackHandle } from './handles';
import {
	clearDevSessionCookie,
	DEV_COOKIE_MAX_AGE_S,
	DEV_COOKIE_NAME,
	devCookieOptions,
	ensureDevProfile,
	isDevAuthEnabled,
	readDevUserId,
	setDevSessionCookie
} from './devAuth';

const store = (): GameStore => new MemoryStore({ now: () => 1_700_000_000_000 });

/** In-memory stand-in for SvelteKit's `Cookies`, recording every write. */
function fakeCookies(initial: Record<string, string> = {}) {
	const jar = new Map<string, string>(Object.entries(initial));
	const writes: { name: string; value: string; props: Record<string, unknown> }[] = [];
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string, props: Record<string, unknown>) => {
			writes.push({ name, value, props });
			jar.set(name, value);
		},
		delete: (name: string, props: Record<string, unknown>) => {
			void props;
			jar.delete(name);
		}
	};
	return { jar, writes, cookies: cookies as unknown as Cookies };
}

describe('isDevAuthEnabled — the guard', () => {
	it('is ON only when PUBLIC_SUPABASE_URL is absent', () => {
		expect(isDevAuthEnabled({})).toBe(true);
	});

	it('treats a blank value as absent', () => {
		expect(isDevAuthEnabled({ PUBLIC_SUPABASE_URL: '' })).toBe(true);
		expect(isDevAuthEnabled({ PUBLIC_SUPABASE_URL: '   ' })).toBe(true);
	});

	it('is OFF the moment Supabase is configured', () => {
		expect(isDevAuthEnabled({ PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toBe(false);
		// URL set but anon key missing ⇒ auth is unusable, yet the fallback stays ON.
		// That is the documented risk of a half-configured deploy, and it is why the
		// README checklist asks you to set both PUBLIC_ vars together: the guard is a
		// single-variable check on purpose, so it can be reasoned about at a glance.
		expect(isDevAuthEnabled({ SUPABASE_URL: 'https://abc.supabase.co' })).toBe(true);
	});
});

describe('ensureDevProfile — 0002 trigger parity', () => {
	it('provisions profile + signup ledger row + zeroed stats in one shot', async () => {
		const s = store();
		const { profile, created } = await ensureDevProfile(s, {
			handle: 'Nifty_Nikhil',
			userId: 'u-1',
			email: 'Player@Example.com'
		});

		expect(created).toBe(true);
		expect(profile).toMatchObject({
			userId: 'u-1',
			handle: 'nifty_nikhil',
			email: 'player@example.com',
			balance: SIGNUP_BONUS,
			xp: 0,
			streakDays: 0,
			lastBetDate: null
		});

		// The ledger row is what makes sum(ledger) == balance - SIGNUP_BONUS hold.
		const ledger = await s.ledger.getLedgerForUser('u-1');
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			kind: 'signup_bonus',
			amount: SIGNUP_BONUS,
			refBetId: null,
			balanceAfter: SIGNUP_BONUS
		});

		const stats = await s.stats.getUserStats('u-1');
		expect(stats).toMatchObject({
			userId: 'u-1',
			betsPlaced: 0,
			betsWon: 0,
			totalStaked: 0,
			totalWon: 0,
			bestPayout: 0
		});
	});

	it('is idempotent per handle: a second call logs in, and never double-pays the bonus', async () => {
		const s = store();
		const first = await ensureDevProfile(s, { handle: 'trader', userId: 'u-1' });
		const second = await ensureDevProfile(s, { handle: 'trader', userId: 'u-2' });

		expect(second.created).toBe(false);
		expect(second.profile.userId).toBe(first.profile.userId);
		expect(await s.ledger.getLedgerForUser('u-1')).toHaveLength(1);
		expect(await s.profiles.getProfile('u-2')).toBeNull();
	});

	it('logs an existing player in even when the handle was made outside dev auth', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({
				userId: 'seeded',
				handle: 'seeded_player',
				email: 'seeded@example.com',
				balance: 5
			});
			await t.ledger.appendLedger({
				userId: 'seeded',
				kind: 'signup_bonus',
				amount: 5,
				balanceAfter: 5
			});
		});

		const result = await ensureDevProfile(s, { handle: 'Seeded_Player' });
		expect(result.created).toBe(false);
		expect(result.profile.userId).toBe('seeded');
		expect(result.profile.email).toBe('seeded@example.com'); // untouched
		expect(result.profile.balance).toBe(5); // untouched
		expect(await s.ledger.getLedgerForUser('seeded')).toHaveLength(1); // no second bonus
	});

	it('generates a handle when the player skipped it', async () => {
		const s = store();
		const { profile } = await ensureDevProfile(s, { userId: 'u-1' }, { rng: () => 0.4321 });
		expect(profile.handle).toBe('trader4321');
	});

	it('generates a handle when the requested one is unusable', async () => {
		const s = store();
		const { profile } = await ensureDevProfile(
			s,
			{ handle: 'not a handle!', userId: 'u-1' },
			{ rng: () => 0.25 }
		);
		expect(profile.handle).toBe('trader2500');
	});

	it('falls back to the uuid-derived handle and keeps its wallet intact on collision', async () => {
		const s = store();
		// rng pinned to exactly 0.5 → every generated attempt is 'trader5000', which
		// is taken. Four attempts must roll back and the uuid fallback must win.
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'other', handle: 'trader5000', email: '' });
		});

		const { profile, created } = await ensureDevProfile(
			s,
			{ userId: 'u-collision' },
			{ rng: () => 0.5 }
		);

		expect(created).toBe(true);
		expect(profile.handle).toBe(fallbackHandle('u-collision'));
		expect(profile.balance).toBe(SIGNUP_BONUS);
		// The rolled-back attempts must have left no partial write behind.
		expect(await s.ledger.getLedgerForUser('u-collision')).toHaveLength(1);
		expect((await s.profiles.getProfile('u-collision'))?.handle).toBe(
			fallbackHandle('u-collision')
		);
	});

	it('never claims an existing handle during generation', async () => {
		const s = store();
		const taken = await ensureDevProfile(s, { handle: 'real_owner', userId: 'owner' });
		const { profile, created } = await ensureDevProfile(
			s,
			{ userId: 'newcomer' },
			{ rng: () => 0.25 }
		);
		expect(created).toBe(true);
		expect(profile.handle).not.toBe(taken.profile.handle);
		expect(profile.handle).toBe('trader2500');
		expect(profile.balance).toBe(SIGNUP_BONUS);
	});

	it('throws a typed error when all six candidates are taken', async () => {
		const s = store();
		const userId = 'u-exhausted';
		await s.tx(async (t) => {
			// Every generated name (rng pinned) and the uuid fallback are gone.
			await t.profiles.insertProfile({ userId: 'a', handle: 'trader5000', email: '' });
			await t.profiles.insertProfile({ userId: 'b', handle: fallbackHandle(userId), email: '' });
		});

		await expect(ensureDevProfile(s, { userId }, { rng: () => 0.5 })).rejects.toMatchObject({
			code: 'NO_FREE_HANDLE'
		});
		expect(await s.ledger.getLedgerForUser(userId)).toHaveLength(0);
	});

	it('stores an empty email when none was given (the column is NOT NULL)', async () => {
		const s = store();
		const { profile } = await ensureDevProfile(s, { handle: 'no_email', userId: 'u-1' });
		expect(profile.email).toBe('');
	});
});

describe('dev session cookie', () => {
	const http = new URL('http://localhost:5173/auth/login');
	const https = new URL('https://niftycasino.example/auth/login');

	it('is httpOnly, lax, site-wide, 30 days, and Secure only over https', () => {
		expect(devCookieOptions({ url: http })).toEqual({
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: false,
			maxAge: DEV_COOKIE_MAX_AGE_S
		});
		expect(devCookieOptions({ url: https }).secure).toBe(true);
	});

	it('sets the claimed user id under nc_dev_uid', () => {
		const { cookies, writes } = fakeCookies();
		setDevSessionCookie(cookies, 'u-1', http);

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ name: DEV_COOKIE_NAME, value: 'u-1', props: { path: '/' } });
		expect(readDevUserId(cookies)).toBe('u-1');
	});

	it('reads nothing back from a missing or blank cookie', () => {
		expect(readDevUserId(fakeCookies().cookies)).toBeNull();
		expect(readDevUserId(fakeCookies({ [DEV_COOKIE_NAME]: '' }).cookies)).toBeNull();
	});

	it('clears the session on logout', () => {
		const { cookies, jar } = fakeCookies({ [DEV_COOKIE_NAME]: 'u-1' });
		clearDevSessionCookie(cookies, http);
		expect(jar.has(DEV_COOKIE_NAME)).toBe(false);
		expect(readDevUserId(cookies)).toBeNull();
	});
});
