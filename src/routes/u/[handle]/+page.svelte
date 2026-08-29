<script lang="ts">
	import type { PageData } from './$types';
	import Skeleton from '$lib/components/game/Skeleton.svelte';

	/** The three verdicts a settled bet can carry — kept local so this page needs no server import. */
	type Tier = 'hit' | 'flat' | 'miss';

	// The payload of `$lib/server/profile` — already public-only by construction.
	export let data: PageData;

	const inr = new Intl.NumberFormat('en-IN');
	const fmt = (n: number): string => inr.format(n);

	/** IST date → "27 Aug 2026", for the joined line and the bet strip. */
	const DAY = new Intl.DateTimeFormat('en-IN', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const day = (iso: string): string => DAY.format(new Date(`${iso}T00:00:00Z`));

	const TIER_BADGE: Record<Tier, string> = { hit: '🎯', flat: '➖', miss: '💀' };
	const TIER_LABEL: Record<Tier, string> = { hit: 'hit', flat: 'flat', miss: 'miss' };
	const TIER_COLOR: Record<Tier, string> = {
		hit: 'border-up/40 bg-up/10 text-up',
		flat: 'border-felt-700 bg-felt-800 text-zinc-400',
		miss: 'border-down/40 bg-down/10 text-down'
	};

	// Ring geometry: r = 15.5 on a 36-unit viewBox → ~97.4 units of circumference.
	const RING_CIRCUMFERENCE = 97.4;

	$: profile = data.profile;
	$: winPercent =
		profile?.winRate === null || profile === undefined
			? null
			: Math.round((profile.winRate ?? 0) * 100);
	$: ringFill =
		profile && profile.winRate !== null
			? Math.max(0, Math.min(1, profile.winRate)) * RING_CIRCUMFERENCE
			: 0;
</script>

<svelte:head>
	<title>{profile ? `${profile.handle} · NiftyCasino` : 'NiftyCasino'}</title>
	<meta
		name="description"
		content={profile
			? `${profile.handle}'s public NiftyCasino record.`
			: 'A public NiftyCasino player record.'}
	/>
</svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
	<!-- Client navigation fallback: SSR always has `data.profile`, but a navigation
	     that re-runs `load` on a slow link would otherwise render an empty shell.
	     Same skeleton vocabulary as the game page, so "loading" looks like loading. -->
	{#if !profile}
		<div class="flex flex-col gap-4" role="status" aria-label="Loading profile">
			<div class="flex items-center justify-between gap-3">
				<Skeleton lines={2} label="Loading the player's name" />
				<div class="nc-skeleton h-7 w-24 rounded-full" aria-hidden="true" />
			</div>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each [0, 1, 2, 3] as i (i)}
					<div class="nc-skeleton h-24 rounded-xl" aria-hidden="true" />
				{/each}
			</div>
			<div class="nc-skeleton h-28 rounded-xl" aria-hidden="true" />
		</div>
	{:else}
		<!-- ── identity ─────────────────────────────────────────────────────────────── -->
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div class="min-w-0">
				<p class="text-xs font-medium uppercase tracking-widest text-zinc-500">Player profile</p>
				<h1 class="truncate text-2xl font-semibold text-gold-glow sm:text-3xl">
					{profile.handle}
				</h1>
				<p class="mt-1 text-xs text-zinc-500">At the tables since {day(profile.joined)}</p>
			</div>
			<!-- The rank is DERIVED from `xp` on the server, never stored, so it cannot
		     disagree with the number beside it. -->
			<span class="nc-chip" title={profile.rank.tagline}>
				<span aria-hidden="true">🎖</span>
				<span class="num">L{profile.rank.level}</span>
				<span class="text-felt-700" aria-hidden="true">·</span>
				{profile.rank.title}
			</span>
		</header>

		<!-- ── the four numbers a rival checks first ────────────────────────────────── -->
		<section
			class="grid grid-cols-2 gap-3 sm:grid-cols-4"
			aria-label="Balance, streak, experience and win rate"
		>
			<div class="rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card">
				<p class="nc-label mb-1">Balance</p>
				<p class="num text-xl font-semibold text-gold-glow">🪙 {fmt(profile.balance)}</p>
				<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-600">NC chips</p>
			</div>

			<div class="rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card">
				<p class="nc-label mb-1">Streak</p>
				<p class="num text-xl font-semibold text-zinc-100">🔥 {fmt(profile.streakDays)}</p>
				<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-600">
					{profile.streakDays === 1 ? 'day' : 'days'}
				</p>
			</div>

			<div class="rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card">
				<p class="nc-label mb-1">XP</p>
				<p class="num text-xl font-semibold text-zinc-100">{fmt(profile.xp)}</p>
				<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-600">experience</p>
			</div>

			<!-- Win rate as a ring: one glance, no axis, no labels to translate. -->
			<div
				class="flex items-center gap-3 rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card"
			>
				<svg
					viewBox="0 0 36 36"
					class="h-14 w-14 shrink-0 -rotate-90"
					role="img"
					aria-label="Win rate ring"
				>
					<circle cx="18" cy="18" r="15.5" fill="none" stroke-width="4" class="stroke-felt-700" />
					{#if ringFill > 0}
						<circle
							cx="18"
							cy="18"
							r="15.5"
							fill="none"
							stroke-width="4"
							stroke-linecap="round"
							stroke-dasharray="{ringFill.toFixed(1)} {RING_CIRCUMFERENCE}"
							class="stroke-gold"
						/>
					{/if}
				</svg>
				<div>
					<p class="nc-label mb-1">Win rate</p>
					<p class="num text-xl font-semibold text-zinc-100">
						{winPercent === null ? '—' : `${winPercent}%`}
					</p>
					<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-600">
						{fmt(profile.totals.betsWon)}/{fmt(profile.totals.betsPlaced)}
					</p>
				</div>
			</div>
		</section>

		<!-- ── all-time money ──────────────────────────────────────────────────────── -->
		<section class="rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card">
			<h2 class="nc-label mb-3">All-time</h2>
			<dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-5">
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Bets placed</dt>
					<dd class="num text-zinc-100">{fmt(profile.totals.betsPlaced)}</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Bets won</dt>
					<dd class="num text-up">{fmt(profile.totals.betsWon)}</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">NC staked</dt>
					<dd class="num text-zinc-100">{fmt(profile.totals.totalStaked)}</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">NC won</dt>
					<dd class="num text-gold-glow">{fmt(profile.totals.totalWon)}</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Best payout</dt>
					<dd class="num text-gold-glow">{fmt(profile.totals.bestPayout)}</dd>
				</div>
			</dl>
		</section>

		<!-- ── recent settled bets ─────────────────────────────────────────────────── -->
		<section class="rounded-xl border border-felt-700 bg-felt-900/80 shadow-card">
			<h2
				class="border-b border-felt-800 px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-400"
			>
				Recent bets
			</h2>

			{#if profile.recentBets.length === 0}
				<p class="px-4 py-6 text-sm text-zinc-500">
					No settled bets yet —
					<a href="/" class="text-gold underline decoration-gold-dim">the tables are open.</a>
				</p>
			{:else}
				<ul class="divide-y divide-felt-800">
					{#each profile.recentBets as bet, i (i)}
						<li class="flex items-center justify-between gap-3 px-4 py-3">
							<div class="min-w-0">
								<p class="text-sm font-semibold uppercase tracking-wide text-zinc-200">
									{bet.underlying}
									<span class="ml-1 {bet.targetKind === 'up' ? 'text-up' : 'text-down'}">
										{bet.targetKind === 'up' ? '▲' : '▼'}{fmt(bet.deltaPoints)}
									</span>
								</p>
								<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-600">
									{bet.settledOn} · staked {fmt(bet.stake)} NC
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-3">
								<span
									class="rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide {TIER_COLOR[
										bet.tier
									]}"
								>
									<span aria-hidden="true">{TIER_BADGE[bet.tier]}</span>
									{TIER_LABEL[bet.tier]}
								</span>
								<span
									class="num w-16 text-right text-sm {bet.payout > bet.stake
										? 'text-up'
										: bet.payout === 0
											? 'text-down'
											: 'text-zinc-400'}"
								>
									{bet.payout === 0 ? '—' : `+${fmt(bet.payout)}`}
								</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<p class="text-center text-[11px] text-zinc-600">
			Play-money record only — NC chips have no cash value. Public profile by design.
		</p>
	{/if}
</div>
