<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import '../app.css';

	/**
	 * Shape of GET /api/auth/me — the header chrome's only source of truth.
	 * Fetched on mount and after every client-side navigation, so logging in or
	 * out from any page updates the bar without a full reload.
	 */
	type Me = {
		authenticated: boolean;
		handle: string | null;
		source: 'supabase' | 'dev' | null;
		devAuth: boolean;
	};

	let me: Me | null = null;
	let busy = false;

	async function refresh(): Promise<void> {
		try {
			const res = await fetch('/api/auth/me', { headers: { accept: 'application/json' } });
			if (res.ok) me = (await res.json()) as Me;
		} catch {
			/* offline — the bar just stays signed out */
		}
	}

	async function logout(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await fetch('/api/auth/logout', { method: 'POST' });
			await refresh();
		} finally {
			busy = false;
		}
	}

	onMount(refresh);
	afterNavigate(refresh);
</script>

<header class="sticky top-0 z-20 border-b border-felt-700 bg-felt-950/85 backdrop-blur">
	<div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5">
		<a href="/" class="text-base font-bold tracking-tight text-gold-glow">
			Nifty<span class="text-zinc-200">Casino</span>
		</a>

		<nav class="flex items-center gap-2">
			{#if me?.authenticated && me.handle}
				<a href="/" class="nc-chip" title={`Logged in via ${me.source ?? 'session'}`}>
					<span class="text-gold-glow">🪙</span>
					{me.handle}
				</a>
				<button class="nc-btn-ghost" type="button" on:click={logout} disabled={busy}>
					{busy ? '…' : 'Log out'}
				</button>
			{:else}
				<a href="/auth/login" class="nc-btn-ghost">Log in</a>
				<a
					href="/auth/signup"
					class="rounded-lg bg-gold px-3 py-1.5 text-sm font-semibold text-felt-950 transition hover:bg-gold-glow"
				>
					Sign up
				</a>
			{/if}
		</nav>
	</div>
</header>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col px-4">
	<slot />

	<footer class="mt-auto border-t border-felt-800 py-6 text-center text-xs text-zinc-600">
		Play-money entertainment only — no real money, no cash-out, 18+.
		<a href="/terms" class="underline decoration-zinc-700">Terms</a>
	</footer>
</div>
