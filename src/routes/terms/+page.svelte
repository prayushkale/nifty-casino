<script lang="ts">
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
</script>

<svelte:head>
	<title>Terms · NiftyCasino</title>
</svelte:head>

<article class="mx-auto flex w-full max-w-2xl flex-col gap-6 py-12 text-sm text-zinc-300">
	<header class="space-y-1.5">
		<h1 class="text-2xl font-semibold text-gold-glow">Terms of play</h1>
		<p class="text-xs uppercase tracking-wide text-zinc-500">
			Short version: play money, entertainment only, 18+
		</p>
	</header>

	{#each terms as section}
		<section class="space-y-1.5">
			<h2 class="text-base font-semibold text-gold">{section.heading}</h2>
			<p class="leading-relaxed text-zinc-400">{section.body}</p>
		</section>
	{/each}

	<p class="border-t border-felt-700 pt-6 text-xs text-zinc-500">
		Questions or account deletion requests: open an issue on the project repository.
	</p>
</article>
