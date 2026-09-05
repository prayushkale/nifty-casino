/**
 * The bet ladder (PLAN §0.1, STRIKE-BASED revision) — per-index spacing,
 * tolerance and the pure generator that turns anchors into a day's selectable
 * strikes.
 *
 * THE STRIKE MODEL (user-mandated):
 *   The player no longer picks "+50 / +100 / +150 …". They pick a STRIKE — the
 *   absolute index level they expect the CAS close to land at. The generator
 *   builds those strikes across the whole ±3% SEBI CAS band around the anchor
 *   (the last traded price at 15:15:01), spaced by the index's round-number
 *   step (nifty 50, banknifty 100, sensex 150). A nifty anchor of 25,000 with a
 *   ±750-point band yields strikes 25,050 … 25,750 and 24,950 … 24,250 — one
 *   selectable price per row, not an offset.
 *
 *   Under the hood a strike is still stored the old way — `deltaPoints` = the
 *   distance from the anchor, `targetKind` = up/down, `target` = the absolute
 *   level — so settlement (`computeTier`), the bets table and the ledger are
 *   untouched by this change. Only the shape of the selectable board changed.
 *
 * PROVENANCE OF THE ODDS (read before touching them):
 *   There is ONE multiplier, MAX_HIT_ODDS = 28, on every strike. Payout is
 *   accuracy-graded: exact pays 28× stake, decaying linearly to 0 at the
 *   tolerance edge. With a fine ladder this means EV falls with distance by
 *   design — a near strike is likelier to be hit than a far one at the same
 *   price. The launch gate therefore gates the CEILING (no option may price
 *   player-favourable, pooled EV < 1) rather than a per-option floor; see
 *   scripts/simulate-ev.ts.
 *
 *   Re-run the simulator (it prints per-strike EV) whenever the anchors, the
 *   spacing, the tolerance or the band change.
 *
 * ACCURACY-GRADED RULE: the multiplier depends on HOW CLOSE the close lands to
 * the picked strike — exact = MAX_HIT_ODDS × stake, decaying LINEARLY to 0 at
 * the tolerance edge: payout = stake × MAX × (1 − err/tol). A complete miss (or
 * a wrong direction) pays 0; the dead-zone FLAT still refunds 1×.
 *
 *   `tolerancePts` is the per-index band around the target: a HIT needs the right
 *   direction AND |Δ − deltaPoints| <= tolerance. It is a USER-MANDATED GAME RULE
 *   (PLAN §0.2), as are the dead zone and the full-loss miss rule — the simulator
 *   is allowed to tune the odds and nothing else.
 *
 *   The dead zone (flat-refund region, the only mercy rule in PLAN §0.2) is
 *   half the index's strike *spacing* — {@link deadZoneHalfStep}. Below it, every
 *   bet refunds 1× and nobody loses money to a do-nothing day.
 *
 * Config only: no imports of server or store code, so both the server (which
 * generates and validates) and the browser (which renders the strike board) can
 * read it.
 */
import type { LadderOption, LadderTargetKind, LadderUnderlying } from './ladder.types';

export type {
	LadderForDate,
	LadderOption,
	LadderTargetKind,
	LadderUnderlying
} from './ladder.types';

/** Per-index strike spacing and HIT tolerance, in points. */
export type LadderIndexConfig = {
	/**
	 * Strike spacing: strikes sit at anchor ± k × spacing for every whole k that
	 * fits inside the ±3% CAS band. Ascending granularity, wider for wider indexes.
	 */
	stepSpacing: number;
	/** ± points around the target that still counts as a HIT (PLAN §0.2). */
	tolerancePts: number;
};

/**
 * The strike ladder. Every strike prices the SAME MAX_HIT_ODDS — the board shows
 * "up to 28×" and settlement grades down from there by closeness.
 */
export const LADDER_CONFIG: Readonly<Record<LadderUnderlying, LadderIndexConfig>> = {
	nifty: { stepSpacing: 50, tolerancePts: 15 },
	banknifty: { stepSpacing: 100, tolerancePts: 30 },
	sensex: { stepSpacing: 150, tolerancePts: 40 }
};

/**
 * Single max multiplier for an EXACT hit (err = 0), shared by every strike.
 *
 * ACCURACY-GRADED RULE (user-mandated): the multiplier depends on HOW CLOSE the
 * close lands to the picked strike — not on how far the strike sits from the
 * prev close. Exact = MAX_HIT_ODDS × stake, decaying LINEARLY to 0 at the
 * tolerance edge: payout = stake × MAX × (1 − err/tol). A complete miss (or a
 * wrong direction) pays 0; the dead-zone FLAT still refunds 1×.
 */
export const MAX_HIT_ODDS = 28;
export const LADDER_UNDERLYINGS: readonly LadderUnderlying[] = ['nifty', 'banknifty', 'sensex'];

/**
 * SEBI's Closing Auction Session only lets the indicative move a few percent off
 * the reference price, so a strike beyond this band could never be hit. The
 * generator fills the band exactly and never offers a strike outside it.
 */
