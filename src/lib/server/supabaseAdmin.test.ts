/**
 * Service-role client configuration tests — pure, no env vars, no network.
 *
 * The point: an operator who forgets a key gets an error naming the exact variable,
 * and a half-configured project (URL but no key) is reported as unconfigured rather
 * than blowing up later on a create-user call.
 */
import { describe, expect, it } from 'vitest';
import {
	isSupabaseAdminConfigured,
	missingAdminEnvVars,
	resolveSupabaseAdminConfig
} from './supabaseAdmin';

const COMPLETE = {
	SUPABASE_URL: 'https://abc.supabase.co',
	SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
};

describe('supabaseAdmin config', () => {
	it('reads the url and the service role key when both are present', () => {
		expect(resolveSupabaseAdminConfig(COMPLETE)).toEqual({
			url: 'https://abc.supabase.co',
			serviceRoleKey: 'service-role-key'
		});
		expect(isSupabaseAdminConfigured(COMPLETE)).toBe(true);
		expect(missingAdminEnvVars(COMPLETE)).toEqual([]);
	});

	it('accepts PUBLIC_SUPABASE_URL as the url (same project, public value)', () => {
		expect(
			resolveSupabaseAdminConfig({
				PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
				SUPABASE_SERVICE_ROLE_KEY: 'k'
			})
		).toEqual({ url: 'https://abc.supabase.co', serviceRoleKey: 'k' });
	});

	it('reports the missing names rather than a generic failure', () => {
		expect(missingAdminEnvVars({})).toEqual([
			'SUPABASE_URL (or PUBLIC_SUPABASE_URL)',
			'SUPABASE_SERVICE_ROLE_KEY'
		]);
		expect(missingAdminEnvVars({ SUPABASE_URL: 'https://abc.supabase.co' })).toEqual([
			'SUPABASE_SERVICE_ROLE_KEY'
		]);
	});

	it('treats an incomplete setup as unconfigured (URL without the key is not enough)', () => {
		expect(resolveSupabaseAdminConfig({ SUPABASE_URL: 'https://abc.supabase.co' })).toBeNull();
		expect(resolveSupabaseAdminConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBeNull();
		expect(isSupabaseAdminConfigured({})).toBe(false);
	});

	it('ignores blank values, which is what an uncommented-but-empty .env line produces', () => {
		expect(
			resolveSupabaseAdminConfig({ SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: 'k' })
		).toBeNull();
		expect(
			resolveSupabaseAdminConfig({
				SUPABASE_URL: 'https://abc.supabase.co',
				SUPABASE_SERVICE_ROLE_KEY: ''
			})
		).toBeNull();
	});
});
