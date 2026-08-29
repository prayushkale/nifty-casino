/**
 * /u/<handle> — the page's server load.
 *
 * The page itself is chrome; the interesting half is the load function's contract:
 * the same public projection the JSON endpoint serves, and a 404 for a handle
 * nobody owns (or one that could never have existed). `error()` throws, so each
 * case is called through a helper that turns the throw into a value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { istAt } from '$lib/server/cas/test-clock';

const USER = '22222222-2222-4222-8222-222222222222';
const HANDLE = 'priya';
const EMAIL = 'priya@example.com';

type LoadEvent = Parameters<typeof load>[0];

async function call(
	handle: string
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
	try {
		const event = {
			params: { handle },
			url: new URL(`http://localhost:5173/u/${handle}`)
		} as unknown as LoadEvent;
		return { ok: true, data: await load(event) };
	} catch (err: unknown) {
		const httpError = err as { status?: number; body?: { message?: string } };
		return {
			ok: false,
			status: httpError.status ?? 0,
			message: httpError.body?.message ?? ''
		};
	}
}

beforeEach(() => {
	delete process.env.DATABASE_URL;
	resetStoreForTests();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(istAt('2026-08-27', 16, 0, 0)));
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DATABASE_URL;
	resetStoreForTests();
});

describe('/u/[handle] load', () => {
	it('404s for an unknown handle and for one that cannot exist', async () => {
		await getStore().profiles.insertProfile({
			userId: USER,
			handle: HANDLE,
			email: EMAIL,
			balance: 1_000
		});

		await expect(call('nobody')).resolves.toMatchObject({ ok: false, status: 404 });
		await expect(call('Not-A-Handle')).resolves.toMatchObject({ ok: false, status: 404 });
	});

	it('serves the public projection only, matching the JSON endpoint', async () => {
		const store = getStore();
		await store.profiles.insertProfile({
			userId: USER,
			handle: HANDLE,
			email: EMAIL,
			balance: 1_000
		});

		const result = await call(HANDLE);
		expect(result.ok).toBe(true);

		const text = JSON.stringify(result).toLowerCase();
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain(USER.toLowerCase());
		expect(text).not.toContain('email');

		const { profile } = (result as { data: { profile: Record<string, unknown> } }).data;
		expect(Object.keys(profile).sort()).toEqual([
			'balance',
			'handle',
			'joined',
			'rank',
			'recentBets',
			'streakDays',
			'totals',
			'winRate',
			'xp'
		]);
		expect(profile.rank).toBeNull(); // T13 fills the title in, key stays put
		expect(profile.joined).toBe('2026-08-27');
	});
});
