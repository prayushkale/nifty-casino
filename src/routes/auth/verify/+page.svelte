<script lang="ts">
	import { page } from '$app/stores';
	import AuthCard from '$lib/components/AuthCard.svelte';
	import { resolveSupabaseBrowserConfig } from '$lib/supabaseBrowser';

	// Null ⇒ no Supabase project: the dev fallback is what is live here.
	const devMode = resolveSupabaseBrowserConfig() === null;

	let email = $page.url.searchParams.get('email') ?? '';
	let resent = false;
	let error = '';
	let busy = false;

	async function resend() {
		if (busy || email.trim() === '') return;
		busy = true;
		error = '';
		resent = false;
		try {
			const res = await fetch('/api/auth/resend', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email })
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) error = data.error ?? 'Could not resend.';
			else resent = true;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Verify your email · NiftyCasino</title>
</svelte:head>

<AuthCard title="Check your inbox" subtitle="One click and your 1,000 NC are waiting at the table.">
	<div class="flex flex-col gap-4 text-sm text-zinc-300">
		{#if devMode}
			<p class="nc-ok">
				<strong class="font-semibold">Dev mode:</strong> this deployment has no Supabase project, so
				signups skip email entirely — your handle is already live.
				<a href="/auth/login" class="text-gold underline decoration-gold-dim">Go log in</a>.
			</p>
		{:else}
			<p>
				We sent a confirmation link to
				<span class="font-medium text-gold">{email || 'your email'}</span>. Open it on this device
				to finish signing up.
			</p>

			<div>
				<label class="nc-label" for="verify-email">Wrong address, or nothing arrived?</label>
				<input
					id="verify-email"
					class="nc-input"
					type="email"
					placeholder="you@example.com"
					bind:value={email}
				/>
			</div>

			<button class="nc-btn" type="button" on:click={resend} disabled={busy || email.trim() === ''}>
				{busy ? 'Sending…' : 'Resend the link'}
			</button>

			{#if resent}
				<p class="nc-ok">Sent. Give it a minute, then check spam.</p>
			{/if}
			{#if error}
				<p class="nc-alert">{error}</p>
			{/if}

			<p class="text-xs text-zinc-500">
				Confirmed already?
				<a href="/auth/login" class="text-gold underline decoration-gold-dim">Log in</a>
			</p>
		{/if}
	</div>
</AuthCard>
