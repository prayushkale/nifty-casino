/**
 * The bet ladder (PLAN §0.1) — per-index steps, odds and tolerance, plus the pure
 * generator that turns previous-day closes into a day's selectable options.
 *
 * PROVENANCE OF THE ODDS (read before touching them):
 *   These are NOT the PLAN §0.2 launch table (6 / 4.5 / 3.8 / 3.2). They are the
 *   Task 15 SIMULATED set, produced by the launch gate and tuned to it:
 *
 *     scripts/simulate-ev.ts  --seed 20260829 --samples 200000   (2026-08-29)
 *     Base case: σ_day = annVol/√252 × level (13% nifty+sensex, 15% banknifty),
 *     drift −0.02%/day, 8% Student-t(ν=4) heavy tail, graded by computeTier +
 *     payoutFor. Required gate: every option's EV ∈ [0.85, 0.95].
 *
 *   Measured EV at the odds below, all twelve inside the band:
 *
 *     nifty      ±50 → 0.9006   ±100 → 0.8987   ±150 → 0.9006   ±200 → 0.9012
 *     banknifty  ±100 → 0.8996  ±200 → 0.9001   ±300 → 0.8991   ±400 → 0.8984
 *     sensex     ±150 → 0.8985  ±250 → 0.8985   ±400 → 0.9015   ±500 → 0.8999
 *
 *   Why the numbers are what they are, and why they rose ~3–7× from the plan:
 *   Δ = officialClose − prevClose is a FULL trading day's move (settlement anchors
 *   on the previous trading day's close), i.e. σ ≈ 205 / 529 / 672 points for
 *   nifty / banknifty / sensex at the launch anchors. Against that, a ±15/±30/±40
 *   point HIT band is a sliver: P(hit) is only 3.4–5.8% per option, so an odds
 *   table in single digits prices a house edge of 55–81%. Re-run the simulator
 *   (it prints the exact odds each option needs with `--suggest`) whenever the
 *   anchors, the tolerance or the step set changes — the EV band, not this table,
 *   is the requirement.
 *
 *   READ THE ORDERING BEFORE "FIXING" IT: with a tolerance band of FIXED WIDTH,
 *   a bigger step puts the band further out in the distribution's tail, so it is
 *   HARDER to hit and pays MORE. PLAN §0.2's "closer targets are harder → bigger
 *   odds" intuition is backwards for this rulebook — odds here RISE with the step,
 *   and `ladder.test.ts` pins that direction. Only a rule change (a tolerance that
 *   scales with the step) would reverse it.
 *
 *   `tolerancePts` is the per-index band around the target: a HIT needs the right
 *   direction AND |Δ − deltaPoints| <= tolerance. It is a USER-MANDATED GAME RULE
 *   (PLAN §0.2), as are the dead zone and the full-loss miss rule — the simulator
 *   is allowed to tune the odds and nothing else.
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
		odds: { 50: 13.9, 100: 15.2, 150: 17.9, 200: 22.4 },
		tolerancePts: 15
	},
	banknifty: {
		steps: [100, 200, 300, 400],
		odds: { 100: 18.3, 200: 19.1, 300: 21.3, 400: 24 },
		tolerancePts: 30
	},
	sensex: {
		steps: [150, 250, 400, 500],
		odds: { 150: 17.2, 250: 17.8, 400: 20.3, 500: 22.4 },
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
