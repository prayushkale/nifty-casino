<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import {
		AUCTION_START_HMS,
		CLIENT_SETTLE_POLL_MS,
		CUTOFF_HMS,
		SIGNUP_BONUS
	} from '$lib/config/app';
	import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
	import { nextRank, progressToNext, rankFor, xpToNext } from '$lib/config/ranks';
	import type { StatePayload } from '$lib/server/state';
	import CasChart from '$lib/components/game/CasChart.svelte';
	import FeedStatusBanner from '$lib/components/game/FeedStatusBanner.svelte';
	import IndexCard from '$lib/components/game/IndexCard.svelte';
	import MyBetsStrip from '$lib/components/game/MyBetsStrip.svelte';
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
	 * The floor (PLAN §4). Desktop: three index cards and the bets strip, then the
	 * charts section. Mobile: the same pieces stacked, with the cards behaving as an
	 * accordion so only one bet form is open at a time — a 360px screen cannot show
	 * three ladders and three stake rows and stay thumb-reachable.
	 *
	 * Where the numbers come from:
	 *   • `state` starts as the payload `load` already built (SSR + first paint) and
	 *     is then replaced by the store's, which is what every action refreshes.
	 *   • `now` is the drift-corrected ticker, so every phase and countdown on this
	 *     page is judged on the server's clock.
	 *   • the live line is SSE-first (`/api/stream` via `casStream`), with the 8s
	 *     `/api/cas/all` poll kept only as the stream module's own fallback. Both
	 *     paths write the same `casLatest` store, so the cards and the charts read
	 *     one number.
	 */
	export let data: PageData;

	/** The payload this screen renders. Never written during SSR — see `seedState`. */
	let state: StatePayload = data.state;

	let expandedUnderlying: LadderUnderlying | null = 'nifty';
	let isDesktop = true;

	$: if ($gameState) state = $gameState;
	$: phase = bettingPhase(state, $nowIst);
	$: authed = state.user !== null;
	$: balance = state.user?.balance ?? null;
	$: myBets = state.myBets;
	$: anchors = state.ladder.anchors;
	$: latest = $casLatest;
	$: stream = $casStream;
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
	 */
	let settleTimer: ReturnType<typeof setInterval> | null = null;

	function syncSettlePoll(currentPhase: GamePhase, settled: boolean): void {
		const wanted = currentPhase === 'locked' && !settled;
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

	onMount(() => {
		seedState(data.state);
		const stopClock = startClock();

		// The settlement reveal (T13): confetti on a HIT, a toast on a flat or a
		// miss, once per bet per browser. It watches the shared `/api/state` store,
		// so it fires whichever path the verdict arrived by — the 30s settle poll, a
		// post-bet refresh, or a tab waking up.
		const stopReveals = startRevealWatcher();

		// The live feed. SSE with a REST snapshot for hydration, gap-fill and
		// fallback — the page never polls directly.
		const stopStream = startCasStream();

		// Accordion only below `md`, where the three cards cannot share a screen.
		const mq = window.matchMedia('(min-width: 768px)');
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
	<title>NiftyCasino — call the closing auction</title>
	<meta
		name="description"
		content="Forecast how NIFTY 50, BANKNIFTY and SENSEX close in SEBI's Closing Auction Session. Play-money chips, 15:00–15:20 IST daily."
	/>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-24 pt-4 md:pb-10">
	<!-- ── the day, and what the room has staked ───────────────────────────────── -->
	{#if !state.session.settled && state.user}
		<section
			class="flex flex-col gap-2 rounded-xl border border-felt-800 bg-felt-900/60 px-4 py-2.5 text-xs text-zinc-400 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1"
			aria-label="Your streak, rank and experience"
		>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span title="Consecutive betting days"
					>🔥 <span class="num text-zinc-200">{state.user.streakDays}</span> day{state.user
						.streakDays === 1
						? ''
						: 's'}</span
				>
				<span class="text-felt-700" aria-hidden="true">·</span>
				<!-- The rank: compact on the strip, the full story in the tooltip. -->
				<span class="nc-chip px-2.5 py-0.5" title={rankTitle}>
					<span aria-hidden="true">🎖</span>
					<span class="num">L{rank.level}</span>
					<span class="text-felt-700" aria-hidden="true">·</span>
					{rank.title}
				</span>
				<span class="text-felt-700" aria-hidden="true">·</span>
				<span title="Experience points"
					>XP <span class="num text-zinc-200">{formatNC(xp)}</span></span
				>
				<span class="text-felt-700" aria-hidden="true">·</span>
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
				<p class="mt-1 text-[10px] uppercase tracking-wide text-zinc-600">
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
			class="rounded-2xl border border-gold-dim/40 bg-gradient-to-b from-gold/10 to-felt-900/80 p-6 shadow-glow sm:p-8"
		>
			<h1 class="text-2xl font-bold text-gold-glow sm:text-3xl">Call the close. Win the pot.</h1>
			<p class="mt-2 max-w-2xl text-sm text-zinc-300">
				Between 15:00 and 15:20 IST, pick how NIFTY 50, BANKNIFTY and SENSEX will close in SEBI's
				Closing Auction Session. Hit the target and your stake is paid at up to 6×. Get it wrong and
				the stake is gone — that is the game.
			</p>
			<p class="mt-3 text-sm text-gold">
				🪙 <span class="num font-semibold">{formatNC(SIGNUP_BONUS)} NC</span>
				<span class="text-zinc-400">signup bonus — play-money only, no real money.</span>
			</p>
			<div class="mt-5 flex flex-col gap-2 sm:flex-row">
				<a href="/auth/signup" class="nc-btn min-h-[44px] sm:w-auto sm:px-6"
					>Claim {formatNC(SIGNUP_BONUS)} NC and play</a
				>
				<a href="/auth/login" class="nc-btn-ghost min-h-[44px] sm:w-auto sm:px-6"
					>I have an account</a
				>
			</div>
			<p class="mt-3 text-[11px] text-zinc-500">
				The board below is live to watch — ladder, values and pot, no account needed.
			</p>
		</section>
	{/if}

	<!-- ── the three boards ────────────────────────────────────────────────────── -->
	<section class="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="The three indices">
		{#each LADDER_UNDERLYINGS as underlying (underlying)}
			<div id="card-{underlying}" class="scroll-mt-24">
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
			{#if underlying === 'sensex'}
				<!-- The strip completes the §4 grid: two cards, then SENSEX beside the bets. -->
				<div class="lg:row-span-1">
					<MyBetsStrip
						bets={myBets}
						{anchors}
						{latest}
						{phase}
						{authed}
						on:focus={(event) => focusCard(event.detail)}
					/>
				</div>
			{/if}
		{/each}
	</section>

	<!-- ── live charts — auction mode (PLAN §4): three cards, target lines, previews ── -->
	<section class="flex flex-col gap-3" aria-label="Live auction charts">
		<header class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="text-xs font-semibold uppercase tracking-widest text-zinc-400">Live charts</h2>
			<p class="text-[11px] text-zinc-600">
				auction mode from {auctionLabel} · cutoff {cutoffLabel}
			</p>
		</header>
		<FeedStatusBanner />
		<!-- 3-across on desktop (§4); full-width stacked below `md`, 320px-safe either way. -->
		<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
			{#each LADDER_UNDERLYINGS as underlying (underlying)}
				<CasChart
					{underlying}
					label={INDEX_LABELS[underlying]}
					ticks={stream.series[underlying]}
					latest={latest[underlying]}
					anchor={anchors[underlying]}
					myBet={myBets.find((bet) => bet.underlying === underlying) ?? null}
					{phase}
				/>
			{/each}
		</div>
	</section>
</div>
