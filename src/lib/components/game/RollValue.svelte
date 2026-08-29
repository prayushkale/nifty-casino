<script lang="ts">
	import { onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { TWEEN_MS, prefersReducedMotion, tweenDone, tweenStep } from '$lib/game/tween';
	import { formatNC } from '$lib/stores/game';

	/**
	 * A number that rolls to its new value instead of snapping (PLAN §5 T13).
	 *
	 * Used for the two numbers a player watches rather than reads — the pot in the
	 * top bar and their own balance in the chip — where the roll is the feedback:
	 * money visibly moving is the whole point of a casino.
	 *
	 * Rules the implementation honours:
	 *
	 *  • FIRST PAINT DOES NOT ANIMATE. The value that arrives with SSR, or with the
	 *    first store read, is simply shown. Animating from 0 on every page load is
	 *    the classic tweened-store mistake and it makes the pot lie for half a
	 *    second about how much is on the table.
	 *  • `prefers-reduced-motion` skips the animation and shows the value.
	 *  • `null` renders an em dash — "we do not know", never "zero".
	 *  • NC is an integer currency, so the displayed value is rounded every frame;
	 *    `formatNC` supplies the en-IN grouping and `tabular-nums` (the `.num`
	 *    class below) keeps the digits from jittering as the count climbs.
	 *
	 * The rAF loop lives here rather than in a `tweened()` store so the maths stays
	 * in `$lib/game/tween.ts`, where it is unit-tested, and so a hidden tab costs
	 * nothing (rAF does not fire when the page is not painting).
	 */
	export let value: number | null = null;
	/** How the number is rendered — the pot and the wallet both use `formatNC`. */
	export let format: (n: number) => string = formatNC;
	export let durationMs = TWEEN_MS;
	/** Rendered after the number, inside the same span (`' NC'`, `' bets'`). */
	export let suffix = '';

	/** What is on screen right now. Never a dependency of the value reaction. */
	let shown: number | null = value;
	let raf = 0;

	$: applyValue(value);

	function applyValue(next: number | null): void {
		if (next === null) {
			stop();
			shown = null;
			return;
		}
		// First paint (or returning from "unknown"), reduced motion, or a zero
		// duration: show it. No roll.
		if (!browser || shown === null || durationMs <= 0 || prefersReducedMotion()) {
			shown = next;
			return;
		}
		roll(shown, next);
	}

	function roll(from: number, to: number): void {
		stop();
		const startedAt = performance.now();
		const step = (now: number): void => {
			const elapsed = now - startedAt;
			shown = Math.round(tweenStep(from, to, elapsed, durationMs));
			raf = tweenDone(elapsed, durationMs) ? 0 : requestAnimationFrame(step);
			if (raf === 0) shown = to;
		};
		raf = requestAnimationFrame(step);
	}

	function stop(): void {
		if (raf !== 0) {
			cancelAnimationFrame(raf);
			raf = 0;
		}
	}

	onDestroy(stop);
</script>

<span class="num">
	{shown === null ? '—' : format(shown)}{suffix}
</span>
