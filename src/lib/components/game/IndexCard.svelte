<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { payoutFor } from '$lib/game/tier';
	import type { LadderOption, LadderUnderlying } from '$lib/config/ladder';
	import type { StateBet } from '$lib/server/state';
	import {
		formatNC,
		placeBet,
		editBet,
		cancelBet,
		projectedPayout,
		stakeValidationError,
		type CasLiveValue,
		type GamePhase
	} from '$lib/stores/game';
	import ConfirmModal from './ConfirmModal.svelte';
	import Skeleton from './Skeleton.svelte';

	/**
	 * One index, the whole bet flow for it (PLAN §4 index card):
	 *
	 *   live value line → strike board → stake row → PLACE BET → confirm modal
	 *
	 * The card owns its own form state (which rung, what stake, whether the modal is
	 * up) and nothing else. The money is the store's: a confirmed action calls the
	 * bet route and then re-reads `/api/state`, so the balance and the pot on screen
	 * are always the server's numbers, never a local guess. That is why there is no
	 * optimistic update here — the only local truth is "my button is spinning".
	 *
	 * When the player already has a bet on this index the chips give way to the
	 * bet's summary plus Edit/Cancel, because the day allows exactly one active bet
	 * per index (`bets` UNIQUE, PLAN §3) — a second PLACE BET could only 409.
	 */
	export let underlying: LadderUnderlying;
	export let label: string;
	export let options: LadderOption[] = [];
	export let anchor: number | null = null;
	export let latest: CasLiveValue | null = null;
	export let phase: GamePhase = 'pre';
	export let authed = false;
	/** `null` for an anonymous visitor — the wallet is theirs alone. */
	export let balance: number | null = null;
	/** The player's existing bet on this index, if any. */
	export let myBet: StateBet | null = null;
	/** Mobile accordion: the card the player is working on is expanded. */
	export let expanded = true;
	/**
	 * True while a `/api/state` read is in flight (T13). An empty ladder is either
	 * "no ladder today" or "not landed yet", and those need different answers: the
	 * first is information, the second is a shimmer.
	 */
	export let loading = false;

	const dispatch = createEventDispatcher<{
		toggle: void;
		/** A mutation the parent may want to react to (scroll, refresh, collapse). */
		action: { kind: 'place' | 'edit' | 'cancel' };
	}>();

	let selected: LadderOption | null = null;
	let stakeInput = '';
	let confirmOpen = false;
	let pending = false;
	let error = '';
	/** True while the player is rewriting their existing bet instead of placing one. */
	let editing = false;
	/** Strike-board search: matches the strike price or the point distance. */
	let query = '';

	$: openPhase = phase === 'open';
	$: canBet = authed && openPhase && myBet === null;
	$: canManage = authed && openPhase && myBet !== null;
	$: chipsEnabled = authed && openPhase && (myBet === null || editing);
	$: stakeError = stakeValidationError(stakeInput, balance);
	$: stakeValue = Number(String(stakeInput).trim().replace(/,/g, ''));
	$: stakeOk = stakeError === null;
	$: stakeSafe = stakeOk ? stakeValue : 0;
	$: potential = selected && stakeOk ? payoutFor('hit', stakeValue, selected.odds) : null;
	$: latestValue = latest && Number.isFinite(latest.value) ? latest.value : null;
	$: changePts = latest ? latest.changePts : null;
	$: changeUp = (changePts ?? 0) > 0;
	$: projection =
		selected && stakeOk
			? projectedPayout(
					selected,
					{ [underlying]: anchor } as Record<LadderUnderlying, number | null>,
					latestValue,
					stakeValue
				)
			: null;

	const fmtSigned = (n: number): string =>
		`${n > 0 ? '+' : n < 0 ? '−' : ''}${formatNC(Math.abs(n))}`;

	type Strike = LadderOption & { atTheMoney: boolean };

	/**
	 * The chain: one row per selectable strike, sorted by LEVEL (like NSE's chain is).
	 * A strike above the anchor is a CE (the player expects the close at/above it),
	 * one below is a PE. The row nearest the anchor is the at-the-money strike.
	 */
	$: strikes = buildStrikes(options, anchor);

	function buildStrikes(opts: LadderOption[], anchor0: number | null): Strike[] {
		const sorted = [...opts].sort(
			(a, b) => a.target - b.target || (a.targetKind < b.targetKind ? -1 : 1)
		);
		if (anchor0 === null || sorted.length === 0)
			return sorted.map((o) => ({ ...o, atTheMoney: false }));
		let nearest = sorted[0];
		for (const option of sorted) {
			if (Math.abs(option.target - anchor0) < Math.abs(nearest.target - anchor0)) nearest = option;
		}
		return sorted.map((option) => ({ ...option, atTheMoney: option === nearest }));
	}

	/**
	 * The rows the player sees: `strikes` filtered by the search box. The query
	 * matches the strike level ("24050", "24,050"), the distance ("50", "+50",
	 * "−50"), or a side ("ce"/"pe"). Empty query = the whole chain.
	 */
	$: visibleStrikes = filterStrikes(strikes, query);

	/** The two chain columns, like NSE's: calls on the left, puts on the right.
	 *  Calls read lowest→highest; puts read highest→lowest, so both columns meet
	 *  at the at-the-money strike in the middle like NSE's own chain does. */
	$: ceStrikes = visibleStrikes.filter((strike) => strike.targetKind === 'up');
	$: peStrikes = visibleStrikes
		.filter((strike) => strike.targetKind === 'down')
		.slice()
		.sort((a, b) => b.target - a.target);

	function filterStrikes(rows: Strike[], q: string): Strike[] {
		const needle = q.trim().replace(/[\s,]/g, '').toLowerCase();
		if (needle === '') return rows;
		const digits = needle.replace(/^[+−-]/, '');
		const wantsCe = /(^|[0-9±−-])ce$|^(ce|call|above)/.test(needle);
		const wantsPe = /(^|[0-9±−-])pe$|^(pe|put|below)/.test(needle);
		return rows.filter((strike) => {
			const side = strike.targetKind === 'up' ? 'ce' : 'pe';
			const sideOk = wantsCe ? side === 'ce' : wantsPe ? side === 'pe' : true;
			const levelHit = String(Math.round(strike.target)).includes(digits);
			const stepHit = String(strike.deltaPoints).startsWith(digits);
			return sideOk && (levelHit || stepHit);
		});
	}

	function pick(option: LadderOption): void {
		selected = option;
		error = '';
	}

	function quickStake(amount: number): void {
		stakeInput = String(amount);
		error = '';
	}

	function startEdit(): void {
		if (!myBet) return;
		editing = true;
		stakeInput = String(myBet.stake);
		error = '';
		// Pre-select the bet's own rung so the modal recap reads correctly.
		selected =
			options.find(
				(option) =>
					option.targetKind === myBet?.targetKind && option.deltaPoints === myBet?.deltaPoints
			) ?? null;
	}

	function stopEdit(): void {
		editing = false;
		selected = null;
		stakeInput = '';
		error = '';
	}

	/** The option a bet would act on: the picked rung, or the existing bet's own. */
	$: effective = selected ?? (canManage && !editing ? betAsOption(myBet) : null);

	function betAsOption(bet: StateBet | null): LadderOption | null {
		if (!bet) return null;
		const found = options.find(
			(option) => option.targetKind === bet.targetKind && option.deltaPoints === bet.deltaPoints
		);
		return found ?? null;
	}

	async function confirmModal(): Promise<void> {
		if (pending || !effective) return;
		pending = true;
		error = '';
		const kind = editing ? 'edit' : 'place';
		const result =
			editing && myBet
				? await editBet(myBet.id, {
						targetKind: effective.targetKind,
						deltaPoints: effective.deltaPoints,
						stake: stakeValue
					})
				: await placeBet({
						underlying,
						targetKind: effective.targetKind,
						deltaPoints: effective.deltaPoints,
						stake: stakeValue
					});
		pending = false;
		if (result.ok) {
			confirmOpen = false;
			stopEdit();
			dispatch('action', { kind });
			return;
		}
		// Stay open with the server's sentence — the player's chips are still theirs.
		error = result.message;
	}

	async function doCancel(): Promise<void> {
		if (pending || !myBet) return;
		pending = true;
		error = '';
		const result = await cancelBet(myBet.id);
		pending = false;
		if (result.ok) {
			stopEdit();
			dispatch('action', { kind: 'cancel' });
			return;
		}
		error = result.message;
	}

	// A state refresh that removed the bet (cancelled elsewhere, or the day rolled
	// over) must not leave the card in edit mode with a ghost stake.
	$: if (myBet === null && editing) stopEdit();
