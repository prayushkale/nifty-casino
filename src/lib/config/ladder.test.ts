/**
 * Ladder config + generator (PLAN §0.1, STRIKE-BASED).
 *
 * These pin the strike ladder's *shape*: the per-index spacing, the tolerance,
 * the ±3% CAS band coverage, the anchor-free day yielding no strikes at all and
 * the single accuracy-graded max on every strike.
 */
import { describe, expect, it } from 'vitest';
import {
	CAS_BAND_PCT,
	LADDER_CONFIG,
	LADDER_UNDERLYINGS,
	MAX_HIT_ODDS,
	deadZoneHalfStep,
	generateLadderOptions,
	isStepWithinCasBand,
	ladderStrikesForAnchor,
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

	it('spaces strikes by round-number steps — 50 / 100 / 150 points', () => {
		expect(LADDER_CONFIG.nifty.stepSpacing).toBe(50);
		expect(LADDER_CONFIG.banknifty.stepSpacing).toBe(100);
		expect(LADDER_CONFIG.sensex.stepSpacing).toBe(150);
	});

	it('keeps the launch tolerances, wider for the wider index', () => {
		expect(LADDER_CONFIG.nifty.tolerancePts).toBe(15);
		expect(LADDER_CONFIG.banknifty.tolerancePts).toBe(30);
		expect(LADDER_CONFIG.sensex.tolerancePts).toBe(40);
		expect(tolerancePoints('sensex')).toBe(40);
	});

	it('halves the strike spacing for the dead zone (nifty 25 / banknifty 50 / sensex 75)', () => {
		expect(deadZoneHalfStep('nifty')).toBe(25);
		expect(deadZoneHalfStep('banknifty')).toBe(50);
		expect(deadZoneHalfStep('sensex')).toBe(75);
	});

	it('prices every strike at the single accuracy-graded max', () => {
		expect(MAX_HIT_ODDS).toBe(28);
	});
});

