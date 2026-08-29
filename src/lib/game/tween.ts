/**
 * Rolling-number tween (PLAN §5 T13): the maths behind the pot ticker and the
 * balance chip.
 *
 * Deliberately a handful of pure functions rather than a `tweened()` store:
 * `svelte/motion` re-renders on every frame through the store pipeline, and the
 * pot ticker is in the sticky bar of every page — the rAF loop lives in the one
 * component that needs it (`RollValue.svelte`), and only the *arithmetic* lives
 * here, where a test can pin it.
 *
 * The curve is ease-out cubic: money should move fast the instant it moves and
 * settle gently, which reads as "the table paid" rather than "the page lagged".
 * Linear reads mechanical; ease-in reads like the number is resisting.
 */

/** How long one roll takes. Long enough to read, short enough to never block a click. */
export const TWEEN_MS = 400;

/** `t` clamped to 0..1 — every curve below is fed through this. */
function clamp01(t: number): number {
	if (!Number.isFinite(t)) return t < 0 ? 0 : 1;
	return Math.min(1, Math.max(0, t));
}

/**
 * Ease-out cubic: fast start, soft landing. `0 → 0`, `1 → 1`, monotonic in
 * between, so a roll never overshoots a balance it is describing.
 */
export function easeOutCubic(t: number): number {
	const x = clamp01(t);
	return 1 - (1 - x) ** 3;
}

/**
 * The value `from → to` has reached after `elapsedMs`.
 *
 * Guards: a zero/negative duration jumps straight to `to` (no division by zero,
 * and a caller that wants no animation gets it by passing 0); a non-finite
 * `elapsedMs` is treated as finished.
 */
export function tweenStep(
	from: number,
	to: number,
	elapsedMs: number,
	durationMs = TWEEN_MS
): number {
	if (!Number.isFinite(elapsedMs)) return to;
	if (durationMs <= 0) return to;
	return from + (to - from) * easeOutCubic(elapsedMs / durationMs);
}

/**
 * Whether the player asked the OS for less motion.
 *
 * False outside a browser (so SSR renders the settled number and no test ever
 * depends on a matchMedia stub): the fallback is the *animated* path in a real
 * browser and the static path everywhere else, which is the safe order for a
 * purely cosmetic effect.
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True once `elapsedMs` has covered `durationMs` — the loop's stop condition. */
export function tweenDone(elapsedMs: number, durationMs: number): boolean {
	if (!Number.isFinite(elapsedMs)) return true;
	return elapsedMs >= durationMs;
}
