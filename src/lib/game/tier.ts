/**
 * `computeTier` + `payoutFor` — the casino's rulebook (PLAN §0.2).
 *
 * ONE ARITHMETIC, TWO CONSUMERS. This file is the SHARED RULEBOOK: the server's
 * settlement engine (`$lib/server/settle/engine`) decides real money with it, and
 * the game page's "if it closed right now" strip (T11) previews the very same
 * verdicts with it. That is why it lives in `$lib/game/` and not under
 * `$lib/server/` — SvelteKit refuses to let browser code import a server module,
 * and a payout preview that disagreed with the payout engine would be a worse bug
 * than either one being wrong. Do not move it back, and do not fork the maths.
 *
 * PURE. No I/O, no clock, no store, no fetchers: this module is the one place the
 * words "hit", "flat" and "miss" are given arithmetic, so it must stay importable
 * from a test with no database and from the browser's payout-preview strip. It
 * imports nothing but the ladder config, which is where the band widths live.
 *
 * The rule, in the order it must be applied:
 *
 *   Δ = officialClose − prevClose
 *
 *   1. `abstain` — no usable anchor (prevClose missing, ≤ 0 or non-finite). The
 *      engine leaves these bets for a later re-run instead of settling blind;
 *      `abstain` is deliberately NOT a payout tier, it is "do not touch this bet".
 *   2. `flat`    — |Δ| < deadZoneHalfStep(index), STRICTLY less. Checked FIRST, so
 *      a do-nothing day refunds everyone whose direction happened to be right by
 *      less than half a step — and also everyone who was wrong by that much. The
 *      boundary itself is not in the dead zone: |Δ| exactly = half a step is a
 *      real move and falls through to the target test.
 *   3. `hit`     — the direction is right AND |Δ − signedTarget| ≤ tolerancePts.
 *      The band is inclusive on both edges (a bet "±50 ±15" owns 35 and 65 alike).
 *   4. `miss`    — everything else: wrong direction, or right direction but
 *      outside the band. FULL LOSS, no consolation tier (PLAN §0, user-mandated).
 */
import { LADDER_CONFIG, deadZoneHalfStep, type LadderUnderlying } from '$lib/config/ladder';

/** Every verdict the engine can reach. Only the first three ever pay out. */
export type Tier = 'hit' | 'flat' | 'miss' | 'abstain';

/** The tiers a settled bet may carry — `abstain` is never written to a bet row. */
export type PayableTier = Exclude<Tier, 'abstain'>;

/** The three fields of a bet that settlement needs (`bets` carries the rest). */
export type TierBet = {
	underlying: LadderUnderlying;
	targetKind: 'up' | 'down';
	/** The round-number move the player picked, in points. */
	deltaPoints: number;
};

/**
 * The move a bet is aiming at, in signed points: +Δ for an `up` bet, −Δ for a
 * `down` bet. Settlement compares Δ (the real move) against this.
 */
export function signedTargetPoints(bet: TierBet): number {
	return bet.targetKind === 'up' ? bet.deltaPoints : -bet.deltaPoints;
}

/**
 * The verdict for one bet against one (prevClose, close) pair. Infallible and
 * total: an unusable anchor is an `abstain`, never an exception, because a day
 * with one bad index must still settle the other two.
 */
export function computeTier(bet: TierBet, prevClose: number, close: number): Tier {
	// Never settle blind. `prevClose` is the anchor the whole ladder hangs off; a
	// zero, negative or non-finite one is a feed artefact, not a market.
	if (!Number.isFinite(prevClose) || prevClose <= 0) return 'abstain';
	// A close the extractors should have rejected, but a defensive re-check is
	// cheaper than a wrong payout.
	if (!Number.isFinite(close)) return 'abstain';

	const delta = close - prevClose;
	if (!Number.isFinite(delta)) return 'abstain';

	// 2. Dead zone first — it outranks direction and the target band.
	if (Math.abs(delta) < deadZoneHalfStep(bet.underlying)) return 'flat';

	// 3. HIT: right direction, inside the inclusive tolerance band.
	const target = signedTargetPoints(bet);
	if (
		Math.sign(delta) === Math.sign(target) &&
		Math.abs(delta - target) <= LADDER_CONFIG[bet.underlying].tolerancePts
	) {
		return 'hit';
	}

	// 4. Everything else is a full loss.
	return 'miss';
}

/**
 * What a settled bet credits back, in whole NC chips.
 *
 *   hit  → round(stake × odds) — odds are fractional (3.8), chips are not, so the
 *          product is rounded to the nearest chip. Round-half-up, the convention
 *          every other money figure in the app uses.
 *   flat → stake (a 1× refund)
 *   miss → 0
 *
 * Non-finite inputs pay 0 rather than letting a NaN reach the ledger.
 */
export function payoutFor(tier: PayableTier, stake: number, odds: number): number {
	if (!Number.isFinite(stake) || !Number.isFinite(odds) || stake <= 0) return 0;
	if (tier === 'hit') return Math.round(stake * odds);
	if (tier === 'flat') return Math.round(stake);
	return 0;
}
