<script lang="ts">
	import {
		formatCountdown,
		countdownToCutoff,
		nextTradingDayName,
		type GamePhase
	} from '$lib/stores/game';

	/**
	 * The cutoff clock (PLAN §4: "always-visible countdown pill").
	 *
	 * `now` is the drift-corrected tick from `$lib/stores/game`, never
	 * `Date.now()` — PLAN §6 R3 makes the server's clock the only clock, so a phone
	 * that is a minute behind cannot believe it still has a minute to bet.
	 */
	export let phase: GamePhase;
	export let now: number;
	export let cutoffAtMs: number | null = null;
	export let tradeDate: string;

	$: countdown = countdownToCutoff(now, cutoffAtMs);
	$: critical = countdown !== null && countdown.h === 0 && countdown.m === 0 && countdown.s <= 60;
	$: nextDay = nextTradingDayName(tradeDate);
</script>

{#if phase === 'open' && countdown}
	<span
		class="num inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors {critical
			? 'border-down/60 bg-down/15 text-down'
			: 'border-gold-dim/50 bg-gold/10 text-gold'}"
		role="timer"
		aria-label="Time left to place bets"
	>
		<span aria-hidden="true">⏱</span>
		{formatCountdown(countdown)}
		<span class="hidden font-sans font-normal text-zinc-400 sm:inline">to cutoff</span>
	</span>
{:else if phase === 'locked'}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400"
	>
		<span aria-hidden="true">🔒</span>
		locked
	</span>
{:else if phase === 'settled'}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400"
	>
		<span aria-hidden="true">🏁</span>
		next window 15:00 IST
	</span>
{:else if phase === 'closed-weekend'}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400"
	>
		<span aria-hidden="true">🌙</span>
		back {nextDay} 15:00 IST
	</span>
{:else}
	<span
		class="inline-flex items-center gap-1.5 rounded-full border bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400"
	>
		<span aria-hidden="true">⏳</span>
		bets open 15:00 IST
	</span>
{/if}
