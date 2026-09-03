<script lang="ts">
	import SubpageNav from '$lib/components/game/SubpageNav.svelte';
	import {
		LADDER_CONFIG,
		LADDER_UNDERLYINGS,
		MAX_HIT_ODDS,
		deadZoneHalfStep
	} from '$lib/config/ladder';
	import { INDEX_LABELS } from '$lib/stores/game';

	/** Short names for the table, in the ladder's stable order. */
	const rows = LADDER_UNDERLYINGS.map((u) => ({
		underlying: u,
		label: INDEX_LABELS[u],
		steps: LADDER_CONFIG[u].steps,
		tolerance: LADDER_CONFIG[u].tolerancePts,
		deadZone: deadZoneHalfStep(u)
	}));

	/** Worked example: NIFTY prev close 25,000, an UP +50 call, close 25,054. */
	const example = (() => {
		const stake = 100;
		const target = 25_050;
		const close = 25_054;
		const err = Math.abs(close - target);
		const tol = LADDER_CONFIG.nifty.tolerancePts;
		const accuracy = 1 - err / tol;
		return {
			stake,
			target,
			close,
			err,
			tol,
			accuracy,
			payout: Math.round(stake * MAX_HIT_ODDS * accuracy)
		};
	})();
</script>

<svelte:head>
	<title>How winning works · NiftyCasino</title>
	<meta
		name="description"
		content="How a NiftyCasino call pays: exact hits pay up to 28×, nearby pays proportionally less, a miss loses the stake, a flat market refunds."
	/>
</svelte:head>

<article
	class="mx-auto flex w-full max-w-2xl flex-col gap-6 py-8 text-sm text-zinc-700 dark:text-zinc-300"
