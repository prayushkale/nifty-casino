/**
 * Ladder config + generator (PLAN §5 T8).
 *
 * These pin the launch odds table (Task 15 re-validates the *values*, this pins
 * the *shape*: every step priced, SENSEX's missing 300, the ±3% CAS clamp and the
 * anchor-free day yielding no options at all).
 */
import { describe, expect, it } from 'vitest';
import {
	CAS_BAND_PCT,
	LADDER_CONFIG,
	LADDER_UNDERLYINGS,
	deadZoneHalfStep,
	generateLadderOptions,
	isStepWithinCasBand,
	round2,
	tolerancePoints
} from './ladder';
import type { LadderUnderlying } from './ladder.types';

/** The PLAN §0.1 "prev close ≈" column — the anchors every launch number assumes. */
const LAUNCH_ANCHORS: Record<LadderUnderlying, number | null> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

describe('LADDER_CONFIG', () => {
	it('has exactly the three tradable indices, in display order', () => {
		expect(LADDER_UNDERLYINGS).toEqual(['nifty', 'banknifty', 'sensex']);
	});

	it('offers four steps per index', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			expect(LADDER_CONFIG[underlying].steps, underlying).toHaveLength(4);
		}
	});

	it('prices every step — an unpriced step would bet at undefined odds', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const { steps, odds } = LADDER_CONFIG[underlying];
			for (const step of steps) {
				expect(odds[step], `${underlying} ±${step}`).toBeGreaterThan(1);
			}
		}
	});

	it('keeps the launch odds table (PLAN §0.2)', () => {
		expect(LADDER_CONFIG.nifty.odds).toEqual({ 50: 6, 100: 4.5, 150: 3.8, 200: 3.2 });
		expect(LADDER_CONFIG.banknifty.odds).toEqual({ 100: 6, 200: 4.5, 300: 3.8, 400: 3.2 });
		expect(LADDER_CONFIG.sensex.odds).toEqual({ 150: 6, 250: 4.5, 400: 3.8, 500: 3.2 });
	});

	it('keeps SENSEX free of a 300 step — its round-number spacing skips it', () => {
		expect(LADDER_CONFIG.sensex.steps).toEqual([150, 250, 400, 500]);
		expect(LADDER_CONFIG.sensex.steps).not.toContain(300);
	});

	it('keeps the launch tolerances, wider for the wider index', () => {
		expect(LADDER_CONFIG.nifty.tolerancePts).toBe(15);
		expect(LADDER_CONFIG.banknifty.tolerancePts).toBe(30);
		expect(LADDER_CONFIG.sensex.tolerancePts).toBe(40);
		expect(tolerancePoints('sensex')).toBe(40);
	});

	it('halves the smallest step for the dead zone (nifty 25 / banknifty 50 / sensex 75)', () => {
		expect(deadZoneHalfStep('nifty')).toBe(25);
		expect(deadZoneHalfStep('banknifty')).toBe(50);
		expect(deadZoneHalfStep('sensex')).toBe(75);
	});

	it('pays more for the harder (tighter) targets, so odds fall as steps grow', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const { steps, odds } = LADDER_CONFIG[underlying];
			const priced = steps.map((step) => odds[step]);
			expect(priced, underlying).toEqual([...priced].sort((a, b) => b - a));
		}
	});
});

describe('isStepWithinCasBand', () => {
	it('is the ±3% band', () => {
		expect(CAS_BAND_PCT).toBe(3);
	});

	it('admits a step at exactly the band edge and rejects one point beyond it', () => {
		// 3% of 10,000 is 300 — the boundary case the clamp test below relies on.
		expect(isStepWithinCasBand(10_000, 300)).toBe(true);
		expect(isStepWithinCasBand(10_000, 301)).toBe(false);
	});

	it('is direction-agnostic', () => {
		expect(isStepWithinCasBand(25_000, -200)).toBe(true);
	});

	it('refuses to reason about a meaningless anchor', () => {
		expect(isStepWithinCasBand(0, 50)).toBe(false);
		expect(isStepWithinCasBand(-25_000, 50)).toBe(false);
		expect(isStepWithinCasBand(Number.NaN, 50)).toBe(false);
	});
});

describe('generateLadderOptions', () => {
	it('produces 8 options per fully eligible index (24 at the launch anchors)', () => {
		const options = generateLadderOptions(LAUNCH_ANCHORS);
		expect(options).toHaveLength(24);
		for (const underlying of LADDER_UNDERLYINGS) {
			expect(
				options.filter((o) => o.underlying === underlying),
				underlying
			).toHaveLength(8);
		}
	});

	it('builds targets as anchor ± step, both directions of every step', () => {
		const options = generateLadderOptions({ ...LAUNCH_ANCHORS, banknifty: null, sensex: null });
		expect(options.map((o) => o.target)).toEqual([
			25_050, 24_950, 25_100, 24_900, 25_150, 24_850, 25_200, 24_800
		]);
		expect(options.map((o) => o.targetKind)).toEqual([
			'up',
			'down',
			'up',
			'down',
			'up',
			'down',
			'up',
			'down'
		]);
	});

	it('copies the configured odds onto each option (the only odds source in the app)', () => {
		const options = generateLadderOptions(LAUNCH_ANCHORS);
		const nifty = options.find((o) => o.underlying === 'nifty' && o.deltaPoints === 100);
		expect(nifty?.odds).toBe(4.5);
		const sensex = options.find((o) => o.underlying === 'sensex' && o.deltaPoints === 400);
		expect(sensex?.odds).toBe(3.8);
		expect(options.find((o) => o.underlying === 'sensex' && o.deltaPoints === 300)).toBeUndefined();
	});

	it('rounds targets to 2dp for a fractional anchor', () => {
		const options = generateLadderOptions({
			nifty: 24_999.456,
			banknifty: null,
			sensex: null
		});
		expect(options.find((o) => o.targetKind === 'up' && o.deltaPoints === 50)?.target).toBe(
			25_049.46
		);
		expect(options.find((o) => o.targetKind === 'down' && o.deltaPoints === 50)?.target).toBe(
			24_949.46
		);
	});

	it('drops the steps that exceed the ±3% CAS band and keeps the rest (partial clamp)', () => {
		// 3% of 10,000 = 300pts: BANKNIFTY's 400 step cannot be reached in CAS, the
		// other three can — a shorter ladder, not a failure.
		const options = generateLadderOptions({ nifty: null, banknifty: 10_000, sensex: null });
		expect(options.map((o) => o.deltaPoints)).toEqual([100, 100, 200, 200, 300, 300]);
		expect(options.filter((o) => o.deltaPoints === 400)).toHaveLength(0);
	});

	it('yields nothing for a missing, zero or non-finite anchor', () => {
		expect(generateLadderOptions({ nifty: null, banknifty: null, sensex: null })).toEqual([]);
		expect(generateLadderOptions({ nifty: 0, banknifty: 25_000, sensex: null })).toHaveLength(8);
		expect(
			generateLadderOptions({ nifty: Number.NaN, banknifty: 25_000, sensex: null })
		).toHaveLength(8);
	});

	it('is deterministic — same anchors, same options in the same order', () => {
		expect(generateLadderOptions(LAUNCH_ANCHORS)).toEqual(generateLadderOptions(LAUNCH_ANCHORS));
	});

	it('rounds to 2dp without float dust', () => {
		expect(round2(24_950.000000001)).toBe(24_950);
		expect(round2(1.005)).toBe(1.0);
	});
});
