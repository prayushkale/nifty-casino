<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import '../app.css';
	import BalanceChip from '$lib/components/game/BalanceChip.svelte';
	import CountdownPill from '$lib/components/game/CountdownPill.svelte';
	import MobileBottomNav from '$lib/components/game/MobileBottomNav.svelte';
	import PotTicker from '$lib/components/game/PotTicker.svelte';
	import Toaster from '$lib/components/game/Toaster.svelte';
	import type { StatePayload } from '$lib/server/state';
	import {
		bettingPhase,
		gameState,
		loadState,
		nowIst,
		startClock,
		seedState
	} from '$lib/stores/game';

	/**
	 * The chrome, with the three fixed anchors §4 demands: balance top-right, pot in
	 * the top bar, bottom nav on mobile.
	 *
	 * `me` is the auth chrome's source of truth (T6) and stays a fetch — it is the
	 * only thing that says who is logged in. The money is `/api/state`'s: it comes
	 * from the page's own `load` when there is one, and from the shared game store
	 * once the client has read it, so a bet placed on the game page moves the chip in
	 * the bar without a navigation.
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
		// A signed-in player landing anywhere but the game page still gets the real
		// anchors, not an empty chip. One request, and only when nothing has read
		// `/api/state` yet — the game page's `load` already did the work.
		if (me?.authenticated && $gameState === null) await loadState();
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

	onMount(() => {
		const stopClock = startClock();
		return stopClock;
	});
	afterNavigate(refresh);

	/**
	 * The page's own payload — the game page ships one, other pages do not. Seeding
	 * is browser-only, and deliberately so: on the server the module store is shared
	 * by every concurrent request, and writing one request's wallet into it would
	 * show player A's balance to player B. Server renders read `pageState` directly.
	 */
	$: pageState = ($page.data as { state?: StatePayload } | undefined)?.state ?? null;
	$: if (browser && pageState) seedState(pageState);
	$: state = $gameState ?? pageState;
	$: phase = state === null ? null : bettingPhase(state, $nowIst);
	$: handle = state?.user?.handle ?? (me?.authenticated ? me.handle : null);
</script>

<header class="sticky top-0 z-20 border-b border-felt-700 bg-felt-950/85 backdrop-blur">
	<div class="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
		<a href="/" class="shrink-0 text-base font-bold tracking-tight text-gold-glow">
			Nifty<span class="text-zinc-200">Casino</span>
		</a>

		<!-- The desktop bar carries everything; mobile repeats the money row below. -->
		<div class="hidden items-center gap-2 md:flex">
			{#if state && phase}
				<CountdownPill
					{phase}
					now={$nowIst}
					cutoffAtMs={state.session.cutoffAtMs}
					tradeDate={state.tradeDate}
				/>
			{/if}
			<PotTicker pot={state?.pot.today ?? null} />
			<BalanceChip balance={state?.user?.balance ?? null} {handle} />
		</div>

		<nav class="flex items-center gap-2">
			{#if me?.authenticated && me.handle}
				<div class="md:hidden">
					<BalanceChip balance={state?.user?.balance ?? null} {handle} />
				</div>
				<a
					href={`/u/${me.handle}`}
					class="nc-chip hidden sm:inline-flex"
					title="Your public profile"
				>
					{me.handle}
				</a>
				<button class="nc-btn-ghost" type="button" on:click={logout} disabled={busy}>
					{busy ? '…' : 'Log out'}
				</button>
			{:else}
				<div class="md:hidden">
					<BalanceChip balance={null} handle={null} />
				</div>
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

	<!-- Mobile money row: countdown + pot, always visible while the table is open. -->
	<div
		class="flex items-center justify-between gap-2 border-t border-felt-800 px-4 py-1.5 md:hidden"
	>
		{#if state && phase}
			<CountdownPill
				{phase}
				now={$nowIst}
				cutoffAtMs={state.session.cutoffAtMs}
				tradeDate={state.tradeDate}
			/>
		{:else}
			<span class="text-xs text-zinc-600">NiftyCasino</span>
		{/if}
		<PotTicker pot={state?.pot.today ?? null} />
	</div>
</header>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col px-4">
	<slot />

	<footer class="mt-auto border-t border-felt-800 py-6 text-center text-xs text-zinc-600">
		Play-money entertainment only — no real money, no cash-out, 18+.
		<a href="/terms" class="underline decoration-zinc-700">Terms</a>
		<span class="mx-1.5 text-felt-700" aria-hidden="true">·</span>
		<a href="/leaderboard" class="underline decoration-zinc-700">Leaderboard</a>
		<span class="mx-1.5 text-felt-700" aria-hidden="true">·</span>
		<a href="/history" class="underline decoration-zinc-700">History</a>
	</footer>
	<!-- Room for the fixed mobile nav so it never covers the footer. -->
	<div class="h-16 md:hidden" aria-hidden="true" />
</div>

<Toaster />
<MobileBottomNav {handle} />