</script>

<section
	class="flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm transition-colors dark:bg-felt-900/80 dark:shadow-card {expanded
		? 'border-gold-dim/40'
		: 'border-zinc-200 dark:border-felt-700'}"
	aria-label={label}
>
	<header>
		<button
			type="button"
			class="flex min-h-[44px] w-full items-center justify-between gap-3 text-left"
			aria-expanded={expanded}
			on:click={() => dispatch('toggle')}
		>
			<span class="text-sm font-bold uppercase tracking-widest text-zinc-800 dark:text-zinc-200"
				>{label}</span
			>
			<span class="flex items-baseline gap-2">
				<span class="num text-xl font-semibold text-zinc-900 dark:text-zinc-100">
					{latestValue === null ? '—' : formatNC(latestValue)}
				</span>
				<span
					class="num text-xs font-semibold {changeUp ? 'text-up' : 'text-down'}"
					title="Move from the previous close (pre-auction) or the 15:15 anchor (in window)"
				>
					{changePts === null ? '' : changeUp ? '▲' : '▼'}
					{changePts === null ? '—' : fmtSigned(changePts)}
				</span>
			</span>
			<span class="ml-1 text-zinc-500 dark:text-zinc-600 md:hidden" aria-hidden="true"
				>{expanded ? '▾' : '▸'}</span
			>
		</button>
		<p class="mt-1 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-600">
			anchor
			<span
				class="num text-zinc-700 dark:text-zinc-400"
				title="The last traded price at 15:15 IST — every target is measured from it"
				>{anchor === null ? '—' : formatNC(Math.round(anchor))}</span
			>
			{#if latestValue !== null && !openPhase}
				<span class="ml-1 normal-case tracking-normal text-zinc-500 dark:text-zinc-700"
					>· last indicative</span
				>
			{/if}
		</p>
	</header>

	{#if expanded}
		{#if strikes.length === 0 && loading && phase === 'pre'}
			<!-- The ladder has not landed yet (an anonymous→authed swap, a slow read).
			     Shimmer rather than declare the day ladder-less while the read runs. -->
			<Skeleton lines={4} label="Loading the {label} ladder" />
		{:else if strikes.length === 0}
			<p
				class="rounded-lg border bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-felt-700 dark:bg-felt-800/60 dark:text-zinc-400"
			>
				No ladder for {label} today — the anchor price has not landed yet.
			</p>
		{:else if !authed}
			<!-- Read-only chain for a stranger: the strike board is the product's shop window. -->
			<div
				class="grid max-h-80 grid-cols-2 gap-1.5 overflow-y-auto pr-0.5 opacity-60 sm:grid-cols-3"
				aria-label="{label} strikes (view only)"
			>
				{#each visibleStrikes as strike (strike.target)}
					<div
						class="flex min-h-[44px] flex-col items-start rounded-lg border bg-zinc-50 px-2.5 py-1.5 text-left {strike.atTheMoney
							? 'border-gold-dim'
							: 'border-zinc-200 dark:border-felt-700'} bg-zinc-50 dark:bg-felt-800"
					>
						<span
							class="num text-sm font-semibold text-zinc-900 dark:text-zinc-100 {strike.targetKind ===
							'up'
								? 'text-up'
								: 'text-down'}"
						>
							{formatNC(Math.round(strike.target))}
							{strike.targetKind === 'up' ? 'CE' : 'PE'}
							{strike.atTheMoney ? '·ATM' : ''}
						</span>
						<span class="num text-[10px] text-zinc-500 dark:text-zinc-500">
							{fmtSigned(strike.targetKind === 'up' ? strike.deltaPoints : -strike.deltaPoints)} · up
							to {strike.odds}×</span
						>
					</div>
				{/each}
			</div>
			<p
				class="rounded-lg border bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-felt-700 dark:bg-felt-800/60 dark:text-zinc-400"
			>
				<a href="/auth/login" class="text-gold underline decoration-gold-dim">Log in</a>
				or
				<a href="/auth/signup" class="text-gold underline decoration-gold-dim">sign up</a>
				to call this index — the board is open to watch either way.
			</p>
		{:else if canManage && !editing && myBet}
			<!-- ── existing bet: summary + manage, in place of the chips ─────────────── -->
			<div
				class="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-gold-dim/40 dark:bg-gold/5"
			>
				<p class="text-xs uppercase tracking-widest text-amber-700 dark:text-gold">
					Your call today
				</p>
				<p class="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span
						class="num text-base font-semibold {myBet.targetKind === 'up'
							? 'text-up'
							: 'text-down'}"
					>
						{anchor === null
							? ''
							: formatNC(
									Math.round(
										anchor + (myBet.targetKind === 'up' ? myBet.deltaPoints : -myBet.deltaPoints)
									)
								)}
						{myBet.targetKind === 'up' ? 'CE' : 'PE'}
						<span class="text-xs font-normal text-zinc-500"
							>({fmtSigned(
								myBet.targetKind === 'up' ? myBet.deltaPoints : -myBet.deltaPoints
							)})</span
						>
					</span>
					<span class="num text-sm text-zinc-700 dark:text-zinc-300"
						>{formatNC(myBet.stake)} NC</span
					>
					<span class="num text-xs text-zinc-500">@ {myBet.odds}×</span>
					<span class="num text-xs text-up"
						>exact pays {formatNC(payoutFor('hit', myBet.stake, myBet.odds))}</span
					>
				</p>
				{#if projection}
					<p class="mt-1.5 text-xs text-zinc-600 dark:text-zinc-500">
						if it closed now:
						<span class="num {projection.tier === 'miss' ? 'text-down' : 'text-up'}">
							{projection.tier === 'hit'
								? '🎯 hit'
								: projection.tier === 'flat'
									? '➖ flat'
									: '💀 miss'}
							{projection.tier === 'hit'
								? `+${formatNC(projection.payout)}`
								: projection.tier === 'flat'
									? `refund ${formatNC(projection.payout)}`
									: `−${formatNC(myBet.stake)}`}
						</span>
					</p>
				{/if}
				<div class="mt-3 flex gap-2">
					<button
						type="button"
						class="nc-btn-ghost min-h-[44px] flex-1"
						disabled={!openPhase || pending}
						on:click={startEdit}
					>
						Edit
					</button>
					<button
						type="button"
						class="min-h-[44px] flex-1 rounded-lg border border-down/40 bg-down/10 px-3 text-sm font-medium text-down transition hover:bg-down/20 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!openPhase || pending}
						on:click={doCancel}
					>
						{pending ? '…' : 'Cancel bet'}
					</button>
				</div>
			</div>
		{:else}
			<!-- ── ladder chips ─────────────────────────────────────────────────────── -->
			<!-- The board reads like an NSE option chain: CE strikes in the left column,
		     PE strikes in the right. Every strike is a ROUND level — a whole multiple
		     of the index's spacing inside the ±3% CAS band — and the strike IS the
		     level the player expects the close to land at. Spans the whole band,
		     scrolls, and a search box jumps straight to a level. Disabled strikes stay
		     full-opacity on purpose: the prices ARE the board, so dimming them would
		     hide the product outside the betting window. -->
			{#if strikes.length > 6}
				<label class="sr-only" for="strike-search-{underlying}">Search {label} strikes</label>
				<input
					id="strike-search-{underlying}"
					class="nc-input py-1.5 text-sm"
					type="search"
					autocomplete="off"
					placeholder="Search strike — e.g. 24050 CE…"
					bind:value={query}
				/>
			{/if}
			{#if visibleStrikes.length === 0 && query.trim() !== ''}
				<p class="text-xs text-zinc-500 dark:text-zinc-500" role="status">
					No strike matches “{query}” on today's chain.
				</p>
			{/if}
			<div
				class="overflow-y-auto rounded-lg border border-zinc-100 p-1.5 {strikes.length > 8
					? 'max-h-96 dark:border-felt-800'
					: ''}"
				role="group"
				aria-label="{label} option chain"
			>
				<div class="grid grid-cols-2 gap-1.5">
					<div class="flex flex-col gap-1.5" role="group" aria-label="{label} CE strikes">
						{#each ceStrikes as strike (strike.deltaPoints)}
							{@const isSelected =
								selected?.targetKind === 'up' && selected?.deltaPoints === strike.deltaPoints}
							<button
								type="button"
								class="flex min-h-[44px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition {isSelected
									? 'border-gold bg-gold/15 shadow-glow ring-1 ring-gold'
									: strike.atTheMoney
										? 'border-gold-dim/60 bg-zinc-50 hover:border-gold dark:bg-felt-800'
										: 'border-zinc-200 bg-zinc-50 hover:border-gold-dim dark:border-felt-700 dark:bg-felt-800'} {chipsEnabled
									? ''
									: 'cursor-not-allowed'}"
								aria-pressed={isSelected}
								aria-label="{formatNC(Math.round(strike.target))} CE"
								disabled={!chipsEnabled}
								on:click={() => pick(strike)}
							>
								<span class="num text-sm font-semibold text-up">
									{formatNC(Math.round(strike.target))} CE
									{strike.atTheMoney ? '· ATM' : ''}
								</span>
								<span class="num text-[10px] text-zinc-500 dark:text-zinc-500">
									{fmtSigned(strike.deltaPoints)} ·
									<span
										class="text-gold-dim"
										title="Exact hit pays {strike.odds}× — nearby pays proportionally less"
										>up to {strike.odds}×</span
									></span
								>
							</button>
						{/each}
					</div>
					<div class="flex flex-col gap-1.5" role="group" aria-label="{label} PE strikes">
						{#each peStrikes as strike (strike.deltaPoints)}
							{@const isSelected =
								selected?.targetKind === 'down' && selected?.deltaPoints === strike.deltaPoints}
							<button
								type="button"
								class="flex min-h-[44px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition {isSelected
									? 'border-gold bg-gold/15 shadow-glow ring-1 ring-gold'
									: strike.atTheMoney
										? 'border-gold-dim/60 bg-zinc-50 hover:border-gold dark:bg-felt-800'
										: 'border-zinc-200 bg-zinc-50 hover:border-gold-dim dark:border-felt-700 dark:bg-felt-800'} {chipsEnabled
									? ''
									: 'cursor-not-allowed'}"
								aria-pressed={isSelected}
								aria-label="{formatNC(Math.round(strike.target))} PE"
								disabled={!chipsEnabled}
								on:click={() => pick(strike)}
							>
								<span class="num text-sm font-semibold text-down">
									{formatNC(Math.round(strike.target))} PE
									{strike.atTheMoney ? '· ATM' : ''}
								</span>
								<span class="num text-[10px] text-zinc-500 dark:text-zinc-500">
									{fmtSigned(-strike.deltaPoints)} ·
									<span
										class="text-gold-dim"
										title="Exact hit pays {strike.odds}× — nearby pays proportionally less"
										>up to {strike.odds}×</span
									></span
								>
							</button>
						{/each}
					</div>
				</div>
			</div>

			<!-- ── stake row ───────────────────────────────────────────────────────── -->
			<div>
				<div class="flex flex-wrap items-center gap-1.5">
					{#each [10, 50, 100] as amount (amount)}
						<button
							type="button"
							class="min-h-[44px] rounded-full border bg-zinc-50 px-3.5 text-xs font-semibold text-zinc-700 transition hover:border-gold-dim hover:text-gold dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-300"
							on:click={() => quickStake(amount)}
						>
							{amount}
						</button>
					{/each}
					<label class="sr-only" for="stake-{underlying}">Stake in NC for {label}</label>
					<input
						id="stake-{underlying}"
						class="nc-input num ml-auto w-28 py-1.5 text-right"
						type="text"
						inputmode="numeric"
						autocomplete="off"
						placeholder="stake"
						bind:value={stakeInput}
						on:input={() => (error = '')}
					/>
				</div>
				{#if stakeInput !== '' && !stakeOk}
					<p class="mt-1.5 text-xs text-down" role="status">{stakeError}</p>
				{/if}
				{#if selected && stakeOk && potential !== null}
					<p class="mt-1.5 text-xs text-zinc-600 dark:text-zinc-500">
						{formatNC(Math.round(selected.target))} exact pays
						<span class="num text-up">+{formatNC(potential)} NC</span>
						{#if projection}
							· if it closed now:
							<span class="num {projection.tier === 'miss' ? 'text-down' : 'text-up'}">
								{projection.tier === 'hit'
									? '🎯 hit'
									: projection.tier === 'flat'
										? '➖ flat'
										: '💀 miss'}
							</span>
						{/if}
					</p>
				{/if}
			</div>

			{#if error}
				<p class="nc-alert" role="alert">{error}</p>
			{/if}

			{#if editing}
				<div class="flex gap-2">
					<button
						type="button"
						class="nc-btn min-h-[44px] flex-1"
						disabled={!selected || !stakeOk || pending}
						on:click={() => (confirmOpen = true)}
					>
						{pending ? 'Saving…' : 'Review change'}
					</button>
					<button
						type="button"
						class="nc-btn-ghost min-h-[44px]"
						disabled={pending}
						on:click={stopEdit}
					>
						Keep as is
					</button>
				</div>
			{:else}
				<button
					type="button"
					class="nc-btn min-h-[48px] text-base"
					disabled={!canBet || !selected || !stakeOk || pending}
					on:click={() => (confirmOpen = true)}
				>
					{#if pending}
						Placing…
					{:else if !openPhase}
						{phase === 'pre' ? 'Bets open 15:15 IST' : 'Bets closed'}
					{:else if !selected}
						Pick a target
					{:else if !stakeOk}
						Enter a stake
					{:else}
						Place {formatNC(stakeValue)} NC
					{/if}
				</button>
			{/if}
		{/if}
	{/if}
</section>

<ConfirmModal
	open={confirmOpen}
	mode={editing ? 'edit' : 'place'}
	{label}
	targetKind={effective?.targetKind ?? 'up'}
	target={effective?.target ?? 0}
	prevClose={anchor}
	stake={stakeSafe}
	odds={effective?.odds ?? 1}
	balanceAfter={balance === null ? null : Math.max(0, balance - stakeSafe)}
	{pending}
	{error}
	on:confirm={confirmModal}
	on:cancel={() => {
		if (pending) return;
		confirmOpen = false;
		error = '';
	}}
/>
