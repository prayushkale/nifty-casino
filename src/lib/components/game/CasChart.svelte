<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ColorType,
		CrosshairMode,
		LineStyle,
		LineType,
		LineSeries,
		createChart,
		type IChartApi,
		type IPriceLine,
		type ISeriesApi,
		type LineData,
		type Time,
		type UTCTimestamp
	} from 'lightweight-charts';
	import type { StateBet } from '$lib/server/state';
	import type { LadderOption, LadderUnderlying } from '$lib/config/ladder';
	import { COSMETIC_INTERPOLATION } from '$lib/config/app';
	import { signedTargetPoints } from '$lib/game/tier';
	import {
		CHART_COLORS,
		dayDirection,
		formatIndexLevel,
		formatIstHm,
		formatIstHms,
		istTickLabel,
		ticksToChartPoints,
		type CasPoint
	} from '$lib/game/chart';
	import { formatNC, projectedPayout, type CasLiveValue, type GamePhase } from '$lib/stores/game';
	import Skeleton from './Skeleton.svelte';

	/**
	 * One auction chart (PLAN §4 "auction mode", §5 T12): the day's CAS line, the
	 * dashed gold target lines a bet hangs off, and the if-closed-now strip under it.
	 *
	 * Deliberately dumb about the feed. The ticks arrive as a prop from
	 * `$lib/stores/casStream` (via the page), so this component owns exactly three
	 * things: drawing, the price lines, and the preview arithmetic — which is the
	 * same `computeTier`/`projectedPayout` the settlement engine runs, fed the live
	 * indicative instead of the official close.
	 *
	 * SSR: the chart is instantiated in `onMount`, which never runs on the server,
	 * so the felt placeholder below is what a curl and the first paint both see.
	 * The `lightweight-charts` import itself is side-effect-free, so it is safe to
	 * sit in an SSR bundle; nothing touches `document` before `onMount`.
	 */
	export let underlying: LadderUnderlying;
	export let label: string;
	/** The day's ticks for this index, from the stream store. */
	export let ticks: CasPoint[] = [];
	/** The freshest display payload — the big number in the card header. */
	export let latest: CasLiveValue | null = null;
	/** Previous day's official close: the anchor every target line is measured from. */
	export let anchor: number | null = null;
	/** The player's active bet on this index, if any. Drives the target line + the strip. */
	export let myBet: StateBet | null = null;
	/**
	 * A ladder rung the player is picking but has not placed yet — the page passes it
	 * when it owns the selection, `null` while the selection lives inside
	 * `IndexCard` (today). Drawn as a second, thinner target line.
	 */
	export let selectedOption: LadderOption | null = null;
	export let phase: GamePhase = 'pre';

	/** Chart height — a 3-across desktop card and a stacked mobile card share it. */
	const HEIGHT = 190;
	/** The narrowest the chart is ever asked to draw (PLAN §4 mobile-first rule). */
	const MIN_WIDTH = 320;

	let container: HTMLDivElement | null = null;
	let chart: IChartApi | null = null;
	let series: ISeriesApi<'Line'> | null = null;
	/** Price lines we own, so a change in the bet set removes exactly the stale ones. */
	let priceLines: { key: string; line: IPriceLine }[] = [];
	/** Set once the chart exists — flips the placeholder off. */
	let ready = false;
	/** The crosshair readout, filled by `subscribeCrosshairMove`. */
	let crosshair: { time: string; value: string } | null = null;

	// ── derived display state (all pure functions of the props) ────────────────

	$: points = ticksToChartPoints(ticks);
	$: latestValue = latest && Number.isFinite(latest.value) ? latest.value : null;
	$: changePts = latest && Number.isFinite(latest.changePts) ? latest.changePts : null;
	$: direction = dayDirection(anchor, ticks);
	$: lineColor =
		direction === 'up'
			? CHART_COLORS.up
			: direction === 'down'
				? CHART_COLORS.down
				: CHART_COLORS.flat;
	/** The auction is over: the line stops moving and an overlay takes over. */
	$: frozen = phase === 'locked' || phase === 'settled' || phase === 'closed-weekend';
	$: settled = phase === 'settled';

	type TargetDef = { key: string; price: number; title: string };

	/**
	 * The gold dashed lines: one per active bet, plus the rung being picked. Keyed by
	 * `kind|id|target` so a re-render that changed nothing touches nothing —
	 * `createPriceLine` is not free and a 4s cadence would notice.
	 */
	function targetLineDefs(
		anchorValue: number | null,
		bet: StateBet | null,
		option: LadderOption | null
	): TargetDef[] {
		if (anchorValue === null || !Number.isFinite(anchorValue) || anchorValue <= 0) return [];
		const defs: TargetDef[] = [];
		const push = (key: string, signed: number): void => {
			const price = anchorValue + signed;
			defs.push({
				key,
				price,
				title: `${signed > 0 ? '+' : '−'}${formatNC(Math.abs(signed))} → ${formatIndexLevel(price)}`
			});
		};
		if (bet) push(`bet:${bet.id}`, signedTargetPoints(bet));
		if (option) {
			push(
				`option:${option.underlying}:${option.targetKind}:${option.deltaPoints}`,
				option.targetKind === 'up' ? option.deltaPoints : -option.deltaPoints
			);
		}
		return defs;
	}

	$: targetLines = targetLineDefs(anchor, myBet, selectedOption);

	type PreviewRow = { tier: 'hit' | 'flat' | 'miss'; text: string };

	/**
	 * The strip under the chart: what the live bet would pay if the auction closed at
	 * this instant. `projectedPayout` returns `null` for "no honest answer yet" (no
	 * usable anchor, no live value, or an `abstain` verdict) and that renders an em
	 * dash — never a zero, which would be a lie about a payout.
	 */
	function previewFor(
		bet: StateBet | null,
		anchorValue: number | null,
		value: number | null
	): PreviewRow | null {
		if (!bet) return null;
		const projection = projectedPayout(
			bet,
			{ [bet.underlying]: anchorValue } as Record<LadderUnderlying, number | null>,
			value,
			bet.stake
		);
		if (!projection) return null;
		const net = projection.payout - bet.stake;
		return {
			tier: projection.tier,
			text:
				projection.tier === 'hit'
					? `🎯 +${formatNC(net)}`
					: projection.tier === 'flat'
						? '➖ ±0'
						: `💀 −${formatNC(bet.stake)}`
		};
	}

	$: preview = previewFor(myBet, anchor, latestValue);

	/** The settled verdict, once `/api/state` reports the day as paid out. */
	function resultFor(bet: StateBet | null): PreviewRow | null {
		if (!bet || bet.settlementTier === null) return null;
		const tier = bet.settlementTier;
		const net = (bet.payout ?? 0) - bet.stake;
		return {
			tier,
			text:
				tier === 'hit'
					? `🎯 HIT +${formatNC(net)}`
					: tier === 'flat'
						? '➖ FLAT refunded'
						: `💀 MISS −${formatNC(bet.stake)}`
		};
	}

	$: result = settled ? resultFor(myBet) : null;

	// ── chart lifecycle ────────────────────────────────────────────────────────

	/**
	 * Flat-hold between the 4s ticks (PLAN §1 "tick-rate reality"): `WithSteps` draws
	 * each tick as a horizontal hold, so every pixel on this chart is a number the
	 * exchange actually sent. `COSMETIC_INTERPOLATION` is the off-switch Prayush has
	 * not asked for yet — see `$lib/config/app` before flipping it.
	 */
	function lineTypeFor(): LineType {
		return COSMETIC_INTERPOLATION ? LineType.Simple : LineType.WithSteps;
	}

	function toLineData(pointsIn: ReturnType<typeof ticksToChartPoints>): LineData<Time>[] {
		return pointsIn.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
	}

	/** Make the price lines on screen equal `targetDefs`: update, add, remove — nothing else. */
	function syncPriceLines(targetDefs: TargetDef[]): void {
		if (!series) return;
		const wanted = new Map(targetDefs.map((def) => [def.key, def]));
		const kept: { key: string; line: IPriceLine }[] = [];
		for (const existing of priceLines) {
			const def = wanted.get(existing.key);
			if (!def) {
				series.removePriceLine(existing.line);
				continue;
			}
			existing.line.applyOptions({ price: def.price, title: def.title });
			wanted.delete(existing.key);
			kept.push(existing);
		}
		for (const def of wanted.values()) {
			kept.push({
				key: def.key,
				line: series.createPriceLine({
					price: def.price,
					color: CHART_COLORS.target,
					lineWidth: 1,
					lineStyle: LineStyle.Dashed,
					axisLabelVisible: true,
					title: def.title
				})
			});
		}
		priceLines = kept;
	}

	function redraw(
		pointsIn: ReturnType<typeof ticksToChartPoints>,
		color: string,
		targetDefs: TargetDef[]
	): void {
		if (!series) return;
		series.applyOptions({ color, lineType: lineTypeFor() });
		series.setData(toLineData(pointsIn));
		syncPriceLines(targetDefs);
		// The whole auction fits on one screen by design (30 minutes, one index), so
		// keeping it all visible is the right viewport — and re-fitting on every append
		// costs nothing at a 4s cadence.
		chart?.timeScale().fitContent();
	}

	/** Resize without `autoSize` when the runtime ships no `ResizeObserver` (the library only warns). */
	function watchResize(): () => void {
		if (!container || !chart) return () => {};
		const apply = (): void => {
			if (!container || !chart) return;
			chart.resize(Math.max(MIN_WIDTH, container.clientWidth), HEIGHT);
		};
		if (typeof ResizeObserver === 'function') {
			const observer = new ResizeObserver(apply);
			observer.observe(container);
			return () => observer.disconnect();
		}
		window.addEventListener('resize', apply);
		return () => window.removeEventListener('resize', apply);
	}

	onMount(() => {
		if (!container) return;

		chart = createChart(container, {
			// `autoSize` needs ResizeObserver; when it is missing the explicit
			// width/height below are the fallback, and `watchResize` covers resizes.
			autoSize: typeof ResizeObserver === 'function',
			width: Math.max(MIN_WIDTH, container.clientWidth),
			height: HEIGHT,
			layout: {
				background: { type: ColorType.Solid, color: CHART_COLORS.background },
				textColor: CHART_COLORS.text,
				fontSize: 10,
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
			},
			grid: {
				vertLines: { color: CHART_COLORS.grid },
				horzLines: { color: CHART_COLORS.grid }
			},
			rightPriceScale: {
				visible: true,
				borderColor: CHART_COLORS.grid,
				scaleMargins: { top: 0.15, bottom: 0.15 }
			},
			timeScale: {
				borderColor: CHART_COLORS.grid,
				timeVisible: true,
				secondsVisible: false,
				rightOffset: 2,
				// IST, not the browser's offset: the CAS auction is an IST event and a
				// player in any timezone must read the same 15:20 cutoff.
				tickMarkFormatter: (time: Time) => istTickLabel(time)
			},
			localization: {
				timeFormatter: (time: Time) => istTickLabel(time) ?? ''
			},
			crosshair: {
				// Magnet: snap to the tick. The only honest price to quote is one the
				// feed actually sent, not an interpolated point between two of them.
				mode: CrosshairMode.Magnet,
				vertLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.grid },
				horzLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.grid }
			}
		});

		series = chart.addSeries(LineSeries, {
			lineWidth: 2,
			lineType: lineTypeFor(),
			color: lineColor,
			priceLineVisible: false,
			lastValueVisible: true,
			priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
		});
		series.setData([]);

		chart.subscribeCrosshairMove((param) => {
			const bar = param.seriesData.get(series as ISeriesApi<'Line'>) as
				| { value?: number }
				| undefined;
			if (!param.point || typeof param.time !== 'number' || typeof bar?.value !== 'number') {
				crosshair = null;
				return;
			}
			crosshair = { time: formatIstHms(param.time), value: formatIndexLevel(bar.value) };
		});

		redraw(points, lineColor, targetLines);
		ready = true;
		const stopResize = watchResize();

		return () => {
			stopResize();
			chart?.remove();
			chart = null;
			series = null;
			priceLines = [];
			ready = false;
			crosshair = null;
		};
	});

	// Data, colour and target lines are all props-driven: react instead of polling.
	//
	// Guarded by IDENTITY, not by change: the store hands every chart a new state
	// object on every heartbeat (15s) even when no tick arrived, and redrawing here
	// means `fitContent()` — which would yank a player who zoomed into a two-minute
	// stretch straight back out, every fifteen seconds. The store shares untouched
	// arrays precisely so this comparison can be cheap and exact.
	let drawnTicks: CasPoint[] | null = null;
	let drawnColor = '';
	let drawnTargets = '';

	$: targetKey = targetLines.map((def) => `${def.key}:${def.price}`).join('|');

	$: if (
		chart &&
		series &&
		(ticks !== drawnTicks || lineColor !== drawnColor || targetKey !== drawnTargets)
	) {
		drawnTicks = ticks;
		drawnColor = lineColor;
		drawnTargets = targetKey;
		redraw(points, lineColor, targetLines);
	}
