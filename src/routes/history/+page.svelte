<script lang="ts">
	import type { PageData } from './$types';
	import SubpageNav from '$lib/components/game/SubpageNav.svelte';
	import { INDEX_LABELS } from '$lib/stores/game';
	import { istDateStr, secOfDayIst } from '$lib/time/ist';
	import type { LadderUnderlying } from '$lib/config/ladder';
	import type { HistoryBet, HistoryPage } from '$lib/server/history';

	/**
	 * The player's own bet log (PLAN §4: "/history (own bet log)").
	 *
	 * The FIRST page arrives with SSR (`data.page`); "Load more" fetches the next
	 * one from `GET /api/history` with the cursor that page carried, so the log
	 * grows client-side without re-running the whole page load. Pages are appended
	 * in cursor order, which is why the client never sorts: the server already
	 * ordered them newest first.
	 *
	 * Filters are CLIENT-SIDE over the pages loaded so far — deliberate. They say
	 * "of what you are looking at", and they cost no request; a filter that fetched
	 * server-side would need four more read paths for no information the player
	 * cannot get by scrolling.
	 */
	export let data: PageData;

	const inr = new Intl.NumberFormat('en-IN');
	const fmt = (n: number): string => inr.format(n);

	const DAY = new Intl.DateTimeFormat('en-IN', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	});
	/** 'YYYY-MM-DD' → '27 Aug 2026'. */
	const day = (iso: string): string => DAY.format(new Date(`${iso}T00:00:00Z`));

	/**
	 * '27 Aug 2026 · 15:04' — the IST wall clock the bet was placed at, computed
	 * with the app's own UTC-shift arithmetic (`$lib/time/ist`) rather than Intl
	 * time zones, so a runtime with a thin ICU build renders the same minute.
	 */
	const stamp = (ms: number): string => {
		const at = new Date(ms);
		const sec = Math.floor(secOfDayIst(at));
		const pad = (n: number): string => String(n).padStart(2, '0');
		return `${day(istDateStr(at))} · ${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}`;
	};

	type Tier = 'hit' | 'flat' | 'miss';
	const TIER_BADGE: Record<Tier, string> = { hit: '🎯', flat: '➖', miss: '💀' };
	const TIER_LABEL: Record<Tier, string> = { hit: 'HIT', flat: 'FLAT', miss: 'MISS' };
	const TIER_COLOR: Record<Tier, string> = {
		hit: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-up/40 dark:bg-up/10 dark:text-up',
		flat: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400',
		miss: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:border-down/40 dark:bg-down/10 dark:text-down'
	};

	const TONES: Record<Tier, string> = {
		hit: 'text-emerald-600 dark:text-up',
		flat: 'text-zinc-500 dark:text-zinc-400',
		miss: 'text-rose-600 dark:text-down'
	};

	/**
	 * Index display name. A helper rather than a lookup in the markup: `{@const}`
	 * expressions are parsed as plain JS, so a type cast there is a parse error.
	 */
	const indexLabel = (underlying: LadderUnderlying): string => INDEX_LABELS[underlying];

	/** The verdict line for one row: LIVE while unsettled, else the recorded outcome. */
	function verdictOf(bet: HistoryBet): {
		badge: string;
		label: string;
		amount: string;
		tone: string;
		amountTone: string;
	} {
		if (bet.settlementTier === null || bet.settlementTier === undefined) {
			return {
				badge: '⏳',
				label: 'LIVE',
				amount: '—',
				amountTone: 'text-zinc-500 dark:text-zinc-600',
				tone: 'border-gold-dim/50 bg-gold/10 text-amber-700 dark:text-gold'
			};
		}
		const tier = bet.settlementTier as Tier;
		const payout = bet.payout ?? 0;
		const amount =
			tier === 'hit'
				? `+${fmt(payout)}`
				: tier === 'flat'
					? `±${fmt(payout)}`
					: `−${fmt(bet.stake)}`;
		return {
			badge: TIER_BADGE[tier],
			label: TIER_LABEL[tier],
			amount,
			amountTone: TONES[tier],
			tone: TIER_COLOR[tier]
		};
	}

	// ── filters ────────────────────────────────────────────────────────────────
	type Filter = 'all' | 'hit' | 'miss' | 'flat' | 'live';
	const FILTERS: readonly { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'hit', label: 'Hits' },
		{ id: 'miss', label: 'Misses' },
		{ id: 'flat', label: 'Flats' },
		{ id: 'live', label: 'Live' }
	];
	let filter: Filter = 'all';

	// ── the loaded pages ───────────────────────────────────────────────────────
	let bets: HistoryBet[] = data.page.bets;
	let cursor: HistoryPage['nextCursor'] = data.page.nextCursor;
	let loadingMore = false;
	let loadError = '';

	// A new page load (a re-navigation, an invalidated payload) resets the log —
	// the client never mixes rows from two payloads.
	let seededFor: HistoryPage | null = null;
	$: if (seededFor !== data.page) {
		seededFor = data.page;
		bets = data.page.bets;
		cursor = data.page.nextCursor;
		loadError = '';
	}

	$: counts = bets.reduce<Record<Filter, number>>(
		(acc, bet) => {
			acc.all += 1;
			if (bet.settlementTier === null) acc.live += 1;
			else acc[bet.settlementTier as Tier] += 1;
			return acc;
		},
		{ all: 0, hit: 0, miss: 0, flat: 0, live: 0 }
	);
	$: visible = bets.filter((bet) => {
		if (filter === 'all') return true;
		if (filter === 'live') return bet.settlementTier === null;
		return bet.settlementTier === filter;
	});

	async function loadMore(): Promise<void> {
		if (cursor === null || loadingMore) return;
		loadingMore = true;
		loadError = '';
		try {
			const params = new URLSearchParams({ before: cursor.before, beforeId: cursor.beforeId });
			const res = await fetch(`/api/history?${params.toString()}`, {
				headers: { accept: 'application/json' }
			});
			if (!res.ok) throw new Error(`GET /api/history → ${res.status}`);
			const page = (await res.json()) as HistoryPage;
			bets = [...bets, ...page.bets];
			cursor = page.nextCursor;
		} catch {
			loadError = 'Could not load more bets — try again.';
		} finally {
			loadingMore = false;
		}
	}
