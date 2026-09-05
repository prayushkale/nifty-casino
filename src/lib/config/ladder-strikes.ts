/**
 * Shared strike generation for the exact-nearest-strike settlement rule.
 *
 * `tier.ts` (browser-importable, used by settlement AND the client's payout
 * preview) must know whether a bet is pinned to a strike inside the dead zone.
 * `ladder.ts` — which already exports {@link LadderStrikes} — cannot be
 * imported by `tier.ts` today because it drags in the full ladder generator
 * whose ONLY other dependency is the config. To keep `tier.ts` dependency-lean
 * (it is imported by the payout preview), this module isolates exactly the
 * pure function `tier.ts` needs, and `ladder.ts` re-exports it so the offered
 * set the board generates and the set settlement grades are never two
 * implementations.
 *
 * Config-only by design: no server or store imports, safe for browser bundles.
 */
import { CAS_BAND_PCT, LADDER_CONFIG, type LadderUnderlying } from './ladder';

export type LadderStrikes = {
	/** CE distances (strike − anchor), ascending — every strike above the anchor. */
	up: number[];
	/** PE distances (anchor − strike), ascending — every strike below the anchor. */
	down: number[];
};

/**
 * Every round strike level of one index for one anchor, as distances from the
 * anchor — nifty every 50 pts, banknifty every 100, sensex every 150, spanning
 * the whole ±3% CAS band. The nearest offered level per side may sit INSIDE the
 * settlement dead zone (half a spacing) when the anchor is not itself a round
 * level: a nifty anchor of 23,898 puts 23,900 just 2 pts above and 23,850
 * 48 pts below. Whether a level this close is a trap is a SETTLEMENT question
 * (`tier.ts`'s `isDeadZonePinned` makes it payable, not flat); this module
 * only answers "which levels does the index have today".
 */
export function generateLadderStrikes(anchor: number, underlying: LadderUnderlying): LadderStrikes {
	if (!Number.isFinite(anchor) || anchor <= 0) return { up: [], down: [] };
	const band = (anchor * CAS_BAND_PCT) / 100;
	const spacing = LADDER_CONFIG[underlying].stepSpacing;
	const first = Math.ceil((anchor - band) / spacing);
	const last = Math.floor((anchor + band) / spacing);
	const up: number[] = [];
	const down: number[] = [];
	for (let k = first; k <= last; k++) {
		const level = k * spacing;
		if (level > anchor) {
			up.push(round2(level - anchor));
		} else if (level < anchor) {
			down.push(round2(anchor - level));
		}
	}
	// k ascends, so the below-anchor strikes came out far-to-near; the chain reads
	// nearest-first on both sides.
	down.reverse();
	return { up, down };
}

/** Round to 2dp — index levels are quoted to two decimals, never more. */
export function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
