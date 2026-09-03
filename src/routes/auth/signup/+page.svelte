<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthCard from '$lib/components/AuthCard.svelte';

	let email = '';
	let password = '';
	let handle = '';
	let tos = false;
	let fields: Record<string, string> = {};
	let error = '';
	let busy = false;

	async function submit() {
		if (busy) return;
		busy = true;
		error = '';
		fields = {};
		try {
			const res = await fetch('/api/auth/signup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email,
					password,
					// Absent rather than empty: an absent handle is "assign me one".
					handle: handle.trim() === '' ? undefined : handle.trim(),
					tos
				})
			});
			const data = (await res.json().catch(() => ({}))) as {
				needsVerify?: boolean;
				error?: string;
				fields?: Record<string, string>;
			};
			if (!res.ok) {
				fields = data.fields ?? {};
				error = data.error ?? 'Could not sign up.';
				return;
			}
			if (data.needsVerify) {
				await goto(`/auth/verify?email=${encodeURIComponent(email)}`);
				return;
			}
			// Confirmations are off in this project — the session is already live.
			// Re-run server loads with the fresh cookies so `/` paints signed in.
			await goto('/', { invalidateAll: true });
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign up · NiftyCasino</title>
</svelte:head>

<AuthCard
	title="Claim your seat"
	subtitle="Play-money chips only. You start with 1,000 NC — no real money, ever."
>
	<form class="flex flex-col gap-4" on:submit|preventDefault={submit}>
		{#if error}
			<p class="nc-alert">
				{error === 'VALIDATION_FAILED' ? 'Check the highlighted fields.' : error}
			</p>
		{/if}

		<div>
			<label class="nc-label" for="email">Email</label>
			<input
				id="email"
				class="nc-input"
				type="email"
				autocomplete="email"
				bind:value={email}
				required
			/>
			{#if fields.email}<p class="mt-1 text-xs text-down">{fields.email}</p>{/if}
		</div>

		<div>
			<label class="nc-label" for="password">Password</label>
			<input
				id="password"
				class="nc-input"
				type="password"
				autocomplete="new-password"
				bind:value={password}
				required
			/>
			{#if fields.password}<p class="mt-1 text-xs text-down">{fields.password}</p>{/if}
			<p class="mt-1 text-xs text-zinc-600 dark:text-zinc-400">At least 8 characters.</p>
		</div>

		<div>
			<label class="nc-label" for="handle">Handle <span class="normal-case">(optional)</span></label
			>
			<input
				id="handle"
				class="nc-input"
				type="text"
				autocomplete="username"
				placeholder="e.g. nifty_nikhil"
				bind:value={handle}
			/>
			{#if fields.handle}
				<p class="mt-1 text-xs text-down">{fields.handle}</p>
			{:else}
				<p class="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
					We'll assign one if you skip this.
				</p>
			{/if}
		</div>

		<div class="space-y-1">
			<label class="flex items-start gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
				<input type="checkbox" class="mt-0.5 h-4 w-4 accent-gold" bind:checked={tos} />
				<span>
					I'm 18+, this is play-money entertainment, no real money —
					<a
						href="/terms"
						class="text-amber-700 underline decoration-amber-300 dark:text-gold dark:decoration-gold-dim"
						>see the terms</a
					>.
				</span>
			</label>
			{#if fields.tos}<p class="text-xs text-down">{fields.tos}</p>{/if}
		</div>

		<button class="nc-btn" type="submit" disabled={busy}>
			{busy ? 'Dealing you in…' : 'Create account'}
		</button>

		<p class="text-center text-xs text-zinc-600 dark:text-zinc-500">
			Already have chips?
			<a
				href="/auth/login"
				class="text-amber-700 underline decoration-amber-300 dark:text-gold dark:decoration-gold-dim"
				>Log in</a
			>
		</p>
	</form>
</AuthCard>
