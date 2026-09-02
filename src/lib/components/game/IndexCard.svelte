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
	 *   live value line → ladder chips → stake row → PLACE BET → confirm modal
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

	/** The ladder grouped by step so each row reads "▲ 50 → 25,050 | ▼ 50 → 24,950". */
	$: steps = groupByStep(options);

	function groupByStep(
		opts: LadderOption[]
	): { step: number; up: LadderOption | null; down: LadderOption | null }[] {
		const rows = new Map<number, { up: LadderOption | null; down: LadderOption | null }>();
		for (const option of opts) {
			const row = rows.get(option.deltaPoints) ?? { up: null, down: null };
			if (option.targetKind === 'up') row.up = option;
			else row.down = option;
			rows.set(option.deltaPoints, row);
		}
		return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([step, row]) => ({ step, ...row }));
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
					title="Move from the previous close"
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
			prev close
			<span class="num text-zinc-700 dark:text-zinc-400"
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
		{#if steps.length === 0 && loading && phase === 'pre'}
			<!-- The ladder has not landed yet (an anonymous→authed swap, a slow read).
			     Shimmer rather than declare the day ladder-less while the read runs. -->
			<Skeleton lines={4} label="Loading the {label} ladder" />
		{:else if steps.length === 0}
			<p
				class="rounded-lg border bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-felt-700 dark:bg-felt-800/60 dark:text-zinc-400"
			>
				No ladder for {label} today — the previous close has not landed yet.
			</p>
		{:else if !authed}
			<!-- Read-only board for a stranger: the ladder is the product's shop window. -->
			<div class="flex flex-col gap-1.5 opacity-60" aria-label="{label} targets (view only)">
				{#each steps as row (row.step)}
					<div class="grid grid-cols-2 gap-1.5">
						{#each [row.up, row.down] as option}
							{#if option}
								<div
									class="flex min-h-[44px] flex-col items-start rounded-lg border bg-zinc-50 px-2.5 py-1.5 text-left dark:border-felt-700 dark:bg-felt-800"
								>
									<span
										class="num text-[11px] font-semibold {option.targetKind === 'up'
											? 'text-up'
											: 'text-down'}"
									>
										{option.targetKind === 'up' ? '▲' : '▼'} ±{formatNC(option.deltaPoints)}
									</span>
									<span class="num text-sm font-semibold text-zinc-900 dark:text-zinc-100">
										{formatNC(Math.round(option.target))}
									</span>
									<span class="num text-[10px] text-gold-dim">{option.odds}×</span>
								</div>
							{/if}
						{/each}
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
						{myBet.targetKind === 'up' ? '▲' : '▼'}
						{myBet.targetKind === 'up' ? '+' : '−'}{formatNC(myBet.deltaPoints)}
					</span>
					<span class="num text-sm text-zinc-700 dark:text-zinc-300"
						>{formatNC(myBet.stake)} NC</span
					>
					<span class="num text-xs text-zinc-500">@ {myBet.odds}×</span>
					<span class="num text-xs text-up"
						>pays {formatNC(payoutFor('hit', myBet.stake, myBet.odds))}</span
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
			<div class="flex flex-col gap-1.5" role="group" aria-label="{label} targets">
				{#each steps as row (row.step)}
					<div class="grid grid-cols-2 gap-1.5">
						{#each [row.up, row.down] as option}
							{#if option}
								{@const isSelected =
									selected?.targetKind === option.targetKind &&
									selected?.deltaPoints === option.deltaPoints}
								<button
									type="button"
									class="flex min-h-[44px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition {isSelected
										? 'border-gold bg-gold/15 shadow-glow ring-1 ring-gold'
										: 'border-zinc-200 bg-zinc-50 hover:border-gold-dim dark:border-felt-700 dark:bg-felt-800'} {chipsEnabled
										? ''
										: 'cursor-not-allowed opacity-40'}"
									aria-pressed={isSelected}
									disabled={!chipsEnabled}
									on:click={() => pick(option)}
								>
									<span
										class="num text-[11px] font-semibold {option.targetKind === 'up'
											? 'text-up'
											: 'text-down'}"
									>
										{option.targetKind === 'up' ? '▲' : '▼'} ±{formatNC(option.deltaPoints)}
									</span>
									<span class="num text-sm font-semibold text-zinc-900 dark:text-zinc-100">
										{formatNC(Math.round(option.target))}
									</span>
									<span class="num text-[10px] text-gold-dim">{option.odds}×</span>
								</button>
							{/if}
						{/each}
					</div>
				{/each}
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
						{formatNC(Math.round(selected.target))} pays
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
						{phase === 'pre' ? 'Bets open 15:00 IST' : 'Bets closed'}
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
	deltaPoints={effective?.deltaPoints ?? 0}
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
