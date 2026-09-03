<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { payoutFor } from '$lib/game/tier';
	import type { LadderUnderlying } from '$lib/config/ladder';
	import type { StateBet } from '$lib/server/state';
	import {
		cancelBet,
		formatNC,
		projectedPayout,
		INDEX_SHORT,
		type CasLatestByIndex,
		type GamePhase
	} from '$lib/stores/game';

	/**
	 * Today's legs, newest first (PLAN §4 "YOUR BETS TODAY").
	 *
	 * Three states a leg can be in, and the strip says each one differently:
	 *
	 *   LIVE (day not settled) — the if-closed-now projection, recomputed from the
	 *     same `computeTier` the settlement engine uses, so the strip and the payout
	 *     can never tell two stories about the same bet.
	 *   settled — 🎯 HIT +X · ➖ FLAT refund · 💀 MISS −stake, the verdict the server
	 *     actually recorded, with the NC it actually credited.
	 *   open + pre-cutoff — Edit (focus that index's card) and Cancel stay live.
	 */
	export let bets: StateBet[] = [];
	export let anchors: Record<LadderUnderlying, number | null>;
	export let latest: CasLatestByIndex;
	export let phase: GamePhase = 'pre';
	/** True when the strip belongs to a signed-in player; anonymous has no bets. */
	export let authed = false;

	const dispatch = createEventDispatcher<{ focus: LadderUnderlying }>();

	let pendingId: string | null = null;
	let error = '';

	$: live = phase === 'open' || phase === 'locked';

	async function doCancel(bet: StateBet): Promise<void> {
		if (pendingId !== null) return;
		pendingId = bet.id;
		error = '';
		const result = await cancelBet(bet.id);
		pendingId = null;
		if (!result.ok) error = result.message;
	}

	/** The sentence for one leg, from its state. */
	function legLine(bet: StateBet): { mark: string; text: string; tone: string } {
		if (bet.settlementTier) {
			const payout = bet.payout ?? 0;
			if (bet.settlementTier === 'hit') {
				return {
					mark: '🎯 HIT',
					text: `+${formatNC(payout)} NC`,
					tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-up/40 dark:bg-up/10 dark:text-up'
				};
			}
			if (bet.settlementTier === 'flat') {
				return {
					mark: '➖ FLAT',
					text: `refund ${formatNC(payout)} NC`,
					tone: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400'
				};
			}
			return {
				mark: '💀 MISS',
				text: `−${formatNC(bet.stake)} NC`,
				tone: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:border-down/40 dark:bg-down/10 dark:text-down'
			};
		}

		const projection = projectedPayout(
			bet,
			anchors,
			latest[bet.underlying]?.value ?? null,
			bet.stake
		);
		if (!projection) {
			return {
				mark: 'LIVE',
				text: 'waiting for the feed',
				tone: 'border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-500'
			};
		}
		if (projection.tier === 'hit') {
			return {
				mark: 'LIVE · if closed now 🎯',
				text: `+${formatNC(projection.payout)} NC`,
				tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-up/40 dark:bg-up/10 dark:text-up'
			};
		}
		if (projection.tier === 'flat') {
			return {
				mark: 'LIVE · if closed now ➖',
				text: `refund ${formatNC(projection.payout)} NC`,
				tone: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400'
			};
		}
		return {
			mark: 'LIVE · if closed now 💀',
			text: `−${formatNC(bet.stake)} NC`,
			tone: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:border-down/40 dark:bg-down/10 dark:text-down'
		};
	}

	const stakedTotal = (rows: StateBet[]): number =>
		rows.reduce((total, bet) => total + bet.stake, 0);
	$: totalStaked = stakedTotal(bets);
	$: projectedTotal = bets.reduce((total, bet) => {
		if (bet.settlementTier) return total + (bet.payout ?? 0);
		const projection = projectedPayout(
			bet,
			anchors,
			latest[bet.underlying]?.value ?? null,
			bet.stake
		);
		return total + (projection?.payout ?? 0);
	}, 0);
</script>

<section class="nc-card overflow-hidden" aria-label="Your bets today">
	<header
		class="flex items-baseline justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-felt-800"
	>
		<h2 class="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
			Your bets today
		</h2>
		{#if bets.length > 0}
			<p class="num text-[11px] text-zinc-500">
				{formatNC(totalStaked)} NC staked
				{#if live}
					· if closed now
					<span
						class={projectedTotal > totalStaked
							? 'text-emerald-600 dark:text-up'
							: projectedTotal < totalStaked
								? 'text-rose-600 dark:text-down'
								: 'text-zinc-500 dark:text-zinc-400'}
					>
						{projectedTotal >= totalStaked ? '+' : ''}{formatNC(projectedTotal)}
					</span>
				{/if}
			</p>
		{/if}
	</header>

	{#if !authed}
		<p class="px-4 py-6 text-sm text-zinc-500">
			<a href="/auth/login" class="text-amber-700 underline decoration-gold-dim dark:text-gold"
				>Log in</a
			>
			to see your calls here.
		</p>
	{:else if bets.length === 0}
		<div class="px-4 py-8 text-center">
			<p class="text-2xl" aria-hidden="true">🎲</p>
			<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Place your first bet</p>
			<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
				Pick a target on any index above — one bet per index, editable until 15:20 IST.
			</p>
		</div>
	{:else}
		{#if error}
			<p class="nc-alert mx-4 mt-3" role="alert">{error}</p>
		{/if}
		<ul class="divide-y divide-zinc-200 dark:divide-felt-800">
			{#each bets as bet (bet.id)}
				{@const line = legLine(bet)}
				<li class="flex items-center justify-between gap-3 px-4 py-3">
					<div class="min-w-0">
						<p
							class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold uppercase tracking-wide text-zinc-900 dark:text-zinc-200"
						>
							{INDEX_SHORT[bet.underlying]}
							<span
								class="num {bet.targetKind === 'up'
									? 'text-emerald-600 dark:text-emerald-600 dark:text-up'
									: 'text-rose-600 dark:text-down'}"
							>
								{bet.targetKind === 'up' ? '▲' : '▼'}{formatNC(bet.deltaPoints)}
							</span>
							<span class="num text-xs font-normal text-zinc-500">{formatNC(bet.stake)} NC</span>
						</p>
						<p class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							@ up to {bet.odds}× · exact pays {formatNC(payoutFor('hit', bet.stake, bet.odds))}
						</p>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<span
							class="num rounded-full border px-2.5 py-1 text-[11px] font-semibold {line.tone}"
							title={line.mark}
						>
							{line.text}
						</span>
						{#if !bet.settlementTier && live}
							<button
								type="button"
								class="min-h-[44px] rounded-lg px-2 text-xs font-medium text-amber-700 transition hover:text-amber-600 disabled:opacity-40 dark:text-gold dark:hover:text-gold-glow"
								disabled={pendingId === bet.id}
								on:click={() => dispatch('focus', bet.underlying)}
							>
								Edit
							</button>
							<button
								type="button"
								class="min-h-[44px] rounded-lg px-2 text-xs font-medium text-zinc-500 transition hover:text-rose-600 disabled:opacity-40 dark:hover:text-down"
								disabled={pendingId === bet.id}
								on:click={() => doCancel(bet)}
							>
								{pendingId === bet.id ? '…' : 'Cancel'}
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
