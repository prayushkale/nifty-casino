<script lang="ts">
	import { SIGNUP_BONUS } from '$lib/config/app';
</script>

<svelte:head>
	<title>NiftyCasino — forecast the closing auction</title>
</svelte:head>

<main class="flex flex-1 flex-col items-center justify-center gap-6 py-24 text-center">
	<h1
		class="bg-gradient-to-r from-gold-glow to-gold bg-clip-text text-5xl font-bold text-transparent"
	>
		NiftyCasino
	</h1>
	<p class="max-w-xl text-zinc-400">
		Forecast how NIFTY 50, BANKNIFTY and SENSEX will close in SEBI's Closing Auction Session.
		Play-money chips only — you start with a {SIGNUP_BONUS.toLocaleString('en-IN')} NC signup bonus.
	</p>
	<p class="text-xs text-zinc-600">scaffold placeholder — game UI lands in Task 11</p>
</main>
