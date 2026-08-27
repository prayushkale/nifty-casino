<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import AuthCard from '$lib/components/AuthCard.svelte';
	import { resolveSupabaseBrowserConfig } from '$lib/supabaseBrowser';

	// Null ⇒ no Supabase project on this deployment, so the dev panel is what works.
	const devMode = resolveSupabaseBrowserConfig() === null;

	// /auth/confirm sends failed confirmations here as a readable banner.
	const banner = $page.url.searchParams.get('error') ?? '';

	let email = '';
	let password = '';
	let error = '';
	let busy = false;

	async function login() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, password })
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				error =
					data.error === 'AUTH_NOT_CONFIGURED'
						? 'Auth is not configured here — use the dev panel below.'
						: (data.error ?? 'Could not log in.');
				return;
			}
			await goto('/');
		} finally {
			busy = false;
		}
	}

	/**
	 * Dev panel state. It posts to /api/auth/signup, which is the unauthenticated
	 * identity-claim endpoint behind the "Supabase unconfigured" guard (see
	 * $lib/server/auth/devAuth): pick any handle and you are that player, which is
	 * exactly what makes local multi-player testing trivial. The server re-checks
	 * the guard on every call, so the panel cannot work against a real deployment —
	 * that answers 400 AUTH_NOT_CONFIGURED and the form above says so.
	 */
	let devHandle = '';
	let devTos = false;
	let devError = '';
	let devBusy = false;

	async function enterCasino() {
		if (devBusy || devHandle.trim() === '') return;
		devBusy = true;
		devError = '';
		try {
			const res = await fetch('/api/auth/signup', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// The endpoint still validates email/password/tos, so the panel mints
				// throwaway values: dev auth never reads them.
				body: JSON.stringify({
					email: `dev-${crypto.randomUUID()}@niftycasino.local`,
					password: crypto.randomUUID(),
					handle: devHandle.trim(),
					tos: devTos
				})
			});
			const data = (await res.json().catch(() => ({}))) as {
				error?: string;
				fields?: Record<string, string>;
			};
			if (!res.ok) {
				devError = data.fields?.handle ?? data.fields?.tos ?? data.error ?? 'Could not enter.';
				return;
			}
			await goto('/');
		} finally {
			devBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Log in · NiftyCasino</title>
</svelte:head>

<AuthCard title="Back to the tables" subtitle="Your chips are where you left them.">
	{#if banner}
		<p class="nc-alert mb-4">{banner}</p>
	{/if}

	<form class="flex flex-col gap-4" on:submit|preventDefault={login}>
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
		<div>
			<label class="nc-label" for="password">Password</label>
			<input
				id="password"
				class="nc-input"
				type="password"
				autocomplete="current-password"
				bind:value={password}
				required
			/>
		</div>

		{#if error}
			<p class="nc-alert">{error}</p>
		{/if}

		<button class="nc-btn" type="submit" disabled={busy}>
			{busy ? 'Checking…' : 'Log in'}
		</button>

		<p class="flex justify-between text-xs text-zinc-500">
			<a href="/auth/forgot" class="text-gold underline decoration-gold-dim">Forgot password?</a>
			<a href="/auth/signup" class="text-gold underline decoration-gold-dim">Create an account</a>
		</p>
	</form>
</AuthCard>

{#if devMode}
	<div class="mx-auto w-full max-w-md pb-16">
		<div class="rounded-xl border border-dashed border-gold-dim/50 bg-felt-900/60 p-6">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-gold">Dev login</h2>
			<p class="mt-1.5 text-xs text-zinc-500">
				No Supabase project is configured, so handles are claimed directly. Any handle works — an
				existing one logs that player in, which is how you test two players at once.
			</p>
			<form class="mt-4 flex flex-col gap-3" on:submit|preventDefault={enterCasino}>
				<input
					class="nc-input"
					type="text"
					placeholder="handle (blank = trader0000-style)"
					aria-label="Handle"
					bind:value={devHandle}
				/>
				<label class="flex items-start gap-2.5 text-xs text-zinc-400">
					<input type="checkbox" class="mt-0.5 h-4 w-4 accent-gold" bind:checked={devTos} />
					<span>
						I'm 18+, play-money only —
						<a href="/terms" class="text-gold underline">terms</a>
					</span>
				</label>
				{#if devError}
					<p class="nc-alert">{devError}</p>
				{/if}
				<button class="nc-btn" type="submit" disabled={devBusy || !devTos}>
					{devBusy ? 'Seating you…' : 'Enter casino'}
				</button>
			</form>
		</div>
	</div>
{/if}