>
	<SubpageNav />

	<header class="space-y-1.5">
		<h1 class="text-2xl font-semibold text-amber-600 dark:text-gold-glow">How winning works</h1>
		<p class="text-xs uppercase tracking-wide text-zinc-500">
			The whole game on one page — what you pick, how it pays, when money moves
		</p>
	</header>

	<!-- 1. The day -->
	<section class="nc-card p-5">
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">1 · The day in 30 seconds</h2>
		<ol class="mt-3 flex list-decimal flex-col gap-2 pl-5 leading-relaxed">
			<li>
				Between <strong>15:15 and 15:20 IST</strong> on a trading day, pick how each index will close
				— NIFTY 50, BANKNIFTY, SENSEX. Any subset: one call per index, and you can edit or cancel free
				until the 15:20 cutoff.
			</li>
			<li>
				Every call is measured from the index's <strong>previous official close</strong>. Your chip
				says e.g. <strong>▲ +50 → 25,050</strong>: you are calling that the official closing-auction
				value lands near 25,050.
			</li>
			<li>
				After the auction (~15:45 IST) the day <strong>settles automatically</strong> against the exchange's
				published close. Winnings land in your NC wallet; there is nothing to claim.
			</li>
		</ol>
	</section>

	<!-- 2. The three outcomes -->
	<section class="nc-card p-5">
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">2 · The three outcomes</h2>
		<ul class="mt-4 flex flex-col gap-3">
			<li
				class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-felt-800 dark:bg-felt-900/60"
			>
				<p class="font-semibold text-zinc-900 dark:text-zinc-100">
					🎯 Hit — graded by accuracy (up to {MAX_HIT_ODDS}×)
				</p>
				<p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
					Right direction, and the close lands inside your target's band. Exactly on target pays the
					full max — <strong>stake × {MAX_HIT_ODDS}</strong>. The further the close lands from your
					target, the less it pays, falling linearly to nothing at the band edge:
				</p>
				<p
					class="num mt-2 rounded-md bg-zinc-100 px-3 py-2 text-center text-zinc-900 dark:bg-felt-800 dark:text-zinc-100"
				>
					payout = stake × {MAX_HIT_ODDS} × (1 − miss-distance ÷ band)
				</p>
				<p class="mt-2 leading-relaxed text-zinc-600 dark:text-zinc-400">
					A ₹100-style example on a 100 NC stake: dead-on pays
					<strong>+{100 * MAX_HIT_ODDS} NC</strong>, halfway to the edge pays about half, landing
					right on the edge pays ~0. The multiplier rewards
					<strong>how close you were</strong> — never how far your target sat from the previous
					close. Every rung on the board carries the same {MAX_HIT_ODDS}× max.
				</p>
			</li>
			<li
				class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-felt-800 dark:bg-felt-900/60"
			>
				<p class="font-semibold text-zinc-900 dark:text-zinc-100">➖ Flat — dead-zone refund</p>
				<p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
					The index barely moved — inside the dead zone around the previous close. Your stake comes
					back in full: no win, no loss, whatever direction you picked. This is the only mercy rule,
					there so a do-nothing day doesn't wipe everyone out.
				</p>
			</li>
			<li
				class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-felt-800 dark:bg-felt-900/60"
			>
				<p class="font-semibold text-zinc-900 dark:text-zinc-100">💀 Miss — full loss</p>
				<p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-400">
					Everything else — wrong direction, or right direction but outside the band. The stake is
					lost in full. There is no consolation tier.
				</p>
			</li>
		</ul>
	</section>

	<!-- 3. Worked example -->
	<section class="nc-card p-5">
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">3 · A worked example</h2>
		<p class="mt-2 leading-relaxed text-zinc-600 dark:text-zinc-400">
			NIFTY's previous close is 25,000. You stake {example.stake} NC on <strong>▲ +50</strong>
			(target
			{example.target.toLocaleString('en-IN')}). The official close lands at
			{example.close.toLocaleString('en-IN')} — {example.err} points off target, inside the ±{example.tol}
			band:
		</p>
		<p
			class="num mt-3 rounded-md bg-zinc-100 px-3 py-2 text-center text-zinc-900 dark:bg-felt-800 dark:text-zinc-100"
		>
			accuracy 1 − {example.err}÷{example.tol} = {example.accuracy.toFixed(2)} → pays +{example.payout.toLocaleString(
				'en-IN'
			)} NC
		</p>
		<p class="mt-2 leading-relaxed text-zinc-600 dark:text-zinc-400">
			Had the close landed dead on 25,050 it would have paid +{(
				example.stake * MAX_HIT_ODDS
			).toLocaleString('en-IN')} NC. Had it closed at 25,100 — outside the band — it would have paid
			nothing.
		</p>
	</section>

	<!-- 4. The board -->
	<section class="nc-card p-5">
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">4 · The board, per index</h2>
		<p class="mt-1.5 text-zinc-600 dark:text-zinc-400">
			Each index offers four round-number moves, both directions. Same max everywhere; the band and
			the dead zone differ because the indices move on different scales.
		</p>
		<div class="mt-4 overflow-x-auto">
			<table class="w-full min-w-[480px] border-collapse text-left text-[13px]">
				<thead>
					<tr class="text-[11px] uppercase tracking-wide text-zinc-500">
						<th class="border-b border-zinc-200 px-2 py-1.5 dark:border-felt-700">Index</th>
						<th class="border-b border-zinc-200 px-2 py-1.5 dark:border-felt-700">Moves (pts)</th>
						<th class="border-b border-zinc-200 px-2 py-1.5 dark:border-felt-700">Hit band</th>
						<th class="border-b border-zinc-200 px-2 py-1.5 dark:border-felt-700"
							>Flat if |move| &lt;</th
						>
						<th class="border-b border-zinc-200 px-2 py-1.5 dark:border-felt-700">Exact pays</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row}
						<tr class="border-b border-zinc-100 last:border-0 dark:border-felt-800">
							<td class="num px-2 py-2 font-semibold text-zinc-900 dark:text-zinc-100"
								>{row.label}</td
							>
							<td class="num px-2 py-2">±{row.steps.join(' · ±')}</td>
							<td class="num px-2 py-2">±{row.tolerance}</td>
							<td class="num px-2 py-2">{row.deadZone}</td>
							<td class="num px-2 py-2">{MAX_HIT_ODDS}×</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- 5. Fine print -->
	<section
		class="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-felt-800 dark:bg-felt-900/40 dark:shadow-none"
	>
		<h2 class="text-base font-semibold text-amber-700 dark:text-gold">5 · Fine print</h2>
		<ul
			class="mt-2 flex list-disc flex-col gap-1.5 pl-5 leading-relaxed text-zinc-600 dark:text-zinc-400"
		>
			<li>Payouts round to whole NC chips; a near-edge hit on a tiny stake can round to 0.</li>
			<li>The dead zone is checked first — a flat market refunds even a wrong-direction call.</li>
			<li>
				One active bet per index per day; editing re-prices at the same board, cancelling refunds.
			</li>
			<li>
				Chips are play money with no cash value — entertainment only, 18+. Full legal terms <a
					href="/terms"
					class="underline decoration-gold-dim">here</a
				>.
			</li>
		</ul>
		<div class="mt-5 flex flex-col gap-2 sm:flex-row">
			<a href="/" class="nc-btn min-h-[44px] sm:w-auto sm:px-6">Place a call</a>
			<a href="/leaderboard" class="nc-btn-ghost min-h-[44px] sm:w-auto sm:px-6">See the board</a>
		</div>
	</section>
</article>
