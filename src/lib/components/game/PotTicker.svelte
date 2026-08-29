<script lang="ts">
	import type { PotView } from '$lib/server/state';
	import RollValue from './RollValue.svelte';

	/**
	 * The room's money, in the top bar (PLAN §0 "totals visibility", §4 top bar).
	 *
	 * `totalStaked` + `totalBets` are the two numbers that make a quiet table feel
	 * crowded, so they travel in every `/api/state` payload rather than being a
	 * separate endpoint hit per client. T13 rolls them (`RollValue`) — a pot that
	 * visibly climbs is the cheapest crowd noise there is — and the roll starts
	 * from the first value it is given, so a page load does not animate from zero.
	 *
	 * Always rendered when given a pot: on desktop the bar itself hides it below
	 * `md`, and on mobile it is the second anchor, so hiding it here would leave a
	 * 360px screen with no pot at all.
	 */
	export let pot: PotView | null = null;

	$: staked = pot === null ? null : pot.totalStaked;
	$: bets = pot === null ? null : pot.totalBets;
</script>

<span
	class="inline-flex shrink-0 items-center gap-2 rounded-full border border-felt-700 bg-felt-900/80 px-3 py-1 text-xs text-zinc-400"
	title="Everything staked across the table today"
>
	<span aria-hidden="true">🪙</span>
	<span class="font-semibold text-gold">
		<RollValue value={staked} suffix=" NC" />
	</span>
	<span class="text-felt-700" aria-hidden="true">·</span>
	<RollValue value={bets} />
	<span class="hidden lg:inline">{bets === 1 ? 'bet' : 'bets'}</span>
</span>
