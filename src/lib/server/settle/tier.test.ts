/**
 * `computeTier` / `payoutFor` — the casino's rulebook, tested as a table.
 *
 * This is the one module whose verdict moves money, so every boundary in PLAN
 * §0.2 is pinned here: both tolerance edges (inclusive), one tick past them, the
 * dead-zone edge (exclusive — exactly half a step is a real move), wrong-direction
 * full loss, and the abstain guard that keeps a day with a broken anchor from
 * settling at all. Pure module, zero setup.
 */
import { describe, expect, it } from 'vitest';
import { LADDER_CONFIG, LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { computeTier, payoutFor, signedTargetPoints, type TierBet } from './tier';

const PREV = 25_000;
const CLOSES: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

/** A bet on `underlying` for `delta` points, with the close that produces `move`. */
const verdict = (
	underlying: LadderUnderlying,
	targetKind: 'up' | 'down',
	deltaPoints: number,
	move: number
): ReturnType<typeof computeTier> =>
	computeTier(
		{ underlying, targetKind, deltaPoints },
		CLOSES[underlying],
		CLOSES[underlying] + move
	);

const up = (underlying: LadderUnderlying, deltaPoints: number, move: number) =>
	verdict(underlying, 'up', deltaPoints, move);
const down = (underlying: LadderUnderlying, deltaPoints: number, move: number) =>
	verdict(underlying, 'down', deltaPoints, move);

describe('computeTier — the exact hit', () => {
	it('pays a bet that lands exactly on its target', () => {
		expect(up('nifty', 50, 50)).toBe('hit');
		expect(down('nifty', 50, -50)).toBe('hit');
		expect(up('banknifty', 200, 200)).toBe('hit');
		expect(down('sensex', 250, -250)).toBe('hit');
	});

	it('measures the move from the previous close, not from zero', () => {
		// prevClose 25,000 + close 25,050 = a 50-point move, whatever the level is.
		expect(
			computeTier({ underlying: 'nifty', targetKind: 'up', deltaPoints: 50 }, PREV, 25_050)
		).toBe('hit');
		expect(
			computeTier({ underlying: 'nifty', targetKind: 'up', deltaPoints: 50 }, 10_000, 10_050)
		).toBe('hit');
	});
});

describe('computeTier — the tolerance band is inclusive on both edges', () => {
	it.each([
		['nifty', 50, 15],
		['banknifty', 200, 30],
		['sensex', 400, 40]
	] as const)('%s ±%i: both edges count as a hit (tolerance %i)', (underlying, step, tol) => {
		expect(up(underlying, step, step - tol)).toBe('hit');
		expect(up(underlying, step, step + tol)).toBe('hit');
		expect(down(underlying, step, -(step - tol))).toBe('hit');
		expect(down(underlying, step, -(step + tol))).toBe('hit');
	});

	it.each([
		['nifty', 50, 15],
		['banknifty', 200, 30],
		['sensex', 400, 40]
	] as const)(
		'%s ±%i: one tick beyond either edge is a miss (tolerance %i)',
		(underlying, step, tol) => {
			expect(up(underlying, step, step - tol - 0.01)).toBe('miss');
			expect(up(underlying, step, step + tol + 0.01)).toBe('miss');
		}
	);
});

describe('computeTier — the dead zone is checked first, and strictly', () => {
	it.each([
		['nifty', 25],
		['banknifty', 50],
		['sensex', 75]
	] as const)(
		'%s refunds strictly inside ±%s points, whatever the direction',
		(underlying, halfStep) => {
			const step = LADDER_CONFIG[underlying].steps[0];
			expect(up(underlying, step, halfStep - 0.01)).toBe('flat');
			expect(down(underlying, step, -(halfStep - 0.01))).toBe('flat');
			// A wrong-direction bet inside the dead zone still refunds — the dead zone
			// outranks direction (PLAN §0.2, the one mercy rule).
			expect(up(underlying, step, -(halfStep - 0.01))).toBe('flat');
			expect(down(underlying, step, halfStep - 0.01)).toBe('flat');
		}
	);

	it.each([
		['nifty', 25],
		['banknifty', 50],
		['sensex', 75]
	] as const)('%s at exactly ±%s is a real move, not a refund', (underlying, halfStep) => {
		const step = LADDER_CONFIG[underlying].steps[0];
		// At the boundary the target band is still out of reach, so this is a loss —
		// the point of the assertion is that it is NOT a flat.
		expect(up(underlying, step, halfStep)).toBe('miss');
		expect(up(underlying, step, -halfStep)).toBe('miss');
	});
});

describe('computeTier — miss is a full loss, in both directions of wrong', () => {
	it('loses everything when the direction is wrong', () => {
		expect(up('nifty', 50, -200)).toBe('miss');
		expect(down('nifty', 50, 200)).toBe('miss');
		expect(up('sensex', 400, -600)).toBe('miss');
	});

	it('loses everything when the direction is right but the target is overshot', () => {
		expect(up('nifty', 50, 300)).toBe('miss');
		expect(down('banknifty', 100, -400)).toBe('miss');
		expect(up('sensex', 150, 500)).toBe('miss');
	});

	it('never invents a consolation tier', () => {
		// Every one of these is outside the dead zone (|Δ| >= 25) AND outside the
		// ±15 target band, in both directions.
		for (const move of [26, 66, 90, 120, -26, -66, -120]) {
			expect(up('nifty', 50, move)).toBe('miss');
		}
	});
});

describe('computeTier — do-nothing days', () => {
	it.each([0, 0.01, 1, 12.5, 24.99])('refunds a move of %s points', (move) => {
		expect(up('nifty', 200, move)).toBe('flat');
		expect(down('nifty', 200, move)).toBe('flat');
		expect(down('nifty', 200, -move)).toBe('flat');
	});

	it('refunds Δ = 0 exactly', () => {
		expect(
			computeTier({ underlying: 'nifty', targetKind: 'up', deltaPoints: 50 }, PREV, PREV)
		).toBe('flat');
	});
});

describe('computeTier — abstain: never settle blind', () => {
	const bet: TierBet = { underlying: 'nifty', targetKind: 'up', deltaPoints: 50 };

	it.each([0, -1, -25_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'refuses to settle against a prevClose of %p',
		(prevClose) => {
			expect(computeTier(bet, prevClose, PREV + 50)).toBe('abstain');
		}
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'refuses to settle against a non-finite close of %p',
		(close) => {
			expect(computeTier(bet, PREV, close)).toBe('abstain');
		}
	);

	it('still settles the healthy indices of a broken day', () => {
		// One index's anchor is unusable: that index abstains, the others pay out.
		expect(
			computeTier({ underlying: 'sensex', targetKind: 'up', deltaPoints: 150 }, 0, 82_150)
		).toBe('abstain');
		expect(up('nifty', 50, 50)).toBe('hit');
	});
});

describe('signedTargetPoints', () => {
	it('is positive for an up bet and negative for a down bet', () => {
		expect(signedTargetPoints({ underlying: 'nifty', targetKind: 'up', deltaPoints: 50 })).toBe(50);
		expect(signedTargetPoints({ underlying: 'nifty', targetKind: 'down', deltaPoints: 50 })).toBe(
			-50
		);
	});
});

describe('payoutFor', () => {
	it('pays stake × odds on a hit, rounded to whole chips', () => {
		expect(payoutFor('hit', 100, 6)).toBe(600);
		expect(payoutFor('hit', 100, 4.5)).toBe(450);
		expect(payoutFor('hit', 100, 3.8)).toBe(380);
	});

	it('rounds half up rather than truncating', () => {
		expect(payoutFor('hit', 111, 4.5)).toBe(500); // 499.5
		expect(payoutFor('hit', 111, 3.8)).toBe(422); // 421.8
		expect(payoutFor('hit', 33, 4.5)).toBe(149); // 148.5
	});

	it('refunds exactly the stake on a flat and nothing on a miss', () => {
		expect(payoutFor('flat', 100, 6)).toBe(100);
		expect(payoutFor('flat', 777, 3.2)).toBe(777);
		expect(payoutFor('miss', 100, 6)).toBe(0);
	});

	it('always returns a whole number of chips', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			for (const step of LADDER_CONFIG[underlying].steps) {
				for (const stake of [10, 33, 111, 999, 100_000]) {
					const payout = payoutFor('hit', stake, LADDER_CONFIG[underlying].odds[step]);
					expect(Number.isInteger(payout)).toBe(true);
					expect(payout).toBe(Math.round(stake * LADDER_CONFIG[underlying].odds[step]));
				}
			}
		}
	});

	it('pays nothing for a stake that is not a usable number', () => {
		expect(payoutFor('hit', 0, 6)).toBe(0);
		expect(payoutFor('hit', -100, 6)).toBe(0);
		expect(payoutFor('hit', Number.NaN, 6)).toBe(0);
		expect(payoutFor('hit', Number.POSITIVE_INFINITY, 6)).toBe(0);
		expect(payoutFor('flat', Number.NaN, 6)).toBe(0);
	});
});
