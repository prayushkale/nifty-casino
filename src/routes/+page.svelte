<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import type { PageData } from './$types';
	import { AUCTION_START_HMS, CUTOFF_HMS, SIGNUP_BONUS } from '$lib/config/app';
	import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
	import type { StatePayload } from '$lib/server/state';
	import IndexCard from '$lib/components/game/IndexCard.svelte';
	import MyBetsStrip from '$lib/components/game/MyBetsStrip.svelte';
	import PhaseBanner from '$lib/components/game/PhaseBanner.svelte';
	import {
		bettingPhase,
		casLatest,
		fetchCasLatest,
		formatNC,
		gameState,
		INDEX_LABELS,
		isLivePhase,
		loadState,
		seedState,
		startCasPolling,
		startClock,
		stateError,
		nowIst,
		driftOffsetMs
	} from '$lib/stores/game';

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
	 *   • the live value line polls `/api/cas/all` every 8s while the day is live;
	 *     SSE takes over in T12.
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
	$: cutoffLabel = `${CUTOFF_HMS.h}:${String(CUTOFF_HMS.m).padStart(2, '0')} IST`;
	$: auctionLabel = `${AUCTION_START_HMS.h}:${String(AUCTION_START_HMS.m).padStart(2, '0')}:${String(
		AUCTION_START_HMS.s
	).padStart(2, '0')} IST`;

	/** Desktop shows every card at once; mobile keeps one bet form open. */
	$: expandedFor = (underlying: LadderUnderlying): boolean =>
		isDesktop ? true : underlying === expandedUnderlying;

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

		// Accordion only below `md`, where the three cards cannot share a screen.
		const mq = window.matchMedia('(min-width: 768px)');
		const apply = (): void => {
			isDesktop = mq.matches;
			if (!mq.matches && expandedUnderlying === null) expandedUnderlying = 'nifty';
		};
		apply();
		mq.addEventListener('change', apply);

		// Live indicative values, 8s, gated on the phase — no SSE yet (T12 owns it),
		// and no polling of a board that is closed anyway.
		const stopPoll = startCasPolling(8000, () => {
			const current = get(gameState);
			if (!current) return false;
			return isLivePhase(bettingPhase(current, Date.now() + get(driftOffsetMs)));
		});

		// A failed re-read (the tab slept, the network blipped) is worth one retry
		// when the player comes back, since every number here is the server's.
		const onVisible = (): void => {
			if (document.visibilityState !== 'visible') return;
			void loadState();
			void fetchCasLatest();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			stopClock();
			stopPoll();
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
			class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-felt-800 bg-felt-900/60 px-4 py-2.5 text-xs text-zinc-400"
			aria-label="Your streak and experience"
		>
			<span title="Consecutive betting days"
				>🔥 <span class="num text-zinc-200">{state.user.streakDays}</span> day{state.user
					.streakDays === 1
					? ''
					: 's'}</span
			>
			<span class="text-felt-700" aria-hidden="true">·</span>
			<span title="Experience points"
				>XP <span class="num text-zinc-200">{formatNC(state.user.xp)}</span></span
			>
			<span class="text-felt-700" aria-hidden="true">·</span>
			<span class="num">{formatNC(state.user.stats.betsPlaced)}</span> bet{state.user.stats
				.betsPlaced === 1
				? ''
				: 's'} placed
		</section>
	{/if}

	<PhaseBanner {phase} tradeDate={state.tradeDate} />

	{#if $stateError}
		<p class="nc-alert" role="alert">
			{$stateError} —
			<button type="button" class="underline" on:click={() => void loadState()}>retry</button>
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

	<!-- ── live charts — shells until T12 lights them up ───────────────────────── -->
	<section class="flex flex-col gap-3" aria-label="Live auction charts">
		<header class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="text-xs font-semibold uppercase tracking-widest text-zinc-400">Live charts</h2>
			<p class="text-[11px] text-zinc-600">
				auction mode from {auctionLabel} · cutoff {cutoffLabel}
			</p>
		</header>
		<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
			{#each LADDER_UNDERLYINGS as underlying (underlying)}
				<div
					class="flex min-h-[168px] flex-col justify-between rounded-xl border border-felt-700 bg-felt-900/60 p-4"
				>
					<div class="flex items-baseline justify-between gap-2">
						<span class="text-xs font-bold uppercase tracking-widest text-zinc-300">
							{INDEX_LABELS[underlying]}
						</span>
						<span class="num text-sm text-zinc-500">
							{latest[underlying] ? formatNC(latest[underlying]?.value ?? 0) : '—'}
						</span>
					</div>
					<!-- 320px-safe by construction: no canvas yet, so nothing can overflow. -->
					<div
						class="my-3 flex flex-1 items-center justify-center rounded-lg border border-dashed border-felt-700 px-3 py-6 text-center"
					>
						<p class="text-[11px] leading-relaxed text-zinc-600">
							{#if phase === 'pre'}
								Charts go live {auctionLabel} — the auction's first indicative ticks.
							{:else if isLivePhase(phase)}
								Auction running — the live line lands here with the SSE feed.
							{:else if phase === 'closed-weekend'}
								Market closed. Charts replay here on the next trading day.
							{:else}
								Today's auction is finished. Charts replay here after settlement.
							{/if}
						</p>
					</div>
					<p class="num text-[11px] text-zinc-700">target lines + payout preview · T12</p>
				</div>
			{/each}
		</div>
	</section>
</div>