</script>

<div
	class="flex min-w-0 flex-col rounded-xl border border-felt-700 bg-felt-900/60 p-3"
	data-chart={underlying}
>
	<!-- header: the big number, the move, the direction -->
	<div class="flex items-baseline justify-between gap-2">
		<span class="text-xs font-bold uppercase tracking-widest text-zinc-300">{label}</span>
		<span class="flex items-baseline gap-2">
			<span class="num text-lg font-semibold leading-none text-zinc-100">
				{latestValue === null ? '—' : formatIndexLevel(latestValue)}
			</span>
			<span
				class="num text-xs {direction === 'up'
					? 'text-up'
					: direction === 'down'
						? 'text-down'
						: 'text-zinc-500'}"
			>
				{#if changePts === null}
					—
				{:else if changePts === 0}
					0
				{:else}
					{changePts > 0 ? '▲' : '▼'}{formatIndexLevel(Math.abs(changePts)).replace(/\.00$/, '')}
				{/if}
			</span>
		</span>
	</div>

	<!-- the chart, or the felt placeholder that SSR and an empty day render -->
	<div class="relative mt-2" style={`height:${HEIGHT}px`} bind:this={container}>
		{#if !ready}
			<div
				class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-felt-700 bg-felt-900 px-3 text-center"
			>
				{#if ticks.length === 0 && !frozen}
					<!-- No snapshot yet (a slow read, or a client-side navigation into an
					     empty day): shimmer first, then hand the surface to the chart. -->
					<Skeleton variant="block" height={64} label="Loading the {label} chart" />
				{/if}
				<p class="text-[11px] leading-relaxed text-zinc-600">
					{#if ticks.length === 0}
						{frozen
							? 'No indicative ticks recorded for today.'
							: 'Waiting for the auction’s first indicative tick…'}
					{:else}
						Loading chart…
					{/if}
				</p>
			</div>
		{/if}
		{#if crosshair}
			<div
				class="pointer-events-none absolute right-2 top-2 rounded border border-felt-700 bg-felt-950/90 px-2 py-1 text-[10px] leading-tight"
			>
				<span class="num text-zinc-300">{crosshair.time}</span>
				<span class="num ml-2 text-gold">{crosshair.value}</span>
			</div>
		{/if}
	</div>

	<!-- overlay states: awaiting the official close, or the settled verdict -->
	{#if result}
		<div
			class="mt-2 flex items-center gap-2 rounded-lg border border-gold-dim/40 bg-gold/10 px-2.5 py-1.5"
		>
			<span class="num text-xs font-semibold text-gold-glow">{result.text}</span>
			<span class="text-[10px] uppercase tracking-widest text-zinc-500">settled</span>
		</div>
	{:else if frozen}
		<div
			class="mt-2 flex items-center gap-2 rounded-lg border border-felt-700 bg-felt-800/60 px-2.5 py-1.5"
		>
			<span class="text-[11px] text-zinc-400">⏳ awaiting official close…</span>
			<span class="text-[10px] text-zinc-600">re-reading every 30s</span>
		</div>
	{/if}

	<!-- payout preview: the same verdict the settlement engine will reach -->
	<div class="mt-2 min-h-[22px]">
		{#if preview && myBet}
			<p class="text-[11px] text-zinc-400">
				if closed now:
				<span
					class="num font-semibold {preview.tier === 'hit'
						? 'text-up'
						: preview.tier === 'flat'
							? 'text-zinc-300'
							: 'text-down'}">{preview.text}</span
				>
				<span class="text-zinc-600">
					· {myBet.targetKind === 'up' ? '▲' : '▼'}
					{formatNC(myBet.deltaPoints)} pts @ {myBet.odds}× on {formatNC(myBet.stake)} NC</span
				>
			</p>
		{:else if myBet}
			<p class="text-[11px] text-zinc-600">if closed now: —</p>
		{:else}
			<p class="text-[11px] text-zinc-600">
				no bet on {label} — a target line appears when you place one
			</p>
		{/if}
	</div>

	<p class="num mt-1 text-[10px] text-zinc-700">
		{#if points.length > 0}
			{formatIstHm(points[0].time)} → {formatIstHm(points[points.length - 1].time)} IST · {points.length}
			ticks
		{:else}
			15:13:30 → 15:42 IST
		{/if}
	</p>
</div>
