<script lang="ts">
	import { nextTradingDayName, type GamePhase } from '$lib/stores/game';

	/**
	 * The one line that explains why the board is not taking bets.
	 *
	 * Rendered only for the four read-only phases — while the window is open the
	 * countdown pill says everything worth saying, and a banner repeating it would
	 * be noise. Every state is a sentence about what happens NEXT, never an error:
	 * outside the window is the normal state of the day, not a failure.
	 */
	export let phase: GamePhase;
	export let tradeDate: string;

	$: nextDay = nextTradingDayName(tradeDate);
</script>

{#if phase === 'pre'}
	<div
		class="flex items-center gap-2 rounded-xl border border-gold-dim/40 bg-gold/5 px-4 py-3 text-sm text-gold"
		role="status"
	>
		<span aria-hidden="true">⏳</span>
		<span>
			<strong class="font-semibold">Bets open at 15:00 IST.</strong>
			<span class="text-zinc-400">The ladder is up — study it, place your calls from 15:00.</span>
		</span>
	</div>
{:else if phase === 'locked'}
	<div
		class="flex items-center gap-2 rounded-xl border border-felt-700 bg-felt-900/80 px-4 py-3 text-sm text-zinc-300"
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
			<span class="text-zinc-500">Today's calls are paid. The next window opens 15:00 IST.</span>
		</span>
	</div>
{:else if phase === 'closed-weekend'}
	<div
		class="flex items-center gap-2 rounded-xl border border-felt-700 bg-felt-900/80 px-4 py-3 text-sm text-zinc-300"
		role="status"
	>
		<span aria-hidden="true">🌙</span>
		<span>
			<strong class="font-semibold">Market closed — back {nextDay} 15:00 IST.</strong>
			<span class="text-zinc-500">No CAS on weekends, so there is nothing to call.</span>
		</span>
	</div>
{/if}
