<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';

	/**
	 * Clear subpage navigation: a real Back button (browser history, with a
	 * fallback to `homeHref` when there is no history — e.g. a deep link or a
	 * fresh tab) plus an explicit link home. Render at the top of every
	 * non-game page so nobody is stranded without a way back.
	 */
	export let homeHref: string = '/';
	export let homeLabel: string = 'Back to tables';
	export let backLabel: string = 'Back';

	function goBack(): void {
		if (!browser) return;
		if (window.history.length > 1) window.history.back();
		else void goto(homeHref);
	}
</script>

<div class="flex flex-wrap items-center justify-between gap-2" aria-label="Page navigation">
	<button type="button" class="nc-btn-ghost text-xs" on:click={goBack}>
		<span aria-hidden="true">←</span>
		{backLabel}
	</button>
	<a href={homeHref} class="nc-btn-ghost text-xs">
		<span aria-hidden="true">🏠</span>
		{homeLabel}
	</a>
</div>