export const CAS_BAND_PCT = 3;

/** The tolerance (dead-zone half-width) configured for one index, in points. */
export function tolerancePoints(underlying: LadderUnderlying): number {
	return LADDER_CONFIG[underlying].tolerancePts;
}

/**
 * Half of the index's strike spacing — the FLAT dead zone of PLAN §0.2. A final
 * move with |Δ| < this refunds every bet on that index 1× regardless of direction.
 */
export function deadZoneHalfStep(underlying: LadderUnderlying): number {
	return LADDER_CONFIG[underlying].stepSpacing / 2;
}

/** Whether a point distance fits inside SEBI's ±CAS band around `anchor`. */
export function isStepWithinCasBand(anchor: number, step: number): boolean {
	if (!Number.isFinite(anchor) || !Number.isFinite(step) || anchor <= 0) return false;
	return Math.abs(step) <= (anchor * CAS_BAND_PCT) / 100;
}

/** Round to 2dp — index levels are quoted to two decimals, never more. */
export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * The round STRIKE levels of one index for one anchor — like NSE's option chain.
 *
 * Strikes are whole multiples of the index's spacing inside the ±3% CAS band
 * around the anchor. A strike ABOVE the anchor is a CE leg (the player expects
 * the close up at that level); one BELOW is a PE leg. The returned distances are
 * measured from the anchor itself, so a nifty anchor of 24,873 with 50-point
 * spacing offers CE strikes 24,900 … (distances 27, 77, 127 …) and PE strikes
 * 24,850 … (distances 23, 73 …) — the strikes are round, the distances need not
 * be.
 */
export type LadderStrikes = {
	/** CE distances (strike − anchor), ascending — every strike above the anchor. */
	up: number[];
	/** PE distances (anchor − strike), ascending — every strike below the anchor. */
	down: number[];
};

/**
 * Strikes closer to the anchor than half a step sit inside the settlement dead
 * zone (|Δ| < halfStep is a flat refund): a hit there could only ever land at
 * accuracy ≤ 1 − halfStep/tolerance, so the strike would be a trap. They are not
 * offered. On a spacing multiple the nearest strikes sit exactly one spacing out,
 * which already clears the zone; off a fractional anchor the exclusion only ever
 * bites the side whose nearest round strike falls inside it.
 */

export function ladderStrikesForAnchor(
	anchor: number,
	underlying: LadderUnderlying
): LadderStrikes {
	if (!Number.isFinite(anchor) || anchor <= 0) return { up: [], down: [] };
	const band = (anchor * CAS_BAND_PCT) / 100;
	const spacing = LADDER_CONFIG[underlying].stepSpacing;
	const first = Math.ceil((anchor - band) / spacing);
	const last = Math.floor((anchor + band) / spacing);
	const up: number[] = [];
	const down: number[] = [];
	const deadZone = deadZoneHalfStep(underlying);
	for (let k = first; k <= last; k++) {
		const level = k * spacing;
		if (level > anchor) {
			const dist = round2(level - anchor);
			if (dist > deadZone) up.push(dist);
		} else if (level < anchor) {
			const dist = round2(anchor - level);
			if (dist > deadZone) down.push(dist);
		}
	}
	// k ascends, so the below-anchor strikes came out far-to-near; the chain reads
	// nearest-first on both sides.
	down.reverse();
	return { up, down };
}

/**
 * Generate one day's strikes from previous-day closes.
 *
 * Pure and infallible: an index with no usable anchor (missing, 0, null or
 * non-finite — the usual state before the feed carries a prevClose) simply yields
 * zero strikes for that index. A fully eligible index yields one option per
 * ROUND strike level inside the ±3% CAS band — CE above the anchor, PE below —
 * exactly the strike series an NSE option chain would list.
 */
export function generateLadderOptions(
	anchors: Readonly<Record<LadderUnderlying, number | null>>
): LadderOption[] {
	const options: LadderOption[] = [];
	for (const underlying of LADDER_UNDERLYINGS) {
		const anchor = anchors[underlying];
		if (anchor === null || anchor === undefined) continue;
		if (!Number.isFinite(anchor) || anchor <= 0) continue;

		const { up, down } = ladderStrikesForAnchor(anchor, underlying);
		const spacing = LADDER_CONFIG[underlying].stepSpacing;
		const emit = (targetKind: LadderTargetKind, step: number): void => {
			// Recover the exact ROUND strike level from the (2dp) distance: the strike
			// is the nearest spacing multiple, so no rounding dust can leak in.
			const level =
				Math.round((targetKind === 'up' ? anchor + step : anchor - step) / spacing) * spacing;
			options.push({
				underlying,
				targetKind,
				deltaPoints: step,
				target: round2(level),
				odds: MAX_HIT_ODDS
			});
		};
		for (const step of up) emit('up', step);
		for (const step of down) emit('down', step);
	}
	return options;
}
