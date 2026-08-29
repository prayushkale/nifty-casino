<script lang="ts">
	/**
	 * The felt shimmer placeholder (PLAN §5 T13 "empty/loading skeletons").
	 *
	 * One component, two shapes, no dependency:
	 *
	 *   lines — a stack of bars with varying widths, for a card whose content is
	 *           text-and-chips (an index card whose ladder has not landed)
	 *   block — one big rectangle, for a chart that has no snapshot yet
	 *
	 * The shimmer itself is `.nc-skeleton` in `app.css`, so a caller that needs a
	 * one-off placeholder can use the class directly without this wrapper. What
	 * this component adds is the `role="status"` + `aria-label`, so a screen reader
	 * is told what is loading rather than being handed three empty divs — and the
	 * shimmer is width-varied on purpose: four equal bars read as a broken layout,
	 * varied ones read as "content is coming".
	 */
	export let lines = 3;
	/** 'lines' for text-shaped content, 'block' for a fixed-height surface. */
	export let variant: 'lines' | 'block' = 'lines';
	/** Block height in px (the chart placeholder matches its own canvas). */
	export let height = 120;
	/** What is loading — read out by assistive tech, never rendered as text. */
	export let label = 'Loading';

	$: count = Math.max(0, Math.round(lines));
	$: bars = Array.from({ length: count }, (_, i) => i);
	/** Cycling widths so a stack never looks like a ruled page. */
	const WIDTHS = ['w-11/12', 'w-full', 'w-3/4', 'w-5/6'];
</script>

{#if variant === 'block'}
	<div class="nc-skeleton w-full" style={`height:${height}px`} role="status" aria-label={label} />
{:else if count > 0}
	<div class="flex flex-col gap-2" role="status" aria-label={label}>
		{#each bars as i (i)}
			<div class="nc-skeleton h-3.5 {WIDTHS[i % WIDTHS.length]}" />
		{/each}
	</div>
{/if}
