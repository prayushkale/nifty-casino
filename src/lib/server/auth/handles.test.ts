/**
 * Handle rules — pure tests, no store. The shapes asserted here are the same
 * ones supabase/migrations/0002_handle_new_user.sql enforces, so a handle that
 * passes in JS passes in Postgres and vice versa.
 */
import { describe, expect, it } from 'vitest';
import {
	fallbackHandle,
	generateHandle,
	GENERATED_ATTEMPTS,
	handleCandidates,
	HANDLE_PATTERN,
	sanitizeHandle,
	type Rng
} from './handles';

const always =
	(value: number): Rng =>
	() =>
		value;
const UUID = 'abcdef01-2345-6789-abcd-ef0123456789';

describe('sanitizeHandle', () => {
	it('accepts the shape 0002 stores: ^[a-z0-9_]{3,20}$', () => {
		expect(sanitizeHandle('nifty_nikhil')).toBe('nifty_nikhil');
		expect(sanitizeHandle('abc')).toBe('abc');
		expect(sanitizeHandle('a'.repeat(20))).toBe('a'.repeat(20));
		expect(sanitizeHandle('trader1234')).toBe('trader1234');
	});

	it('normalizes case and surrounding whitespace, like lower(btrim(raw))', () => {
		expect(sanitizeHandle('  Trader_One  ')).toBe('trader_one');
		expect(sanitizeHandle('BIG_BETTOR')).toBe('big_bettor');
	});

	it('rejects junk instead of storing it in a public URL', () => {
		expect(sanitizeHandle('ab')).toBeNull(); // too short
		expect(sanitizeHandle('a'.repeat(21))).toBeNull(); // too long
		expect(sanitizeHandle('has space')).toBeNull();
		expect(sanitizeHandle('no-hyphens')).toBeNull();
		expect(sanitizeHandle('no!exclaim')).toBeNull();
		expect(sanitizeHandle('trädare')).toBeNull(); // non-ascii
		expect(sanitizeHandle('')).toBeNull();
	});

	it('rejects non-strings outright (JSON bodies are untrusted)', () => {
		expect(sanitizeHandle(undefined)).toBeNull();
		expect(sanitizeHandle(null)).toBeNull();
		expect(sanitizeHandle(42)).toBeNull();
		expect(sanitizeHandle({ handle: 'nifty' })).toBeNull();
		expect(sanitizeHandle(['a', 'b'])).toBeNull();
	});

	it('never returns something HANDLE_PATTERN would reject', () => {
		for (const raw of ['abc', 'trader0000', 'x'.repeat(20), 'Bad Handle', 'nope', 12, null]) {
			const handle = sanitizeHandle(raw);
			if (handle !== null) expect(handle).toMatch(HANDLE_PATTERN);
		}
	});
});

describe('generateHandle', () => {
	it('produces trader + 4 zero-padded digits for any rng', () => {
		for (const value of [0, 0.0001, 0.5, 0.9999, 1, Number.NaN]) {
			expect(generateHandle(always(value))).toMatch(/^trader\d{4}$/);
		}
	});

	it('maps the rng range onto 0000-9999', () => {
		expect(generateHandle(always(0))).toBe('trader0000');
		expect(generateHandle(always(0.4999))).toBe('trader4999');
		expect(generateHandle(always(0.99999))).toBe('trader9999');
		expect(generateHandle(always(1))).toBe('trader9999'); // clamped, never 10000
		expect(generateHandle(always(Number.NaN))).toBe('trader0000'); // degenerate rng
	});

	it('is deterministic under an injected rng (that is how tests force collisions)', () => {
		expect(generateHandle(always(0.1234))).toBe(generateHandle(always(0.1234)));
	});
});

describe('fallbackHandle', () => {
	it('derives 10 chars from the user id, like left(md5(new.id), 10)', () => {
		expect(fallbackHandle('11111111-2222-3333-4444-555555555555')).toBe('trader_1111111122');
		expect(fallbackHandle('11111111-2222-3333-4444-555555555555')).toMatch(/^trader_[0-9a-f]{10}$/);
	});

	it('is stable per user and different across users', () => {
		const a = fallbackHandle('aaaaaaaa-0000-0000-0000-000000000000');
		const b = fallbackHandle('bbbbbbbb-0000-0000-0000-000000000000');
		expect(a).toBe(fallbackHandle('aaaaaaaa-0000-0000-0000-000000000000'));
		expect(a).not.toBe(b);
	});
});

describe('handleCandidates — the collision-retry ladder', () => {
	it('tries the requested handle first, then generated names, then the fallback', () => {
		const candidates = handleCandidates('requested_handle', UUID, always(0.5));
		expect(candidates[0]).toBe('requested_handle');
		expect(candidates.slice(1, 1 + GENERATED_ATTEMPTS)).toEqual([
			'trader5000',
			'trader5000',
			'trader5000',
			'trader5000'
		]);
		expect(candidates.at(-1)).toBe(fallbackHandle(UUID));
		// Six attempts, exactly as the 0002 trigger loops.
		expect(candidates).toHaveLength(1 + GENERATED_ATTEMPTS + 1);
	});

	it('drops the requested slot when the player did not ask for a name', () => {
		const candidates = handleCandidates(null, UUID, always(0));
		expect(candidates).toHaveLength(GENERATED_ATTEMPTS + 1);
		expect(candidates.at(-1)).toBe(fallbackHandle(UUID));
	});

	it('always ends with a handle the store will accept, even with a broken rng', () => {
		const candidates = handleCandidates(null, UUID, always(Number.NaN));
		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates.at(-1)).toMatch(HANDLE_PATTERN);
	});
});
