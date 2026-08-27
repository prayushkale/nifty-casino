/**
 * Browser client configuration tests — pure, no env vars, no network, no browser.
 *
 * The contract under test: an unconfigured project resolves to `null` (the UI shows a
 * banner) instead of throwing, because auth is optional and game math is not.
 */
import { describe, expect, it } from 'vitest';
import { missingBrowserEnvVars, resolveSupabaseBrowserConfig } from './supabaseBrowser';

describe('supabaseBrowser config', () => {
	it('reads the public url and anon key', () => {
		expect(
			resolveSupabaseBrowserConfig({
				PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
				PUBLIC_SUPABASE_ANON_KEY: 'anon-key'
			})
		).toEqual({ url: 'https://abc.supabase.co', anonKey: 'anon-key' });
	});

	it('resolves to null when unconfigured, so the UI can show a banner instead of crashing', () => {
		expect(resolveSupabaseBrowserConfig({})).toBeNull();
		expect(
			resolveSupabaseBrowserConfig({ PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })
		).toBeNull();
		expect(resolveSupabaseBrowserConfig({ PUBLIC_SUPABASE_ANON_KEY: 'anon-key' })).toBeNull();
	});

	it('treats blank values as missing', () => {
		expect(
			resolveSupabaseBrowserConfig({
				PUBLIC_SUPABASE_URL: ' ',
				PUBLIC_SUPABASE_ANON_KEY: 'anon-key'
			})
		).toBeNull();
	});

	it('names the missing variables for the setup banner', () => {
		expect(missingBrowserEnvVars({})).toEqual(['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY']);
		expect(
			missingBrowserEnvVars({
				PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
				PUBLIC_SUPABASE_ANON_KEY: 'k'
			})
		).toEqual([]);
	});
});
