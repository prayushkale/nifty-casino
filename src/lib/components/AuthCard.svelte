<script lang="ts">
	/** Narrow centred card every /auth/* page renders inside. T11 restyles in place. */
	export let title: string;
	export let subtitle: string | null = null;
</script>

<div class="mx-auto flex w-full max-w-md flex-col gap-6 py-12">
	<header class="space-y-1.5">
		<h1 class="text-2xl font-semibold text-gold-glow">{title}</h1>
		{#if subtitle}
			<p class="text-sm text-zinc-400">{subtitle}</p>
		{/if}
	</header>

	<div class="rounded-xl border border-felt-700 bg-felt-900/80 p-6 shadow-card">
		<slot />
	</div>
</div>
