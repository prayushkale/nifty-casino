<script lang="ts">
	import type { PageData } from './$types';
	import Skeleton from '$lib/components/game/Skeleton.svelte';
	import { INDEX_LABELS } from '$lib/stores/game';
	import { rankFor } from '$lib/config/ranks';
	import type { LadderUnderlying } from '$lib/config/ladder';

	/**
	 * The board (PLAN §4: "top balances, today's best calls").
	 *
	 * Three sections, all server-rendered from one cached payload. The rank badge
	 * is DERIVED here from `xp` (`$lib/config/ranks`), the same pure function the
	 * profile page and the game page use — a rank is never a stored column, so it
	 * cannot disagree with the number beside it.
	 *
	 * Numbers are static text, not `RollValue`: a board read by a stranger rolls
	 * for nobody, and a tween on 25 rows is 25 rAF loops for no information.
	 */
	export let data: PageData;

	const inr = new Intl.NumberFormat('en-IN');
	const fmt = (n: number): string => inr.format(n);

	/** '27 Aug' from an IST date string — the ⚡ section's "today" caption. */
	const DAY = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
	const day = (iso: string): string => DAY.format(new Date(`${iso}T00:00:00Z`));

	const pct = (winRate: number | null): string =>
		winRate === null ? '—' : `${Math.round(winRate * 100)}%`;

	/** Row rank badge — derived from XP at render time, never stored. */
	const badge = (xp: number): string => {
		const rank = rankFor(xp);
		return `L${rank.level} ${rank.title}`;
	};

	type Tier = 'hit' | 'flat' | 'miss';
	const TIER_BADGE: Record<Tier, string> = { hit: '🎯', flat: '➖', miss: '💀' };
	const TIER_COLOR: Record<Tier, string> = {
		hit: 'border-up/40 bg-up/10 text-up',
		flat: 'border-felt-700 bg-felt-800 text-zinc-400',
		miss: 'border-down/40 bg-down/10 text-down'
	};

	const ordinal = (n: number): string =>
		n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;

	/**
	 * Index display name. A helper rather than a lookup in the markup: `{@const}`
	 * expressions are parsed as plain JS, so a type cast there is a parse error.
	 */
	const indexLabel = (underlying: LadderUnderlying): string => INDEX_LABELS[underlying];
</script>

<svelte:head>
	<title>Leaderboard · NiftyCasino</title>
	<meta
		name="description"
		content="The NiftyCasino board: richest wallets, longest streaks and today's biggest CAS calls."
	/>
</svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-xs font-medium uppercase tracking-widest text-zinc-500">The floor</p>
			<h1 class="text-2xl font-semibold text-gold-glow sm:text-3xl">Leaderboard</h1>
		</div>
		<p class="text-[11px] text-zinc-600">
			Play-money chips only — NC has no cash value. Refreshes every 30s.
		</p>
	</header>

	<!-- Client-side fallback only: SSR always arrives with `data.board`, but a
	     re-navigation on a slow link would otherwise paint an empty shell. -->
	{#if !data.board}
		<div class="flex flex-col gap-4" role="status" aria-label="Loading the leaderboard">
			{#each [0, 1, 2] as i (i)}
				<div class="rounded-xl border border-felt-700 bg-felt-900/80 p-4 shadow-card">
					<div class="nc-skeleton mb-3 h-3.5 w-32" aria-hidden="true" />
					<Skeleton lines={3} label="Loading the board" />
				</div>
			{/each}
		</div>
	{:else}
		<!-- ── 🏆 top balances ─────────────────────────────────────────────────────── -->
		<section class="rounded-xl border border-felt-700 bg-felt-900/80 shadow-card">
			<h2
				class="border-b border-felt-800 px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-400"
			>
				<span aria-hidden="true">🏆</span> Top balances
			</h2>
			{#if data.board.balances.length === 0}
				<p class="px-4 py-6 text-sm text-zinc-500">
					No players yet —
					<a href="/auth/signup" class="text-gold underline decoration-gold-dim"
						>take the first seat.</a
					>
				</p>
			{:else}
				<ol class="divide-y divide-felt-800">
					{#each data.board.balances as row, i (row.handle)}
						<li class="min-h-[44px]">
							<a
								href="/u/{row.handle}"
								class="flex min-h-[44px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-felt-800/60"
							>
								<span
									class="num w-9 shrink-0 text-right text-xs {i === 0
										? 'text-gold'
										: 'text-zinc-600'}">{ordinal(i + 1)}</span
								>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-semibold text-zinc-100"
										>{row.handle}</span
									>
									<span
										class="mt-0.5 block truncate text-[11px] text-zinc-600"
										title={rankFor(row.xp).tagline}>{badge(row.xp)}</span
									>
								</span>
								<span class="shrink-0 text-right">
									<span class="num block text-sm font-semibold text-gold-glow"
										>🪙 {fmt(row.balance)}</span
									>
									<span class="mt-0.5 block text-[11px] text-zinc-600">win {pct(row.winRate)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<!-- ── 🔥 longest streaks ─────────────────────────────────────────────────── -->
		<section class="rounded-xl border border-felt-700 bg-felt-900/80 shadow-card">
			<h2
				class="border-b border-felt-800 px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-400"
			>
				<span aria-hidden="true">🔥</span> Longest streaks
			</h2>
			{#if data.board.streaks.length === 0}
				<p class="px-4 py-6 text-sm text-zinc-500">
					No streaks running — bet on
					<a href="/" class="text-gold underline decoration-gold-dim">a trading day</a> to start one.
				</p>
			{:else}
				<ol class="divide-y divide-felt-800">
					{#each data.board.streaks as row, i (row.handle)}
						<li class="min-h-[44px]">
							<a
								href="/u/{row.handle}"
								class="flex min-h-[44px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-felt-800/60"
							>
								<span
									class="num w-9 shrink-0 text-right text-xs {i === 0
										? 'text-gold'
										: 'text-zinc-600'}">{ordinal(i + 1)}</span
								>
								<span class="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
									{row.handle}
								</span>
								<span
									class="shrink-0 text-right text-[11px] text-zinc-600"
									title={rankFor(row.xp).tagline}>{badge(row.xp)}</span
								>
								<span class="num w-16 shrink-0 text-right text-sm font-semibold text-zinc-100"
									>🔥 {fmt(row.streakDays)}</span
								>
							</a>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<!-- ── ⚡ today's biggest calls ───────────────────────────────────────────── -->
		<section class="rounded-xl border border-felt-700 bg-felt-900/80 shadow-card">
			<h2
				class="flex flex-wrap items-baseline justify-between gap-2 border-b border-felt-800 px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-400"
			>
				<span><span aria-hidden="true">⚡</span> Today's biggest calls</span>
				<span class="text-[11px] font-normal normal-case tracking-normal text-zinc-600"
					>{day(data.board.tradeDate)} · settled</span
				>
			</h2>
			{#if data.board.topWins.length === 0}
				<p class="px-4 py-6 text-sm text-zinc-500">
					Nothing settled today yet — the board fills in once
					<a href="/" class="text-gold underline decoration-gold-dim">the 15:20 cutoff</a> passes.
				</p>
			{:else}
				<ol class="divide-y divide-felt-800">
					{#each data.board.topWins as row, i (i)}
						{@const name = indexLabel(row.underlying)}
						<li class="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
							<span
								class="num w-9 shrink-0 text-right text-xs {i === 0
									? 'text-gold'
									: 'text-zinc-600'}">{ordinal(i + 1)}</span
							>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold text-zinc-100">
									{row.handle}
								</span>
								<span class="mt-0.5 block text-[11px] uppercase tracking-wide text-zinc-600">
									{name}
									<span class={row.targetKind === 'up' ? 'text-up' : 'text-down'}>
										{row.targetKind === 'up' ? '▲' : '▼'}{fmt(row.deltaPoints)}
									</span>
									<span class="text-zinc-700" aria-hidden="true">·</span>
									staked {fmt(row.stake)}
									<span class="text-zinc-700" aria-hidden="true">·</span>
									{row.odds}×
								</span>
							</span>
							<span
								class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide {TIER_COLOR[
									row.tier
								]}"
							>
								<span aria-hidden="true">{TIER_BADGE[row.tier]}</span>
								{row.tier}
							</span>
							<span
								class="num w-20 shrink-0 text-right text-sm font-semibold {row.payout > row.stake
									? 'text-up'
									: row.payout === 0
										? 'text-down'
										: 'text-zinc-400'}"
							>
								{row.payout === 0 ? '—' : `+${fmt(row.payout)}`}
							</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<p class="text-center text-[11px] text-zinc-600">
			<!-- See $lib/server/leaderboard: a weekly board needs a precomputed column
			     the v1 data model deliberately does not have, so v1 ships all-time only. -->
			All-time boards in v1 — weekly rankings land with the precomputed rollups.
		</p>
	{/if}
</div>
