<script lang="ts">
	import AuthCard from '$lib/components/AuthCard.svelte';

	let email = '';
	let sent = false;
	let error = '';
	let busy = false;

	async function submit() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/auth/forgot', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email })
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				error =
					data.error === 'AUTH_NOT_CONFIGURED'
						? 'Auth is not configured on this deployment.'
						: (data.error ?? 'Could not send the reset link.');
				return;
			}
			sent = true;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Reset your password · NiftyCasino</title>
</svelte:head>

<AuthCard title="Forgot your password" subtitle="We'll email you a link to set a new one.">
	{#if sent}
		<div class="flex flex-col gap-4 text-sm text-zinc-300">
			<p class="nc-ok">
				If <span class="font-medium text-gold">{email}</span> has an account, a reset link is on its
				way. It opens on this device, then you pick a new password.
			</p>
			<p class="text-xs text-zinc-500">
				Nothing arrived?
				<a href="/auth/login" class="text-gold underline decoration-gold-dim">Back to login</a>
			</p>
		</div>
	{:else}
		<form class="flex flex-col gap-4" on:submit|preventDefault={submit}>
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
			</div>
			{#if error}
				<p class="nc-alert">{error}</p>
			{/if}
			<button class="nc-btn" type="submit" disabled={busy}>
				{busy ? 'Sending…' : 'Send reset link'}
			</button>
			<p class="text-center text-xs text-zinc-500">
				<a href="/auth/login" class="text-gold underline decoration-gold-dim">Back to login</a>
			</p>
		</form>
	{/if}
</AuthCard>
