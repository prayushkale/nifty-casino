/**
 * Bet-ladder shapes — shared by the static config, the generator, the server
 * service and the game UI.
 *
 * This file is deliberately type-only and dependency-free apart from one
 * **type-only** import: `Underlying` lives in `$lib/server/cas/types`, which is a
 * server module by convention but contains no runtime code we need. Because the
 * import is erased at compile time, this module stays safe to bundle for the
 * browser (the ladder chips are rendered from these types), while the union
 * itself still has exactly one definition in the codebase.
 */

/** The three tradable indices (mirrors the `bets.underlying` CHECK constraint). */
export type LadderUnderlying = 'nifty' | 'banknifty' | 'sensex';

/** Direction of a ladder option relative to the previous close. */
export type LadderTargetKind = 'up' | 'down';

/**
 * One selectable rung of a day's ladder.
 *
 * `target` is the absolute level the index must close at — anchor ± deltaPoints,
 * rounded to 2dp — while `deltaPoints` is the round-number move the user picked.
 * `odds` is the multiplier paid on a HIT; it is copied from the static config and
 * is the ONLY source of odds in the app (never the client).
 */
export type LadderOption = {
	underlying: LadderUnderlying;
	targetKind: LadderTargetKind;
	/** Round-number move from the anchor, in index points. */
	deltaPoints: number;
	/** Absolute level: anchor ± {@link deltaPoints}, rounded to 2dp. */
	target: number;
	/** HIT multiplier for this step, from `LADDER_CONFIG` — frozen at bet time. */
	odds: number;
};

/**
 * A whole day's ladder — the payload `/api/state` (T10) ships to the game page.
 * Options are absent (not merely unbet) when their index has no usable anchor.
 */
export type LadderForDate = {
	/** IST trade date the ladder is for ('YYYY-MM-DD'). */
	tradeDate: string;
	/** The previous-trading-day close each index hangs off (null when unknown). */
	anchors: Record<LadderUnderlying, number | null>;
	options: LadderOption[];
	/** epoch ms — when this ladder was computed. */
	generatedAt: number;
};
