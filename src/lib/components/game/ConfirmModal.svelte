<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { formatNC } from '$lib/stores/game';
	import { payoutFor } from '$lib/game/tier';

	/**
	 * The last screen between a player and their chips (PLAN §5 T11: "confirmation
	 * modal with miss-warning copy").
	 *
	 * Everything it shows is arithmetic the client can already do — the same odds
	 * the ladder shipped, the same payout rule the server will apply — so this is a
	 * recap, not a promise. The one line it MUST say is the miss rule: a wrong call
	 * loses the whole stake, and only a dead-flat market refunds. That is the
	 * product's sharpest edge and it is stated in the plainest words we have,
	 * exactly where a player's thumb is.
	 */
	export let open = false;
	/** 'place' or 'edit' — the headline and the confirm button's word change. */
	export let mode: 'place' | 'edit' = 'place';
	export let label: string;
	export let targetKind: 'up' | 'down';
	export let deltaPoints: number;
	export let target: number;
	export let prevClose: number | null = null;
	export let stake: number;
	export let odds: number;
	/** What the wallet shows if this goes through — `null` when unknown. */
	export let balanceAfter: number | null = null;
	export let pending = false;
	export let error = '';

	const dispatch = createEventDispatcher<{ confirm: void; cancel: void }>();

	$: potential = payoutFor('hit', stake, odds);

	const arrow = (kind: 'up' | 'down'): string => (kind === 'up' ? '▲' : '▼');
	const dirWord = (kind: 'up' | 'down'): string => (kind === 'up' ? 'above' : 'below');
	const level = (n: number): string => formatNC(Math.round(n));

	function onKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape' && !pending) dispatch('cancel');
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<div class="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6">
		<div class="absolute inset-0 bg-black/75 backdrop-blur-sm" aria-hidden="true" />

		<div
			role="dialog"
			aria-modal="true"
			aria-label="{mode === 'edit' ? 'Confirm edit' : 'Confirm bet'} on {label}"
			class="relative w-full max-w-md rounded-2xl border border-gold-dim/40 bg-felt-900 p-5 shadow-glow"
		>
			<header class="flex items-start justify-between gap-3">
				<div>
					<p class="text-[11px] uppercase tracking-widest text-zinc-500">
						{mode === 'edit' ? 'Edit call' : 'Confirm call'}
					</p>
					<h2 class="text-lg font-semibold text-gold-glow">{label}</h2>
				</div>
				<button
					type="button"
					class="-mr-1 -mt-1 rounded-lg px-2 py-1 text-lg leading-none text-zinc-500 transition hover:text-zinc-200"
					aria-label="Close"
					on:click={() => dispatch('cancel')}>✕</button
				>
			</header>

			<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">The call</dt>
					<dd class="num font-semibold {targetKind === 'up' ? 'text-up' : 'text-down'}">
						{arrow(targetKind)}
						{targetKind === 'up' ? '+' : '−'}{formatNC(deltaPoints)}
					</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Target close</dt>
					<dd class="num font-semibold text-zinc-100">{level(target)}</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Previous close</dt>
					<dd class="num text-zinc-400">
						{prevClose === null ? '—' : level(prevClose)}
					</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Odds</dt>
					<dd class="num text-zinc-100">{odds}×</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">Stake</dt>
					<dd class="num font-semibold text-gold">{formatNC(stake)} NC</dd>
				</div>
				<div>
					<dt class="text-[11px] uppercase tracking-wide text-zinc-600">If you hit</dt>
					<dd class="num font-semibold text-up">+{formatNC(potential)} NC</dd>
				</div>
			</dl>

			<p
				class="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-xs leading-relaxed text-down"
			>
				<strong class="font-semibold">Wrong call = stake LOST (full loss).</strong>
				Only a dead-flat market refunds. {label} closing {dirWord(targetKind)}
				{formatNC(deltaPoints)}
				points by more than the band pays nothing.
			</p>

			{#if balanceAfter !== null}
				<p class="mt-3 text-xs text-zinc-500">
					Balance after:
					<span class="num text-zinc-300">{formatNC(balanceAfter)} NC</span>
				</p>
			{/if}

			{#if error}
				<p class="nc-alert mt-3" role="alert">{error}</p>
			{/if}

			<div class="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
				<button
					type="button"
					class="nc-btn min-h-[44px] flex-1"
					disabled={pending}
					on:click={() => dispatch('confirm')}
				>
					{pending ? 'Placing…' : mode === 'edit' ? 'Save bet' : `Place ${formatNC(stake)} NC`}
				</button>
				<button
					type="button"
					class="nc-btn-ghost min-h-[44px] sm:flex-1"
					disabled={pending}
					on:click={() => dispatch('cancel')}
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
