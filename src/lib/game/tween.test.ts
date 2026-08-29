/**
 * The rolling-number maths, as tables (PLAN §5 T13).
 *
 * These numbers are rendered into the sticky bar on every page, so the curve is
 * pinned exactly: monotonic (a balance must never visibly roll backwards), the
 * endpoints exact (a roll that ends on 999 when the wallet holds 1,000 is a lie
 * about money), and degenerate durations jump rather than divide by zero.
 */
import { describe, expect, it } from 'vitest';
import { TWEEN_MS, easeOutCubic, tweenDone, tweenStep } from './tween';

describe('easeOutCubic', () => {
	it('is exact at both endpoints', () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
	});

	it('moves fast early and settles late', () => {
		expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
		expect(easeOutCubic(0.75)).toBeGreaterThan(0.75);
		// Halfway through the clock the value is already well past halfway.
		expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
	});

	it('is monotonic — a roll never walks backwards', () => {
		let previous = -1;
		for (let i = 0; i <= 100; i += 1) {
			const value = easeOutCubic(i / 100);
			expect(value).toBeGreaterThan(previous);
			previous = value;
		}
	});

	it('clamps instead of overshooting', () => {
		expect(easeOutCubic(-0.5)).toBe(0);
		expect(easeOutCubic(1.5)).toBe(1);
		expect(easeOutCubic(Number.NaN)).toBe(1);
		expect(easeOutCubic(Number.POSITIVE_INFINITY)).toBe(1);
	});
});

describe('tweenStep', () => {
	it('starts at `from` and finishes exactly on `to`', () => {
		expect(tweenStep(1000, 2000, 0)).toBe(1000);
		expect(tweenStep(1000, 2000, TWEEN_MS)).toBeCloseTo(2000, 10);
		expect(tweenStep(1000, 2000, TWEEN_MS * 10)).toBe(2000);
	});

	it('travels the right distance at the right time', () => {
		// 87.5% of the way at half the clock (the ease-out half-point).
		expect(tweenStep(0, 800, TWEEN_MS / 2)).toBeCloseTo(700, 10);
		expect(tweenStep(-100, 100, TWEEN_MS / 2)).toBeCloseTo(75, 10);
	});

	it('rolls backwards when the target is lower (a lost stake)', () => {
		expect(tweenStep(500, 100, TWEEN_MS / 2)).toBeCloseTo(500 - 400 * 0.875, 10);
		expect(tweenStep(500, 100, TWEEN_MS)).toBeCloseTo(100, 10);
	});

	it('is monotonic toward the target', () => {
		let previous = -Infinity;
		for (let i = 0; i <= 20; i += 1) {
			const value = tweenStep(100, 900, (i / 20) * TWEEN_MS);
			expect(value).toBeGreaterThan(previous);
			previous = value;
		}
	});

	it('jumps straight to the target when the duration is zero or negative', () => {
		expect(tweenStep(1000, 2000, 0, 0)).toBe(2000);
		expect(tweenStep(1000, 2000, 0, -5)).toBe(2000);
	});

	it('treats a non-finite elapsed time as finished', () => {
		expect(tweenStep(1000, 2000, Number.NaN)).toBe(2000);
		expect(tweenStep(1000, 2000, Number.POSITIVE_INFINITY)).toBe(2000);
	});
});

describe('tweenDone', () => {
	it('is false before the clock, true on and after it', () => {
		expect(tweenDone(0, TWEEN_MS)).toBe(false);
		expect(tweenDone(TWEEN_MS - 1, TWEEN_MS)).toBe(false);
		expect(tweenDone(TWEEN_MS, TWEEN_MS)).toBe(true);
		expect(tweenDone(TWEEN_MS + 500, TWEEN_MS)).toBe(true);
	});

	it('finishes immediately on a zero duration', () => {
		expect(tweenDone(0, 0)).toBe(true);
	});

	it('treats junk elapsed time as finished', () => {
		expect(tweenDone(Number.NaN, TWEEN_MS)).toBe(true);
	});
});
