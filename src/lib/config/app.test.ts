import { describe, expect, it } from 'vitest';
import { CUTOFF_HMS, SIGNUP_BONUS } from './app';

describe('app config sanity', () => {
	it('cutoff is 15:20 IST', () => {
		expect(CUTOFF_HMS).toEqual({ h: 15, m: 20, s: 0 });
	});
	it('signup bonus is 1000 NC', () => {
		expect(SIGNUP_BONUS).toBe(1000);
	});
});
