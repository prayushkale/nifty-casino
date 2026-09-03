<script lang="ts">
	import SubpageNav from '$lib/components/game/SubpageNav.svelte';

	/** Narrow centred card every /auth/* page renders inside. T11 restyles in place. */
	export let title: string;
	export let subtitle: string | null = null;
</script>

<div class="mx-auto flex w-full max-w-md flex-col gap-6 py-12">
	<SubpageNav homeLabel="Back to home" />
	<header class="space-y-1.5">
		<h1 class="text-2xl font-semibold text-zinc-900 dark:text-gold-glow">{title}</h1>
		{#if subtitle}
			<p class="text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>
		{/if}
	</header>

	<div
		class="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-felt-700 dark:bg-felt-900/80 dark:shadow-card"
	>
		<slot />
	</div>
</div>