</script>

<svelte:head>
	<title>Your bets · NiftyCasino</title>
	<meta name="description" content="Your own NiftyCasino bet log: every call, settled or live." />
</svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
	<SubpageNav />
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-xs font-medium uppercase tracking-widest text-zinc-500">Your record</p>
			<h1 class="text-2xl font-semibold text-amber-600 dark:text-gold-glow sm:text-3xl">
				Bet history
			</h1>
		</div>
	</header>

	<!-- ── personal totals — the same numbers the public profile shows, but yours ── -->
	<section class="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Your totals">
		<div class="nc-card p-4">
			<p class="nc-label mb-1">Bets</p>
			<p class="num text-xl font-semibold text-zinc-900 dark:text-zinc-100">
				{fmt(data.totals.betsPlaced)}
			</p>
			<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
				{fmt(data.totals.betsWon)} won
			</p>
		</div>
		<div class="nc-card p-4">
			<p class="nc-label mb-1">Win rate</p>
			<p class="num text-xl font-semibold text-zinc-900 dark:text-zinc-100">
				{data.totals.winRate === null ? '—' : `${Math.round(data.totals.winRate * 100)}%`}
			</p>
			<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
				all-time
			</p>
		</div>
		<div class="nc-card p-4">
			<p class="nc-label mb-1">Staked</p>
			<p class="num text-xl font-semibold text-zinc-900 dark:text-zinc-100">
				🪙 {fmt(data.totals.totalStaked)}
			</p>
			<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
				won {fmt(data.totals.totalWon)}
			</p>
		</div>
		<div class="nc-card p-4 sm:col-span-3 sm:flex sm:items-baseline sm:justify-between">
			<p class="nc-label mb-1 sm:mb-0">Best payout</p>
			<p class="num text-xl font-semibold text-amber-600 dark:text-gold-glow">
				{data.totals.bestPayout === 0 ? '—' : `+${fmt(data.totals.bestPayout)} NC`}
			</p>
		</div>
	</section>

	<!-- ── the log ──────────────────────────────────────────────────────────────── -->
	<section class="nc-card overflow-hidden">
		<!-- Filters: client-side over the pages loaded so far, ≥44px tall to tap. -->
		<div
			class="flex flex-wrap gap-1.5 border-b border-zinc-200 px-3 py-2.5 dark:border-felt-800"
			role="group"
			aria-label="Filter your bets"
		>
			{#each FILTERS as tab (tab.id)}
				<button
					type="button"
					class="min-h-[36px] rounded-full border px-3 py-1 text-xs font-semibold transition-colors {filter ===
					tab.id
						? 'border-gold-dim bg-gold/15 text-amber-700 dark:text-gold'
						: 'border-zinc-300 text-zinc-500 hover:border-gold-dim hover:text-amber-700 dark:border-felt-700 dark:text-zinc-400 dark:hover:text-gold'}"
					aria-pressed={filter === tab.id}
					on:click={() => (filter = tab.id)}
				>
					{tab.label}
					<span class="num ml-1 text-[10px] opacity-70">{counts[tab.id]}</span>
				</button>
			{/each}
		</div>

		{#if data.totals.betsPlaced === 0 && bets.length === 0}
			<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
				<p class="text-3xl" aria-hidden="true">🧾</p>
				<p class="text-sm text-zinc-500 dark:text-zinc-400">No bets yet.</p>
				<p class="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
					Your calls land here the moment you place them — picks, stakes and the verdict after the
					15:20 cutoff.
				</p>
				<a href="/" class="nc-btn mt-1 w-auto px-5">Place your first bet</a>
			</div>
		{:else if visible.length === 0}
			<p class="px-4 py-8 text-center text-sm text-zinc-500">
				No {FILTERS.find((tab) => tab.id === filter)?.label.toLowerCase()} in the pages loaded.
			</p>
		{:else}
			<ul class="divide-y divide-zinc-200 dark:divide-felt-800">
				{#each visible as bet (bet.id)}
					{@const verdict = verdictOf(bet)}
					{@const name = indexLabel(bet.underlying)}
					<li class="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
						<span class="min-w-0 flex-1">
							<span
								class="block truncate text-sm font-semibold uppercase tracking-wide text-zinc-900 dark:text-zinc-200"
							>
								{name}
								<span
									class={bet.targetKind === 'up'
										? 'text-emerald-600 dark:text-up'
										: 'text-rose-600 dark:text-down'}
								>
									{bet.targetKind === 'up' ? '▲' : '▼'}{fmt(bet.deltaPoints)}
								</span>
							</span>
							<span
								class="mt-0.5 block text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
							>
								{stamp(bet.createdAt)}
								<span class="text-zinc-300 dark:text-zinc-700" aria-hidden="true">·</span>
								staked {fmt(bet.stake)}
								<span class="text-zinc-300 dark:text-zinc-700" aria-hidden="true">·</span>
								<span class="num">{bet.odds}×</span>
							</span>
						</span>
						<span
							class="shrink-0 text-right text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500"
						>
							{bet.settledAt === null ? 'unsettled' : stamp(bet.settledAt)}
						</span>
						<span
							class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide {verdict.tone}"
						>
							<span aria-hidden="true">{verdict.badge}</span>
							{verdict.label}
						</span>
						<span class="num w-20 shrink-0 text-right text-sm {verdict.amountTone}">
							{verdict.amount}
						</span>
					</li>
				{/each}
			</ul>

			{#if loadError}
				<p
					class="border-t border-zinc-200 px-4 py-3 text-sm text-rose-600 dark:border-felt-800 dark:text-down"
					role="alert"
				>
					{loadError}
				</p>
			{/if}

			{#if cursor !== null}
				<div class="border-t border-zinc-200 p-3 dark:border-felt-800">
					<button
						type="button"
						class="nc-btn-ghost min-h-[44px] w-full"
						on:click={loadMore}
						disabled={loadingMore}
					>
						{loadingMore ? 'Loading…' : 'Load more'}
					</button>
				</div>
			{/if}
		{/if}
	</section>

	<p class="text-center text-[11px] text-zinc-500 dark:text-zinc-500">
		Your log only — nobody else's bets appear here. Stakes are play-money NC.
	</p>
</div>
