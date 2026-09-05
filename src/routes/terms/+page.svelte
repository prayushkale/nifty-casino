<script lang="ts">
	import SubpageNav from '$lib/components/game/SubpageNav.svelte';
	import { MAX_HIT_ODDS } from '$lib/config/ladder';

	/** Highest odds on the board — this copy must never drift from the config. */
	const maxOdds = MAX_HIT_ODDS;

	/** Short, static, honest. T13 may restyle it; the words stay plain on purpose. */
	const terms: { heading: string; body: string }[] = [
		{
			heading: 'Play money only',
			body: 'NiftyCasino is a forecasting game. Chips ("NC") are virtual points with no cash value: they cannot be bought, sold, transferred or redeemed for money or goods of any kind.'
		},
		{
			heading: 'Entertainment only',
			body: 'Nothing here is investment advice, a recommendation, or an offer to trade. We are not a broker, exchange, bookmaker or gambling operator, and no real-money wagering takes place on this service.'
		},
		{
			heading: 'Who can play',
			body: 'You must be at least 18 years old to create an account, and you confirm this at signup. One account per person; handles are public and visible on leaderboards and profile pages.'
		},
		{
			heading: 'What we show',
			body: 'Index prices are collected from public NSE/BSE endpoints and are shown for entertainment. They may be delayed, incomplete or wrong. Settlement uses publicly reported closing auction values and can be revised by the exchange.'
		},
		{
			heading: 'Your data',
			body: 'We store the email you sign up with, your handle, your bets and your chip balance. Your email is never shown publicly. You can ask for your account to be deleted at any time.'
		},
		{
			heading: 'No warranty',
			body: 'The service is provided as is. To the extent permitted by law we are not liable for any loss arising from its use, including any decision you make about real securities after playing here.'
		}
	];

	/**
	 * The payout rule behind the modal's "how it pays" link (T13). The numbers are
	 * the ladder's odds; this is the RULE, so it only changes when the settlement
	 * contract does.
	 */
	const payouts: { outcome: string; condition: string; result: string }[] = [
		{
			outcome: '🎯 Hit (graded by accuracy)',
			condition: 'Right direction, and the close lands inside the target band.',
			result: `Exactly on target pays your stake × up to ${maxOdds}×. The further the close lands from your target, the less it pays — decaying linearly to nothing at the band edge.`
		},
		{
			outcome: '➖ Flat',
			condition: 'The index barely moves — inside the dead zone around the previous close.',
			result: 'Your stake back in full. No win, no loss.'
		},
		{
			outcome: '💀 Miss',
			condition: 'Everything else — wrong direction, or right direction but outside the band.',
			result: 'The stake is lost in full. There is no consolation tier.'
		}
	];
</script>

<svelte:head>
	<title>Terms · NiftyCasino</title>
</svelte:head>

<article
	class="mx-auto flex w-full max-w-2xl flex-col gap-6 py-12 text-sm text-zinc-700 dark:text-zinc-300"
>
	<SubpageNav />
	<header class="space-y-1.5">
		<h1 class="text-2xl font-semibold text-amber-600 dark:text-gold-glow">Terms of play</h1>
		<p class="text-xs uppercase tracking-wide text-zinc-500">
			Short version: play money, entertainment only, 18+
		</p>
	</header>

	<!-- The payout table sits FIRST, because the confirm modal links straight here. -->
	<section id="payouts" class="nc-card scroll-mt-24 p-5">
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">How a bet pays</h2>
		<p class="mt-1.5 text-zinc-600 dark:text-zinc-400">
			Every call is measured against the index's previous close, using the exchange's published
			closing auction value. Three things can happen:
		</p>
		<ul class="mt-4 flex flex-col gap-3">
			{#each payouts as row}
				<li
					class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-felt-800 dark:bg-felt-900/60"
				>
					<p class="font-semibold text-zinc-900 dark:text-zinc-100">{row.outcome}</p>
					<p class="mt-1 text-zinc-600 dark:text-zinc-400">{row.condition}</p>
					<p class="mt-1 text-zinc-700 dark:text-zinc-300">{row.result}</p>
				</li>
			{/each}
		</ul>
		<p class="mt-4 text-xs text-zinc-500">
			Every rung pays up to {maxOdds}× for an exact hit — the multiplier depends on how close the
			close lands to your target, not on how far the target sits from the previous close. The figure
			on each ladder chip and on the confirm screen is that exact-hit max. One bet per index per
			day; bets can be edited or cancelled until the 15:20 IST cutoff.
		</p>
	</section>

	{#each terms as section}
		<section
			class="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-felt-800 dark:bg-felt-900/40 dark:shadow-none"
		>
			<h2 class="text-base font-semibold text-amber-700 dark:text-gold">{section.heading}</h2>
			<p class="mt-1.5 leading-relaxed text-zinc-600 dark:text-zinc-400">{section.body}</p>
		</section>
	{/each}

	<p class="border-t border-zinc-200 pt-6 text-xs text-zinc-500 dark:border-felt-700">
		Questions or account deletion requests: open an issue on the project repository.
	</p>
</article>
