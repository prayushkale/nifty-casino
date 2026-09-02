<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import {
		AUCTION_START_HMS,
		BETTING_START_HMS,
		CLIENT_SETTLE_POLL_MS,
		CUTOFF_HMS,
		SIGNUP_BONUS
	} from '$lib/config/app';
	import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
	import { hmsToSeconds, secOfDayIst } from '$lib/time/ist';
	import { nextRank, progressToNext, rankFor, xpToNext } from '$lib/config/ranks';
	import type { StatePayload } from '$lib/server/state';
	import CasChart from '$lib/components/game/CasChart.svelte';
	import FeedStatusBanner from '$lib/components/game/FeedStatusBanner.svelte';
	import IndexCard from '$lib/components/game/IndexCard.svelte';
	import PhaseBanner from '$lib/components/game/PhaseBanner.svelte';
	import {
		bettingPhase,
		casLatest,
		formatNC,
		gameState,
		INDEX_LABELS,
		loadState,
		seedState,
		startClock,
		stateError,
		stateLoading,
		nowIst
	} from '$lib/stores/game';
	import type { GamePhase } from '$lib/stores/game';
	import { casStream, startCasStream, resyncCasStream } from '$lib/stores/casStream';
	import { startRevealWatcher } from '$lib/stores/reveal';

	/**
	 * The floor — one row per index: ladder on the left, live chart on the right.
	 * Desktop: 3 columns in a single row (~30% each). Tablet/phone: stacked.
	 * The old \"ladder row + charts row\" split is gone by design — each index's
	 * action and its price live side-by-side so a player never hunts for the line
	 * that matches their chip.
	 */
	export let data: PageData;

	/** The payload this screen renders. Never written during SSR — see `seedState`. */
	let state: StatePayload = data.state;

	let expandedUnderlying: LadderUnderlying | null = 'nifty';
	let isDesktop = true;
	let theater: LadderUnderlying | null = null;
	let fullscreen: LadderUnderlying | null = null;

	$: if ($gameState) state = $gameState;
	$: phase = bettingPhase(state, $nowIst);
	$: authed = state.user !== null;
	$: balance = state.user?.balance ?? null;
	$: myBets = state.myBets;
	$: latest = $casLatest;
	$: stream = $casStream;
	// `/api/closes/last` backfill — covers the blank-chart gap when
	// `index_closes` has not yet been seeded (fresh deploy / before first
	// CAS poll). Merged over the DB anchors so a live `previousClose` from
	// NSE/BSE gives every chart a centred synthetic line on first paint.
	let closeFill: Record<LadderUnderlying, number | null> | null = null;
	$: anchors = (() => {
		const base = state.ladder.anchors;
		if (!closeFill) return base;
		return {
			nifty: base.nifty ?? closeFill.nifty,
			banknifty: base.banknifty ?? closeFill.banknifty,
			sensex: base.sensex ?? closeFill.sensex
		} as Record<LadderUnderlying, number | null>;
	})();
	// The rank is derived from the XP the payload already carries — never stored,
	// so a re-tune of the ladder re-titles everyone with no migration.
	$: xp = state.user?.xp ?? 0;
	$: rank = rankFor(xp);
	$: next = nextRank(xp);
	$: rankProgress = progressToNext(xp);
	$: rankGap = xpToNext(xp);
	$: rankTitle = `${rank.tagline} — ${
		next === null || rankGap === null
			? `top of the ladder at ${formatNC(rank.minXp)} XP.`
			: `${formatNC(rankGap)} XP to ${next.title}.`
	}`;
	$: cutoffLabel = `${CUTOFF_HMS.h}:${String(CUTOFF_HMS.m).padStart(2, '0')} IST`;
	$: auctionLabel = `${AUCTION_START_HMS.h}:${String(AUCTION_START_HMS.m).padStart(2, '0')}:${String(
		AUCTION_START_HMS.s
	).padStart(2, '0')} IST`;

	/** Desktop shows every card at once; mobile keeps one bet form open. */
	$: expandedFor = (underlying: LadderUnderlying): boolean =>
		isDesktop ? true : underlying === expandedUnderlying;

	/**
	 * The 30s settle poll (PLAN §5 T12): while the day is locked and not yet paid
	 * out, re-read `/api/state` for the official close and the verdicts. One interval
	 * for the whole page, not one per chart — three charts would mean three timers
	 * asking the same question. Cleared the moment the phase leaves `locked`.
	 * Gated to 15:00+ IST — before the window the player just needs the last close
	 * to place a bet, not a poll for a close that cannot exist yet.
	 */
	let settleTimer: ReturnType<typeof setInterval> | null = null;

	function isAfter15(): boolean {
		const n = $nowIst;
		if (n === null || n === undefined) return false;
		return secOfDayIst(new Date(n)) >= hmsToSeconds(BETTING_START_HMS);
	}

	function syncSettlePoll(currentPhase: GamePhase, settled: boolean): void {
		const wanted = currentPhase === 'locked' && !settled && isAfter15();
		if (wanted && settleTimer === null) {
			settleTimer = setInterval(() => void loadState(), CLIENT_SETTLE_POLL_MS);
		} else if (!wanted && settleTimer !== null) {
			clearInterval(settleTimer);
			settleTimer = null;
		}
	}

	$: if (typeof window !== 'undefined') syncSettlePoll(phase, state.session.settled);

	function toggleCard(underlying: LadderUnderlying): void {
		if (isDesktop) return; // everything is already open
		expandedUnderlying = expandedUnderlying === underlying ? null : underlying;
	}

	function focusCard(underlying: LadderUnderlying): void {
		expandedUnderlying = underlying;
		if (typeof document !== 'undefined') {
			document.getElementById(`card-${underlying}`)?.scrollIntoView({ block: 'center' });
		}
	}

	function toggleTheater(underlying: LadderUnderlying): void {
		if (fullscreen) fullscreen = null;
		theater = theater === underlying ? null : underlying;
	}

	function toggleFullscreen(underlying: LadderUnderlying): void {
		if (theater) theater = null;
		fullscreen = fullscreen === underlying ? null : underlying;
	}

	$: if (typeof document !== 'undefined') {
		document.documentElement.style.overflow = fullscreen ? 'hidden' : '';
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (fullscreen) fullscreen = null;
		else if (theater) theater = null;
	}

	function theaterHeightFor(u: LadderUnderlying | null): number | null {
		if (!u || theater !== u) return null;
		return 420;
	}

	function fullscreenHeightFor(u: LadderUnderlying | null): number | null {
		if (!u || fullscreen !== u) return null;
		if (typeof window === 'undefined') return 560;
		return Math.max(360, window.innerHeight - 160);
	}

	onMount(() => {
		seedState(data.state);
		const stopClock = startClock();

		// Backfill anchors for every chart before the first CAS tick.
		// `state.ladder.anchors` can be all-null on a fresh deploy (no
		// `index_closes` rows yet). This one-shot fetch merges live
		// `previousClose` values over the DB anchors so each CasChart can
		// render its centred synthetic flat line immediately.
		void (async () => {
			const needsFill =
				state.ladder.anchors.nifty === null ||
				state.ladder.anchors.banknifty === null ||
				state.ladder.anchors.sensex === null;
			if (!needsFill) return;
			try {
				const res = await fetch(`/api/closes/last?date=${encodeURIComponent(state.tradeDate)}`);
				if (!res.ok) return;
				const body = (await res.json()) as {
					closes?: Record<LadderUnderlying, number | null>;
				};
				if (!body.closes) return;
				const haveAny =
					body.closes.nifty !== null ||
					body.closes.banknifty !== null ||
					body.closes.sensex !== null;
				if (!haveAny) return;
				closeFill = body.closes;
			} catch {
				// non-fatal — charts keep whatever DB anchors they had
			}
		})();

		// The settlement reveal (T13): confetti on a HIT, a toast on a flat or a
		// miss, once per bet per browser. It watches the shared `/api/state` store,
		// so it fires whichever path the verdict arrived by — the 30s settle poll, a
		// post-bet refresh, or a tab waking up.
		const stopReveals = startRevealWatcher();

		// The live feed. SSE with a REST snapshot for hydration, gap-fill and
		// fallback — the page never polls directly.
		const stopStream = startCasStream();

		// Accordion only below `lg`, where the three columns cannot share a row.
		const mq = window.matchMedia('(min-width: 1024px)');
		const apply = (): void => {
			isDesktop = mq.matches;
			if (!mq.matches && expandedUnderlying === null) expandedUnderlying = 'nifty';
		};
		apply();
		mq.addEventListener('change', apply);

		// A failed re-read (the tab slept, the network blipped) is worth one retry
		// when the player comes back, since every number here is the server's.
		// `resyncCasStream` is the tick-side version of the same idea.
		const onVisible = (): void => {
			if (document.visibilityState !== 'visible') return;
			void loadState();
			void resyncCasStream();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			stopClock();
			stopReveals();
			stopStream();
			if (settleTimer !== null) clearInterval(settleTimer);
			settleTimer = null;
			mq.removeEventListener('change', apply);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>NiftyCASino — call the closing auction</title>
	<meta
		name="description"
		content="Forecast how NIFTY 50, BANKNIFTY and SENSEX close in SEBI's Closing Auction Session. Play-money chips, 15:00–15:20 IST daily."
	/>
</svelte:head>

<div class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 pb-24 pt-4 md:pb-10 lg:px-2 xl:px-4">
	<!-- ── the day, and what the room has staked ───────────────────────────────── -->
	{#if !state.session.settled && state.user}
		<section
			class="flex flex-col gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm text-zinc-600 shadow-sm dark:border-felt-800 dark:bg-felt-900/60 dark:text-zinc-400 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1"
			aria-label="Your streak, rank and experience"
		>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span title="Consecutive betting days"
					>🔥 <span class="num text-zinc-900 dark:text-zinc-200">{state.user.streakDays}</span>
					day{state.user.streakDays === 1 ? '' : 's'}</span
				>
				<span class="text-zinc-300 dark:text-felt-700" aria-hidden="true">·</span>
				<!-- The rank: compact on the strip, the full story in the tooltip. -->
				<span class="nc-chip px-2.5 py-0.5" title={rankTitle}>
					<span aria-hidden="true">🎖</span>
					<span class="num">L{rank.level}</span>
					<span class="text-zinc-300 dark:text-felt-700" aria-hidden="true">·</span>
					{rank.title}
				</span>
				<span class="text-zinc-300 dark:text-felt-700" aria-hidden="true">·</span>
				<span title="Experience points"
					>XP <span class="num text-zinc-900 dark:text-zinc-200">{formatNC(xp)}</span></span
				>
				<span class="text-zinc-300 dark:text-felt-700" aria-hidden="true">·</span>
				<span class="num">{formatNC(state.user.stats.betsPlaced)}</span> bet{state.user.stats
					.betsPlaced === 1
					? ''
					: 's'} placed
			</div>
			<!-- Progress through this rung. Full bar (and no "to next") at Legend. -->
			<div class="sm:ml-auto sm:w-40">
				<div class="nc-xpbar" title={rankTitle}>
					<span class="nc-xpbar-fill" style={`width:${Math.round(rankProgress * 100)}%`} />
				</div>
				<p class="mt-1 text-[11px] uppercase tracking-wide text-zinc-500">
					{#if next && rankGap !== null}
						<span class="num">{formatNC(rankGap)}</span> XP to {next.title}
					{:else}
						Top of the ladder
					{/if}
				</p>
			</div>
		</section>
	{/if}

	<PhaseBanner {phase} tradeDate={state.tradeDate} now={$nowIst} />

	{#if $stateError}
		<p class="nc-alert flex flex-wrap items-center gap-1" role="alert">
			{$stateError} —
			<button
				type="button"
				class="inline-flex min-h-[44px] items-center font-semibold underline"
				on:click={() => void loadState()}>retry</button
			>
		</p>
	{/if}

	<!-- ── anonymous: the one pitch, over a board anyone can read ──────────────── -->
	{#if !authed}
		<section
			class="rounded-2xl border border-gold-dim/40 bg-gradient-to-b from-gold/10 to-white p-6 shadow-sm dark:to-felt-900/80 sm:p-8"
		>
			<h1 class="text-2xl font-bold text-amber-700 dark:text-gold-glow sm:text-3xl">
				Call the close. Win the pot.
			</h1>
			<p class="mt-2 max-w-2xl text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">
				Between 15:00 and 15:20 IST, pick how NIFTY 50, BANKNIFTY and SENSEX will close in SEBI's
				Closing Auction Session. Hit the target and your stake is paid at up to 6×. Get it wrong and
				the stake is gone — that is the game.
			</p>
			<p class="mt-3 text-sm text-amber-700 dark:text-gold">
				🪙 <span class="num font-semibold">{formatNC(SIGNUP_BONUS)} NC</span>
				<span class="text-zinc-600 dark:text-zinc-400"
					>signup bonus — play-money only, no real money.</span
				>
			</p>
			<div class="mt-5 flex flex-col gap-2 sm:flex-row">
				<a href="/auth/signup" class="nc-btn min-h-[44px] sm:w-auto sm:px-6"
					>Claim {formatNC(SIGNUP_BONUS)} NC and play</a
				>
				<a href="/auth/login" class="nc-btn-ghost min-h-[44px] sm:w-auto sm:px-6"
					>I have an account</a
				>
			</div>
			<p class="mt-3 text-xs text-zinc-500">
				The board below is live to watch — ladder, values and pot, no account needed.
			</p>
		</section>
	{/if}

	<!-- ── the three indices — one row, three columns (≈30% each) ─────────────── -->
	<section aria-label="The three indices">
		{#if authed}
			<header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h2
					class="text-sm font-semibold uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
				>
					Place your calls
				</h2>
				<p class="text-xs text-zinc-500">
					auction mode from {auctionLabel} · cutoff {cutoffLabel}
				</p>
			</header>
		{/if}
		<p class="text-xs text-zinc-500 dark:text-zinc-400">
			CAS 15:13:30 → 15:42 IST · live ticks replace the previous-close line once the auction starts
		</p>
		<FeedStatusBanner />
		<!-- Theater: expanded chart owns its row; others' charts hide — bets stay put. -->
		{#if theater}
			<div class="mt-3">
				{#each LADDER_UNDERLYINGS.filter((u) => u === theater) as underlying (underlying)}
					<CasChart
						{underlying}
						label={INDEX_LABELS[underlying]}
						ticks={stream.series[underlying]}
						latest={latest[underlying]}
						anchor={anchors[underlying]}
						myBet={myBets.find((bet) => bet.underlying === underlying) ?? null}
						{phase}
						tradeDate={state.tradeDate}
						isTheater={theater === underlying}
						isFullscreen={fullscreen === underlying}
						displayHeight={theaterHeightFor(underlying)}
						on:theater={() => toggleTheater(underlying)}
						on:fullscreen={() => toggleFullscreen(underlying)}
					/>
				{/each}
				<button
					type="button"
					class="mt-2 text-xs font-medium text-zinc-500 underline decoration-zinc-300 hover:text-zinc-700 dark:text-zinc-400"
					on:click={() => (theater = null)}>Exit theater — show all charts</button
				>
			</div>
		{:else}
			<div class="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
				{#each LADDER_UNDERLYINGS as underlying (underlying)}
					<CasChart
						{underlying}
						label={INDEX_LABELS[underlying]}
						ticks={stream.series[underlying]}
						latest={latest[underlying]}
						anchor={anchors[underlying]}
						myBet={myBets.find((bet) => bet.underlying === underlying) ?? null}
						{phase}
						tradeDate={state.tradeDate}
						isTheater={theater === underlying}
						isFullscreen={fullscreen === underlying}
						displayHeight={theaterHeightFor(underlying) ?? fullscreenHeightFor(underlying)}
						on:theater={() => toggleTheater(underlying)}
						on:fullscreen={() => toggleFullscreen(underlying)}
					/>
				{/each}
			</div>
		{/if}
		<!-- Fullscreen overlay: chart + bet strip atop scrim. Esc or backdrop to exit. -->
		{#if fullscreen}
			<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
			<div
				class="fixed inset-0 z-40 flex flex-col bg-zinc-950/80 p-3 backdrop-blur-sm sm:p-4 md:p-6"
				role="dialog"
				aria-modal="true"
				aria-label="{INDEX_LABELS[fullscreen]} fullscreen chart"
				on:click|self={() => (fullscreen = null)}
				on:keydown={onKeydown}
				tabindex="-1"
			>
				<div class="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 overflow-auto">
					<div class="flex items-center justify-between">
						<h2 class="text-sm font-semibold uppercase tracking-widest text-white">
							{INDEX_LABELS[fullscreen]} — fullscreen
						</h2>
						<button
							type="button"
							class="inline-flex min-h-[36px] items-center rounded-lg border border-white/30 bg-white/10 px-3 text-sm font-medium text-white hover:bg-white/20"
							on:click={() => (fullscreen = null)}>Exit (Esc)</button
						>
					</div>
					<CasChart
						underlying={fullscreen}
						label={INDEX_LABELS[fullscreen]}
						ticks={stream.series[fullscreen]}
						latest={latest[fullscreen]}
						anchor={anchors[fullscreen]}
						myBet={myBets.find((bet) => bet.underlying === fullscreen) ?? null}
						{phase}
						tradeDate={state.tradeDate}
						isFullscreen={true}
						displayHeight={fullscreenHeightFor(fullscreen)}
						on:theater={() => {
							if (fullscreen) toggleTheater(fullscreen);
						}}
						on:fullscreen={() => {
							if (fullscreen) toggleFullscreen(fullscreen);
						}}
					/>
					{#if authed}
						<div class="max-w-xl">
							<IndexCard
								underlying={fullscreen}
								label={INDEX_LABELS[fullscreen]}
								options={state.ladder.options.filter((o) => o.underlying === fullscreen)}
								anchor={anchors[fullscreen]}
								latest={latest[fullscreen]}
								{phase}
								{authed}
								{balance}
								loading={$stateLoading}
								myBet={myBets.find((bet) => bet.underlying === fullscreen) ?? null}
								expanded={true}
								on:toggle={() => {}}
								on:action={() => {
									if (fullscreen) focusCard(fullscreen);
								}}
							/>
						</div>
					{/if}
				</div>
			</div>
		{/if}
		<!-- Bets: its own row below the charts — no hunting for the chip that matches the line. -->
		{#if authed}
			<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
				{#each LADDER_UNDERLYINGS as underlying (underlying)}
					<div id="card-{underlying}" class="min-w-0 scroll-mt-24">
						<IndexCard
							{underlying}
							label={INDEX_LABELS[underlying]}
							options={state.ladder.options.filter((option) => option.underlying === underlying)}
							anchor={anchors[underlying]}
							latest={latest[underlying]}
							{phase}
							{authed}
							{balance}
							loading={$stateLoading}
							myBet={myBets.find((bet) => bet.underlying === underlying) ?? null}
							expanded={expandedFor(underlying)}
							on:toggle={() => toggleCard(underlying)}
							on:action={() => focusCard(underlying)}
						/>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
