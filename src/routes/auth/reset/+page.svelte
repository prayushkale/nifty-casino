<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthCard from '$lib/components/AuthCard.svelte';

	let password = '';
	let confirm = '';
	let error = '';
	let fields: Record<string, string> = {};
	let busy = false;

	async function submit() {
		if (busy) return;
		if (password !== confirm) {
			fields = { password: 'The two passwords do not match.' };
			return;
		}
		busy = true;
		error = '';
		fields = {};
		try {
			const res = await fetch('/api/auth/reset', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password })
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				error = data.error ?? 'Could not update the password.';
				return;
			}
			await goto('/');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Set a new password · NiftyCasino</title>
</svelte:head>

<AuthCard
	title="Set a new password"
	subtitle="This page only works right after opening the link we emailed you."
>
	<form class="flex flex-col gap-4" on:submit|preventDefault={submit}>
		<div>
			<label class="nc-label" for="password">New password</label>
			<input
				id="password"
				class="nc-input"
				type="password"
				autocomplete="new-password"
				bind:value={password}
				required
			/>
		</div>
		<div>
			<label class="nc-label" for="confirm">Repeat it</label>
			<input
				id="confirm"
				class="nc-input"
				type="password"
				autocomplete="new-password"
				bind:value={confirm}
				required
			/>
		</div>

		{#if fields.password}
			<p class="nc-alert">{fields.password}</p>
		{/if}
		{#if error}
			<p class="nc-alert">
				{error}
				{#if /session|expired|token/i.test(error)}
					— request a fresh link from
					<a href="/auth/forgot" class="text-gold underline">forgot password</a>.
				{/if}
			</p>
		{/if}

		<button class="nc-btn" type="submit" disabled={busy}>
			{busy ? 'Saving…' : 'Save new password'}
		</button>
	</form>
</AuthCard>
