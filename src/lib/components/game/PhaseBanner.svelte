<script lang="ts">
	import {
		formatDurationShort,
		nextTradingDayName,
		nextWindowOpen,
		type GamePhase
	} from '$lib/stores/game';

	/**
	 * The one line that explains why the board is not taking bets.
	 *
	 * Rendered only for the four read-only phases — while the window is open the
	 * countdown pill says everything worth saying, and a banner repeating it would
	 * be noise. Every state is a sentence about what happens NEXT, never an error:
	 * outside the window is the normal state of the day, not a failure.
	 *
	 * T13 adds a live ⏱ to the two states where "when?" is the question a player
	 * actually has — `pre` (the ladder is up, the window is not) and
	 * `closed-weekend`. `now` is the drift-corrected ticker, so the countdown runs
	 * on the server's clock like every other timer on the page.
	 */
	export let phase: GamePhase;
	export let tradeDate: string;
	/** Drift-corrected epoch ms. `null` before the clock starts (SSR, first paint). */
	export let now: number | null = null;

	$: nextDay = nextTradingDayName(tradeDate);
	$: next = now === null ? null : nextWindowOpen(now);
</script>

{#if phase === 'pre'}
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-gold-dim/40 bg-gold/5 px-4 py-3 text-sm text-gold"
		role="status"
	>
		<span aria-hidden="true">⏳</span>
		<span>
			<strong class="font-semibold">Bets open at 15:15 IST.</strong>
			<span class="text-zinc-400">The ladder is up — study it, place your calls from 15:15.</span>
		</span>
		{#if next}
			<span
				class="num ml-auto inline-flex items-center gap-1.5 rounded-full border border-gold-dim/50 bg-gold/10 px-2.5 py-1 text-xs font-semibold"
				role="timer"
				aria-label="Time until betting opens"
			>
				<span aria-hidden="true">⏱</span>
				{formatDurationShort(next.ms)}
			</span>
		{/if}
	</div>
{:else if phase === 'locked'}
	<div
		class="flex items-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm text-zinc-700 shadow-sm dark:border-felt-700 dark:bg-felt-900/80 dark:text-zinc-300"
		role="status"
	>
		<span aria-hidden="true">🔒</span>
		<span>
			<strong class="font-semibold">Locked — awaiting official close.</strong>
			<span class="text-zinc-500">
				Bets are final. Payouts land once the exchange publishes the close.
			</span>
		</span>
	</div>
{:else if phase === 'settled'}
	<div
		class="flex items-center gap-2 rounded-xl border border-up/40 bg-up/5 px-4 py-3 text-sm text-up"
		role="status"
	>
		<span aria-hidden="true">🏁</span>
		<span>
			<strong class="font-semibold">Settled — see results.</strong>
			<span class="text-zinc-500">Today's calls are paid. The next window opens 15:15 IST.</span>
		</span>
	</div>
{:else if phase === 'closed-weekend'}
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-white px-4 py-3 text-sm text-zinc-700 shadow-sm dark:border-felt-700 dark:bg-felt-900/80 dark:text-zinc-300"
		role="status"
	>
		<span aria-hidden="true">🌙</span>
		<span>
			<strong class="font-semibold">Market closed — back {nextDay} 15:15 IST.</strong>
			<span class="text-zinc-500">No CAS on weekends, so there is nothing to call.</span>
		</span>
		{#if next}
			<span
				class="num ml-auto inline-flex items-center gap-1.5 rounded-full border bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-300"
				role="timer"
				aria-label="Time until the market opens"
			>
				<span aria-hidden="true">⏱</span>
				opens in {formatDurationShort(next.ms)}
			</span>
		{/if}
	</div>
{/if}