describe('ladderStrikesForAnchor', () => {
	it('fills the ±3% band with ROUND strike levels, CE above and PE below the anchor', () => {
		// 3% of 25,000 = 750 → strikes 24,250 … 25,750; the anchor is a spacing
		// multiple, so CE and PE distances mirror each other at 50…750.
		const nifty = ladderStrikesForAnchor(25_000, 'nifty');
		expect(nifty.up).toEqual([
			50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750
		]);
		expect(nifty.down).toEqual(nifty.up);

		// 3% of 82,000 = 2,460 → strikes 79,550 … 84,450. The anchor is NOT a
		// 150-multiple, so the first CE strike is 82,200 (+200) and the first PE
		// strike is 81,900 (−100): round levels, unround distances.
		const sensex = ladderStrikesForAnchor(82_000, 'sensex');
		expect(sensex.up).toHaveLength(16);
		expect(sensex.up[0]).toBe(200);
		expect(sensex.up[sensex.up.length - 1]).toBe(2_450); // strike 84,450
		expect(sensex.down).toHaveLength(16);
		expect(sensex.down[0]).toBe(100); // strike 81,900
		expect(sensex.down[sensex.down.length - 1]).toBe(2_350); // strike 79,650
	});

	it('never offers a strike inside the dead zone — that strike would be a trap', () => {
		// sensex's first CE strike off 82,000 is 82,050, only 50 pts away — inside
		// the 75-pt dead zone (|Δ| < 75 refunds everyone). It must not be offered.
		const sensex = ladderStrikesForAnchor(82_000, 'sensex');
		expect(sensex.up).not.toContain(50);
		// The mirrored PE strike at −100 clears the zone and survives.
		expect(sensex.down).toContain(100);
	});

	it('never offers a strike beyond the band — a small anchor truncates the chain', () => {
		// 3% of 10,000 = 300 → banknifty strikes 9,700 … 10,300 → distances 300 down, 300 up.
		const strikes = ladderStrikesForAnchor(10_000, 'banknifty');
		expect(strikes.up).toEqual([100, 200, 300]);
		expect(strikes.down).toEqual([100, 200, 300]);
	});

	it('yields nothing for a meaningless anchor', () => {
		expect(ladderStrikesForAnchor(0, 'nifty')).toEqual({ up: [], down: [] });
		expect(ladderStrikesForAnchor(-25_000, 'nifty')).toEqual({ up: [], down: [] });
		expect(ladderStrikesForAnchor(Number.NaN, 'nifty')).toEqual({ up: [], down: [] });
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
	it('builds one option per round strike, CE above and PE below the anchor', () => {
		const options = generateLadderOptions({ ...LAUNCH_ANCHORS, banknifty: null, sensex: null });
		// 15 strikes per side × 2 sides = 30 nifty options: every CE strike first,
		// then every PE strike, each ascending by distance.
		expect(options).toHaveLength(30);
		expect(options.slice(0, 2).map((o) => [o.deltaPoints, o.targetKind, o.target])).toEqual([
			[50, 'up', 25_050],
			[100, 'up', 25_100]
		]);
		expect(options.at(-1)).toMatchObject({ deltaPoints: 750, targetKind: 'down', target: 24_250 });
		expect(options.filter((o) => o.targetKind === 'up')).toHaveLength(15);
		expect(options.filter((o) => o.targetKind === 'down')).toHaveLength(15);
	});

	it('prices every strike at MAX_HIT_ODDS (the only odds source in the app)', () => {
		const options = generateLadderOptions(LAUNCH_ANCHORS);
		expect(options.length).toBe(30 + 32 + 32);
		for (const option of options) expect(option.odds).toBe(MAX_HIT_ODDS);
	});

	it('keeps the STRIKE round off a fractional anchor — the distance carries the dust', () => {
		const options = generateLadderOptions({
			nifty: 24_873.456,
			banknifty: null,
			sensex: null
		});
		// First CE strike is the round 24,900: distance 26.544, target 2dp-rounded.
		const ce = options.find((o) => o.targetKind === 'up' && o.target === 24_900);
		expect(ce).toBeDefined();
		expect(ce?.deltaPoints).toBe(26.54);
		// First PE strike is the round 24,850, only 23.456 pts below the anchor —
		// inside the 25-pt dead zone, so it is withheld and the chain starts at 24,800.
		const pe = options.find((o) => o.targetKind === 'down' && o.target === 24_850);
		expect(pe).toBeUndefined();
		const firstPe = options.find((o) => o.targetKind === 'down');
		expect(firstPe?.target).toBe(24_800);
		expect(firstPe?.deltaPoints).toBe(73.46);
	});

	it('truncates the chain inside the ±3% CAS band (partial clamp)', () => {
		// 3% of 10,000 = 300pts: BANKNIFTY yields strikes 9,700..10,300 only.
		const options = generateLadderOptions({ nifty: null, banknifty: 10_000, sensex: null });
		expect(options.map((o) => [o.targetKind, o.deltaPoints])).toEqual([
			['up', 100],
			['up', 200],
			['up', 300],
			['down', 100],
			['down', 200],
			['down', 300]
		]);
		expect(options.filter((o) => o.deltaPoints === 400)).toHaveLength(0);
	});

	it('yields nothing for a missing, zero or non-finite anchor', () => {
		expect(generateLadderOptions({ nifty: null, banknifty: null, sensex: null })).toEqual([]);
		expect(generateLadderOptions({ nifty: 0, banknifty: 25_000, sensex: null })).toHaveLength(14);
		expect(
			generateLadderOptions({ nifty: Number.NaN, banknifty: 25_000, sensex: null })
		).toHaveLength(14);
	});

	it('is deterministic — same anchors, same options in the same order', () => {
		expect(generateLadderOptions(LAUNCH_ANCHORS)).toEqual(generateLadderOptions(LAUNCH_ANCHORS));
	});

	it('rounds to 2dp without float dust', () => {
		expect(round2(24_950.000000001)).toBe(24_950);
		expect(round2(1.005)).toBe(1.0);
	});
});
