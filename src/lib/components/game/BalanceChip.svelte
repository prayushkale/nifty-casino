<script lang="ts">
	import { browser } from '$app/environment';
	import { formatNC } from '$lib/stores/game';

	/**
	 * The wallet, always top-right (PLAN §4 "three fixed anchors").
	 *
	 * The number is the server's, never the client's arithmetic: the chip renders
	 * whatever `/api/state` last said, and re-reads land here after every bet. A
	 * swap in value flashes green or red once — feedback that the money moved,
	 * without ever showing a number the server has not confirmed.
	 */
	export let balance: number | null = null;
	/** When set the chip links to the player's public profile. */
	export let handle: string | null = null;

	let flash = '';
	let previous: number | null = null;
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	$: if (balance !== previous) {
		if (browser && previous !== null && balance !== null && balance !== previous) {
			flash = balance > previous ? 'text-up' : 'text-down';
			if (resetTimer !== null) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => (flash = ''), 1200);
		}
		previous = balance;
	}
</script>

{#if balance === null}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border border-felt-700 bg-felt-800 px-3 py-1 text-xs font-semibold text-zinc-500"
		title="Log in to see your chips"
	>
		<span aria-hidden="true">🪙</span>
		<span class="num">—</span>
	</span>
{:else}
	{@const content = `🪙 ${formatNC(balance)} NC`}
	{#if handle}
		<a
			href={`/u/${handle}`}
			class="nc-chip {flash} transition-colors duration-500"
			title="{formatNC(balance)} NC — view your profile"
		>
			{content}
		</a>
	{:else}
		<span class="nc-chip {flash} transition-colors duration-500" title="Your chip stack">
			{content}
		</span>
	{/if}
{/if}
