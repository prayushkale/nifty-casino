/**
 * The signup request validator — pure tests for the field errors the form
 * renders. No store, no Supabase, no network.
 */
import { describe, expect, it } from 'vitest';
import { readEmail, readHandle, readPasswordError, readTos, validateSignupRequest } from './signup';

const VALID = {
	email: 'Player@Example.com ',
	password: 'longenough',
	handle: '  Nifty_Nikhil ',
	tos: true
};

describe('validateSignupRequest — happy path', () => {
	it('accepts and normalizes a valid body', () => {
		const result = validateSignupRequest(VALID);
		expect(result).toEqual({
			ok: true,
			value: { email: 'player@example.com', password: 'longenough', handle: 'nifty_nikhil' }
		});
	});

	it('treats a skipped handle as "assign one" (no error, handle null)', () => {
		for (const handle of [undefined, null, '', '   ']) {
			const result = validateSignupRequest({ ...VALID, handle });
			expect(result).toEqual({
				ok: true,
				value: { email: 'player@example.com', password: 'longenough', handle: null }
			});
		}
	});

	it('reports every bad field at once, not just the first', () => {
		const result = validateSignupRequest({ email: 'nope', password: 'short', tos: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.fieldErrors).sort()).toEqual(['email', 'password', 'tos']);
	});
});

describe('validateSignupRequest — email', () => {
	it('rejects missing, wrong-type and malformed addresses', () => {
		for (const email of [undefined, null, 42, '', '   ', 'player', 'player@example', 'a b@c.com']) {
			const result = validateSignupRequest({ ...VALID, email });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.fieldErrors.email).toBeTruthy();
		}
	});

	it('readEmail is the single email gate', () => {
		expect(readEmail('A@B.co')).toBe('a@b.co');
		expect(readEmail('not-an-email')).toBeNull();
		expect(readEmail(null)).toBeNull();
	});
});

describe('validateSignupRequest — password', () => {
	it('requires at least 8 characters', () => {
		expect(readPasswordError('1234567')).toMatch(/at least 8/);
		expect(readPasswordError('12345678')).toBeNull();
		expect(readPasswordError(undefined)).toBeTruthy();
		expect(readPasswordError(12345678)).toBeTruthy(); // numbers are not passwords
	});
});

describe('validateSignupRequest — terms of service', () => {
	it('demands a real boolean true', () => {
		for (const tos of [undefined, null, false, 'true', 1, 'yes']) {
			const result = validateSignupRequest({ ...VALID, tos });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.fieldErrors.tos).toBeTruthy();
		}
		expect(readTos('true')).toBe(false); // a JSON string is not consent
	});
});

describe('validateSignupRequest — handle', () => {
	it('rejects a present-but-unusable handle with a field error', () => {
		for (const handle of ['ab', 'has space', 'no-dashes', 'x'.repeat(21), 42, {}]) {
			const result = validateSignupRequest({ ...VALID, handle });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.fieldErrors.handle).toBeTruthy();
		}
	});

	it('readHandle separates "skipped" from "invalid"', () => {
		expect(readHandle('')).toEqual({ handle: null });
		expect(readHandle('   ')).toEqual({ handle: null });
		expect(readHandle(undefined)).toEqual({ handle: null });
		expect(readHandle('Nifty_One')).toEqual({ handle: 'nifty_one' });
		expect(readHandle('nope nope')).toHaveProperty('error');
	});
});

describe('validateSignupRequest — garbage bodies', () => {
	it('does not throw on non-object bodies', () => {
		for (const body of [undefined, null, 42, 'string', [], true]) {
			const result = validateSignupRequest(body);
			expect(result.ok).toBe(false);
		}
	});
});
