/**
 * Identity resolution — the two modes and the seam between them.
 *
 * The Supabase branch is exercised through an injected stand-in client, so the
 * real network client in `getSupabaseForEvent` is never touched (there are no
 * credentials on this machine, and tests must not make network calls).
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MemoryStore, type GameStore } from '$lib/server/db';
import { DEV_COOKIE_NAME } from './devAuth';
import { ANONYMOUS, needsProfileRow, resolveIdentity, type SessionEvent } from './session';

const store = (): GameStore => new MemoryStore();

function fakeEvent(url: string, cookieJar: Record<string, string> = {}) {
	const jar = new Map<string, string>(Object.entries(cookieJar));
	const deleted: string[] = [];
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => {
			deleted.push(name);
			jar.delete(name);
		}
	};
	return {
		event: { url: new URL(url), cookies } as unknown as SessionEvent,
		jar,
		deleted
	};
}

/** Minimal `supabase.auth.getUser()` stand-in. */
function supabaseWith(user: { id: string } | null): SupabaseClient {
	return {
		auth: {
			getUser: async () => ({ data: { user }, error: user ? null : new Error('bad jwt') })
		}
	} as unknown as SupabaseClient;
}

const CONFIGURED = {
	PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
	PUBLIC_SUPABASE_ANON_KEY: 'k'
};

describe('needsProfileRow', () => {
	it('skips the hot paths that can never render a handle', () => {
		expect(needsProfileRow('/api/stream')).toBe(false);
		expect(needsProfileRow('/_app/immutable/entry/app.js')).toBe(false);
		expect(needsProfileRow('/favicon.svg')).toBe(false);
	});

	it('resolves the profile everywhere a handle is displayed', () => {
		expect(needsProfileRow('/')).toBe(true);
		expect(needsProfileRow('/api/auth/me')).toBe(true);
		expect(needsProfileRow('/u/nifty_nikhil')).toBe(true);
	});
});

describe('resolveIdentity — Supabase configured', () => {
	it('uses the profile row for the handle, not the client-supplied metadata', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'u-1', handle: 'nifty_nikhil', email: '' });
		});
		const { event } = fakeEvent('http://localhost:5173/', { [DEV_COOKIE_NAME]: 'stale-dev-id' });

		const identity = await resolveIdentity(event, {
			store: s,
			env: CONFIGURED,
			supabase: supabaseWith({ id: 'u-1' })
		});

		expect(identity).toEqual({ userId: 'u-1', handle: 'nifty_nikhil', source: 'supabase' });
	});

	it('reports a null handle when the profile row is missing (trigger failed)', async () => {
		const { event } = fakeEvent('http://localhost:5173/');
		const identity = await resolveIdentity(event, {
			store: store(),
			env: CONFIGURED,
			supabase: supabaseWith({ id: 'u-unknown' })
		});
		expect(identity).toEqual({ userId: 'u-unknown', handle: null, source: 'supabase' });
	});

	it('shows the signup metadata handle instead of nothing while the row is missing', async () => {
		// A trigger-less user is still authenticated; the header must render who
		// they are rather than falling back to Log in / Sign up.
		const { event } = fakeEvent('http://localhost:5173/');
		const supabase = {
			auth: {
				getUser: async () => ({
					data: {
						user: {
							id: 'u-norow',
							email: 'priya@example.com',
							user_metadata: { handle: 'priya_trades' }
						}
					},
					error: null
				})
			}
		} as unknown as SupabaseClient;
		const identity = await resolveIdentity(event, {
			store: store(),
			env: CONFIGURED,
			supabase
		});
		expect(identity).toEqual({ userId: 'u-norow', handle: 'priya_trades', source: 'supabase' });
	});

	it('stays anonymous when the session is invalid — anonymous is not an error', async () => {
		const { event } = fakeEvent('http://localhost:5173/', { [DEV_COOKIE_NAME]: 'u-1' });
		const identity = await resolveIdentity(event, {
			store: store(),
			env: CONFIGURED,
			supabase: supabaseWith(null)
		});
		expect(identity).toEqual(ANONYMOUS);
	});

	it('ignores a leftover dev cookie: the guard fails closed in both directions', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'u-1', handle: 'nifty_nikhil', email: '' });
		});
		// The dev cookie points at a DIFFERENT user id than the real session, so if
		// the cookie were trusted the two would fight over one identity.
		const { event } = fakeEvent('http://localhost:5173/', { [DEV_COOKIE_NAME]: 'someone-else' });

		const identity = await resolveIdentity(event, {
			store: s,
			env: CONFIGURED,
			supabase: supabaseWith({ id: 'u-1' })
		});
		expect(identity.userId).toBe('u-1');
		expect(identity.source).toBe('supabase');
	});

	it('never consults the store for the hot paths', async () => {
		// A store that throws on read proves the skip prefix is doing the work.
		const hostile = {
			profiles: {
				getProfile: async () => {
					throw new Error('must not be called');
				}
			}
		} as unknown as GameStore;
		const { event } = fakeEvent('https://niftycasino.example/api/stream');
		const identity = await resolveIdentity(event, {
			store: hostile,
			env: CONFIGURED,
			supabase: supabaseWith({ id: 'u-1' })
		});
		expect(identity).toEqual({ userId: 'u-1', handle: null, source: 'supabase' });
	});
});

describe('resolveIdentity — dev fallback (Supabase unconfigured)', () => {
	it('maps the dev cookie onto a profile', async () => {
		const s = store();
		await s.tx(async (t) => {
			await t.profiles.insertProfile({ userId: 'u-1', handle: 'trader0001', email: '' });
		});
		const { event } = fakeEvent('http://localhost:5173/', { [DEV_COOKIE_NAME]: 'u-1' });

		const identity = await resolveIdentity(event, { store: s, env: {} });
		expect(identity).toEqual({ userId: 'u-1', handle: 'trader0001', source: 'dev' });
	});

	it('is anonymous without a cookie', async () => {
		const { event } = fakeEvent('http://localhost:5173/');
		expect(await resolveIdentity(event, { store: store(), env: {} })).toEqual(ANONYMOUS);
	});

	it('forgets a stale cookie pointing at a profile that no longer exists', async () => {
		const s = store();
		const { event, jar, deleted } = fakeEvent('http://localhost:5173/', {
			[DEV_COOKIE_NAME]: 'ghost'
		});

		const identity = await resolveIdentity(event, { store: s, env: {} });
		expect(identity).toEqual(ANONYMOUS);
		expect(jar.has(DEV_COOKIE_NAME)).toBe(false);
		expect(deleted).toContain(DEV_COOKIE_NAME);
	});
});
