<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import '../app.css';
	import BalanceChip from '$lib/components/game/BalanceChip.svelte';
	import CountdownPill from '$lib/components/game/CountdownPill.svelte';
	import MobileBottomNav from '$lib/components/game/MobileBottomNav.svelte';
	import PotTicker from '$lib/components/game/PotTicker.svelte';
	import Toaster from '$lib/components/game/Toaster.svelte';
	import { theme } from '$lib/stores/theme';
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
			// Drop the wallet snapshot — it belongs to the signed-out player, and
			// the next paint must not flash their balance before `refresh` lands.
			gameState.set(null);
			me = null;
			await invalidateAll();
			await refresh();
			await goto('/', { invalidateAll: true });
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		theme.init();
		const stopClock = startClock();
		// `afterNavigate` only fires on client-side navigations, so the very first
		// paint would otherwise leave `me` null — and the header showing Log in /
		// Sign up — even for a player whose SSR state already has them signed in.
		void refresh();
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
	// Auth display state. `me` is the session truth, but it only arrives after a
	// client fetch — on first paint it is still null while the SSR `state` may
	// already carry the signed-in wallet. Either one proves signed-in; requiring
	// `me` alone is what stuck the header on Log in / Sign up after login.
	$: signedIn = state?.user ? true : (me?.authenticated ?? false);
	$: handle = state?.user?.handle ?? (me?.authenticated ? me.handle : null);
	$: isLight = $theme === 'light';
	$: pathname = $page.url.pathname;
	/** Desktop primary nav — the footer + mobile bottom nav already cover small screens. */
	$: navLink = (href: string): string => {
		const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
		const base =
			'inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 text-sm font-medium transition';
		if (active) return `${base} ${isLight ? 'bg-zinc-100 text-zinc-900' : 'bg-felt-800 text-gold'}`;
		return `${base} ${isLight ? 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900' : 'text-zinc-400 hover:bg-felt-800 hover:text-zinc-100'}`;
	};
</script>

<header
	class="sticky top-0 z-20 border-b backdrop-blur {isLight
		? 'border-zinc-200 bg-white/90'
		: 'border-felt-700 bg-felt-950/85'}"
>
	<div
		class="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-2.5 lg:px-6 xl:px-8"
	>
		<a
			href="/"
			class="shrink-0 text-lg font-extrabold tracking-tight sm:text-xl {isLight
				? 'text-zinc-900'
				: 'text-gold-glow'}"
			aria-label="NiftyCASino home"
		>
			Nifty<span class={isLight ? 'font-black text-amber-600' : 'text-gold'}>CAS</span><span
				class={isLight ? 'text-zinc-800' : 'text-zinc-200'}>ino</span
			>
		</a>

		<!-- Primary nav: always-visible way back to the game + the other main pages.
		     Mobile gets the same destinations from the fixed bottom nav. -->
		<nav class="hidden items-center gap-1 lg:flex" aria-label="Primary">
			<a href="/" class={navLink('/')} aria-current={pathname === '/' ? 'page' : undefined}>
				<span aria-hidden="true">🎰</span> Game
			</a>
			<a
				href="/leaderboard"
				class={navLink('/leaderboard')}
				aria-current={pathname.startsWith('/leaderboard') ? 'page' : undefined}
			>
				<span aria-hidden="true">🏆</span> Board
			</a>
			{#if signedIn}
				<a
					href="/history"
					class={navLink('/history')}
					aria-current={pathname.startsWith('/history') ? 'page' : undefined}
				>
					<span aria-hidden="true">🧾</span> History
				</a>
			{/if}
		</nav>

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
			<button
				type="button"
				class="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition {isLight
					? 'border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400'
					: 'border-felt-700 bg-felt-900 text-zinc-300 hover:border-zinc-600'}"
				aria-label="Toggle light or dark mode"
				title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
				on:click={() => theme.toggle()}
			>
				<span aria-hidden="true">{isLight ? '🌙' : '☀️'}</span>
				<span class="hidden sm:inline">{isLight ? 'Dark' : 'Light'}</span>
			</button>
			{#if signedIn}
				<div class="md:hidden">
					<BalanceChip balance={state?.user?.balance ?? null} {handle} />
				</div>
				{#if handle}
					<a
						href={`/u/${handle}`}
						class="nc-chip hidden sm:inline-flex"
						title="Your public profile"
					>
						{handle}
					</a>
				{/if}
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
		class="flex items-center justify-between gap-2 border-t px-4 py-1.5 md:hidden {isLight
			? 'border-zinc-200 bg-zinc-50'
			: 'border-felt-800 bg-transparent'}"
	>
		{#if state && phase}
			<CountdownPill
				{phase}
				now={$nowIst}
				cutoffAtMs={state.session.cutoffAtMs}
				tradeDate={state.tradeDate}
			/>
		{:else}
			<span class="text-sm font-bold tracking-tight {isLight ? 'text-zinc-700' : 'text-zinc-400'}"
				>Nifty<span class={isLight ? 'text-amber-600' : 'text-gold'}>CAS</span>ino</span
			>
		{/if}
		<PotTicker pot={state?.pot.today ?? null} />
	</div>
</header>

<div class="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-4 lg:px-6 xl:px-8">
	<slot />

	<footer
		class="mt-auto border-t py-6 text-center text-sm {isLight
			? 'border-zinc-200 text-zinc-500'
			: 'border-felt-800 text-zinc-500'}"
	>
		Play-money entertainment only — no real money, no cash-out, 18+.
		<a href="/terms" class="underline decoration-zinc-400 dark:decoration-zinc-700">Terms</a>
		<span class="mx-1.5 {isLight ? 'text-zinc-300' : 'text-felt-700'}" aria-hidden="true">·</span>
		<a href="/leaderboard" class="underline decoration-zinc-400 dark:decoration-zinc-700"
			>Leaderboard</a
		>
		<span class="mx-1.5 {isLight ? 'text-zinc-300' : 'text-felt-700'}" aria-hidden="true">·</span>
		<a href="/history" class="underline decoration-zinc-400 dark:decoration-zinc-700">History</a>
	</footer>
	<!-- Room for the fixed mobile nav so it never covers the footer. -->
	<div class="h-16 md:hidden" aria-hidden="true" />
</div>

<Toaster />
<MobileBottomNav {handle} />
