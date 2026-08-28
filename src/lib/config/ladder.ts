/**
 * The bet ladder (PLAN §0.1) — per-index steps, odds and tolerance, plus the pure
 * generator that turns previous-day closes into a day's selectable options.
 *
 * PROVENANCE OF THE ODDS (read before touching them):
 *   These are the *launch set*. They are not guessed twice — Task 15's Monte-Carlo
 *   EV simulation (`scripts/simulate-ev.ts`) is the tuning gate, and it must show
 *   every option's expected value landing in [0.85, 0.95] before launch. A house
 *   edge of 5–15% is the product requirement; an EV >= 1 is a loss-making game.
 *   Intuition for the shape: a tighter target is harder to hit, so it pays more.
 *
 *   `tolerancePts` is the per-index band around the target: a HIT needs the right
 *   direction AND |Δ − deltaPoints| <= tolerance. A wider index moves in bigger
 *   steps, so it gets a proportionally wider band.
 *
 *   The dead zone (flat-refund region, the only mercy rule in PLAN §0.2) is
 *   half the index's *smallest* step — {@link deadZoneHalfStep}. Below it, every
 *   bet refunds 1× and nobody loses money to a do-nothing day.
 *
 * Config only: no imports of server or store code, so both the server (which
 * generates and validates) and the browser (which renders the chips) can read it.
 */
import type { LadderOption, LadderTargetKind, LadderUnderlying } from './ladder.types';

export type {
	LadderForDate,
	LadderOption,
	LadderTargetKind,
	LadderUnderlying
} from './ladder.types';

/** Steps in points and their HIT multipliers, keyed by the step they belong to. */
export type LadderIndexConfig = {
	/** Round-number deltas offered both ways (up/down). Ascending. */
	steps: readonly number[];
	/** Step → HIT multiplier. Every step MUST have an entry — enforced by the tests. */
	odds: Readonly<Record<number, number>>;
	/** ± points around the target that still counts as a HIT (PLAN §0.2). */
	tolerancePts: number;
};

/**
 * The launch ladder. SENSEX deliberately has NO 300 step: its round-number
 * spacing is 150/250/400/500 (PLAN §0.1), which is why `odds` is keyed by step
 * rather than derived from a position in `steps`.
 */
export const LADDER_CONFIG: Readonly<Record<LadderUnderlying, LadderIndexConfig>> = {
	nifty: {
		steps: [50, 100, 150, 200],
		odds: { 50: 6, 100: 4.5, 150: 3.8, 200: 3.2 },
		tolerancePts: 15
	},
	banknifty: {
		steps: [100, 200, 300, 400],
		odds: { 100: 6, 200: 4.5, 300: 3.8, 400: 3.2 },
		tolerancePts: 30
	},
	sensex: {
		steps: [150, 250, 400, 500],
		odds: { 150: 6, 250: 4.5, 400: 3.8, 500: 3.2 },
		tolerancePts: 40
	}
};

/** Display (and generation) order of the indices. Mirrors the `underlying` CHECK. */
export const LADDER_UNDERLYINGS: readonly LadderUnderlying[] = ['nifty', 'banknifty', 'sensex'];

/**
 * SEBI's Closing Auction Session only lets the indicative move a few percent off
 * the reference price, so a step wider than this band could never be hit. The
 * generator *rejects* (not clamps) such steps: a partially-populated ladder for a
 * small anchor is the expected shape, never an error.
 */
export const CAS_BAND_PCT = 3;

/** The tolerance (dead-zone half-width) configured for one index, in points. */
export function tolerancePoints(underlying: LadderUnderlying): number {
	return LADDER_CONFIG[underlying].tolerancePts;
}

/**
 * Half of the index's smallest step — the FLAT dead zone of PLAN §0.2. A final
 * move with |Δ| < this refunds every bet on that index 1× regardless of direction.
 */
export function deadZoneHalfStep(underlying: LadderUnderlying): number {
	return LADDER_CONFIG[underlying].steps[0] / 2;
}

/** Whether `step` fits inside SEBI's ±CAS band around `anchor` (3% → nifty 750pts). */
export function isStepWithinCasBand(anchor: number, step: number): boolean {
	if (!Number.isFinite(anchor) || !Number.isFinite(step) || anchor <= 0) return false;
	return Math.abs(step) <= (anchor * CAS_BAND_PCT) / 100;
}

/** Round to 2dp — index levels are quoted to two decimals, never more. */
export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Generate one day's options from previous-day closes.
 *
 * Pure and infallible: an index with no usable anchor (missing, 0, null or
 * non-finite — the usual state before the feed carries a prevClose) simply yields
 * zero options for that index. A fully eligible index yields exactly 8 (4 steps ×
 * up/down). Steps outside the ±3% CAS band are dropped, so a small anchor produces
 * a shorter ladder — that is the documented "partially clamped" shape.
 */
export function generateLadderOptions(
	anchors: Readonly<Record<LadderUnderlying, number | null>>
): LadderOption[] {
	const options: LadderOption[] = [];
	for (const underlying of LADDER_UNDERLYINGS) {
		const anchor = anchors[underlying];
		if (anchor === null || anchor === undefined) continue;
		if (!Number.isFinite(anchor) || anchor <= 0) continue;

		const { steps, odds } = LADDER_CONFIG[underlying];
		for (const step of steps) {
			if (!isStepWithinCasBand(anchor, step)) continue;
			for (const targetKind of ['up', 'down'] as const satisfies readonly LadderTargetKind[]) {
				const signed = targetKind === 'up' ? anchor + step : anchor - step;
				options.push({
					underlying,
					targetKind,
					deltaPoints: step,
					target: round2(signed),
					odds: odds[step]
				});
			}
		}
	}
	return options;
}
