<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
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
	import { BETTING_START_HMS, COSMETIC_INTERPOLATION } from '$lib/config/app';
	import { signedTargetPoints } from '$lib/game/tier';
	import {
		CHART_COLORS,
		CHART_COLORS_LIGHT,
		dayDirection,
		formatIndexLevel,
		formatIstHms,
		istTickLabel,
		ticksToChartPoints,
		type CasPoint
	} from '$lib/game/chart';
	import { theme } from '$lib/stores/theme';
	import {
		formatNC,
		nowIst,
		projectedPayout,
		type CasLiveValue,
		type GamePhase
	} from '$lib/stores/game';
	import { hmsToSeconds, secOfDayIst } from '$lib/time/ist';
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
	/**
	 * The last traded price (see `$lib/stores/ltp`). Before the cash session opens
	 * at 15:20 this is the ONLY thing the chart draws — a single point, never a
	 * line. Once CAS ticks arrive they draw FROM this point, so the cash line
	 * visibly grows out of the price the market actually stopped at.
	 */
	export let ltp: { value: number; ts: number } | null = null;
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
	export let isTheater = false;
	export let isFullscreen = false;
	export let displayHeight: number | null = null;
	const dispatch = createEventDispatcher<{
		theater: { on: boolean };
		fullscreen: { on: boolean };
	}>();

	/** Chart height — a 3-across desktop card and a stacked mobile card share it. */
	const HEIGHT = 220;
	$: effectiveHeight = displayHeight ?? HEIGHT;
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
	$: isLight = $theme === 'light';
	$: palette = isLight ? CHART_COLORS_LIGHT : CHART_COLORS;
	$: lineColor =
		direction === 'up' ? palette.up : direction === 'down' ? palette.down : palette.flat;
	/** The auction is over: the line stops moving and an overlay takes over. */
	$: frozen = phase === 'locked' || phase === 'settled' || phase === 'closed-weekend';
	$: settled = phase === 'settled';
	$: isAfter15 = (() => {
		const n = $nowIst;
		if (n === null || n === undefined) return false;
		return secOfDayIst(new Date(n)) >= hmsToSeconds(BETTING_START_HMS);
	})();
	$: showAwaiting = frozen && isAfter15;

	/**
	 * The LTP as the chart's FIRST point. Before 15:20 it is the only point (the
	 * chart deliberately draws no line from it — one dot at the price the spot
	 * market actually stopped at); after, the CAS ticks extend the line from here.
	 * A missing/never-stamped LTP renders nothing, never a guessed point.
	 */
	$: anchorPoints =
		ltp !== null &&
		Number.isFinite(ltp.value) &&
		ltp.value > 0 &&
		Number.isFinite(ltp.ts) &&
		ltp.ts > 0
			? [{ time: Math.floor(ltp.ts / 1000) as UTCTimestamp, value: ltp.value }]
			: [];
	$: displayPoints = points.length > 0 ? [...anchorPoints, ...points] : anchorPoints;
	$: hasLtpPoint = anchorPoints.length > 0;
	$: headerValue =
		latestValue !== null ? latestValue : hasLtpPoint && ltp !== null ? ltp.value : null;
	$: headerChange = changePts !== null ? changePts : hasLtpPoint && ltp !== null ? 0 : null;
	$: headerDirection =
		points.length > 0
			? direction
			: headerChange === null
				? 'flat'
				: headerChange > 0
					? 'up'
					: headerChange < 0
						? 'down'
						: 'flat';
	$: headerLineColor =
		headerDirection === 'up'
			? palette.up
			: headerDirection === 'down'
				? palette.down
				: palette.flat;

	/**
	 * The value the price scale is centered on: the freshest indicative when we
	 * have it, otherwise the previous-close anchor. While ticks are empty the
	 * synthetic flat line sits at `anchor`, and this centering keeps that line in
	 * the middle of the pane so the first real CAS tick visibly moves up or down
	 * instead of hugging the top/bottom border.
	 */
	$: centeringPrice =
		headerValue !== null && Number.isFinite(headerValue) && headerValue > 0
			? headerValue
			: anchor !== null && Number.isFinite(anchor) && anchor > 0
				? anchor
				: null;
	/** Half the price window around `centeringPrice` — 1.2% keeps every ladder target in view. */
	$: halfRange =
		centeringPrice !== null && Number.isFinite(centeringPrice) && centeringPrice > 0
			? Math.max(centeringPrice * 0.012, 120)
			: null;

	function makeCenteringProvider(price: number, half: number): unknown {
		return function (base: () => unknown): unknown {
			const info = base() as { priceRange?: { minValue: number; maxValue: number } } | null;
			if (!info || !info.priceRange) {
				return { priceRange: { minValue: price - half, maxValue: price + half } };
			}
			const lowDev = Math.abs(info.priceRange.minValue - price);
			const highDev = Math.abs(info.priceRange.maxValue - price);
			const need = Math.max(lowDev, highDev, half);
			const ext = need * 1.08;
			return { priceRange: { minValue: price - ext, maxValue: price + ext } };
		};
	}

	$: centeringProvider =
		centeringPrice !== null && halfRange !== null
			? // eslint-disable-next-line @typescript-eslint/no-explicit-any
				(makeCenteringProvider(centeringPrice, halfRange) as any)
			: null;

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

	$: preview = previewFor(myBet, anchor, headerValue);

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
					color: palette.target,
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
			chart.resize(Math.max(MIN_WIDTH, container.clientWidth), effectiveHeight);
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
			height: effectiveHeight,
			layout: {
				background: { type: ColorType.Solid, color: palette.background },
				textColor: palette.text
			},
			grid: {
				vertLines: { color: palette.grid },
				horzLines: { color: palette.grid }
			},
			rightPriceScale: {
				visible: true,
				borderColor: palette.grid,
				scaleMargins: { top: 0.15, bottom: 0.15 }
			},
			timeScale: {
				borderColor: palette.grid,
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
				vertLine: { color: palette.crosshair, labelBackgroundColor: palette.grid },
				horzLine: { color: palette.crosshair, labelBackgroundColor: palette.grid }
			}
		});

		series = chart.addSeries(LineSeries, {
			lineWidth: 2,
			lineType: lineTypeFor(),
			color: lineColor,
			priceLineVisible: false,
			lastValueVisible: true,
			// The lone 15:15 LTP point is an isolated marker until the first cash tick
			// connects to it — the marker is what makes a one-point chart a point.
			pointMarkersVisible: true,
			priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			autoscaleInfoProvider: (centeringProvider as any) ?? undefined
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

		redraw(displayPoints, headerLineColor, targetLines);
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
	let drawnTicks: unknown = null;
	let drawnColor = '';
	let drawnTargets = '';

	$: targetKey = targetLines.map((def) => `${def.key}:${def.price}`).join('|');

	$: if (chart && palette) {
		// Keep canvas in sync when the user flips light/dark without remounting.
		chart.applyOptions({
			layout: {
				background: { type: ColorType.Solid, color: palette.background },
				textColor: palette.text
			},
			grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
			rightPriceScale: { borderColor: palette.grid },
			timeScale: { borderColor: palette.grid },
			crosshair: {
				vertLine: { color: palette.crosshair, labelBackgroundColor: palette.grid },
				horzLine: { color: palette.crosshair, labelBackgroundColor: palette.grid }
			}
		});
		for (const pl of priceLines) {
			try {
				pl.line.applyOptions({ color: palette.target });
				// eslint-disable-next-line no-empty
			} catch {}
		}
	}

	$: if (chart && series && centeringProvider) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		series.applyOptions({ autoscaleInfoProvider: centeringProvider as any });
	}

	$: if (chart && effectiveHeight) {
		chart?.resize(Math.max(MIN_WIDTH, container?.clientWidth ?? MIN_WIDTH), effectiveHeight);
		chart?.timeScale().fitContent();
	}

	$: if (
		chart &&
		series &&
		((displayPoints as unknown) !== (drawnTicks as unknown) ||
			headerLineColor !== drawnColor ||
			targetKey !== drawnTargets)
	) {
		// drawnTicks is identity-guarded against displayPoints (either real ticks or synthetic flat)
		drawnTicks = displayPoints as unknown as CasPoint[];
		drawnColor = headerLineColor;
		drawnTargets = targetKey;
		redraw(displayPoints, headerLineColor, targetLines);
	}
</script>

<div
	class="flex min-w-0 flex-col rounded-xl border bg-white p-3 shadow-sm dark:border-felt-700 dark:bg-felt-900/60 dark:shadow-none {isFullscreen
		? 'border-gold-dim/40 shadow-card'
		: ''} {isTheater ? 'ring-1 ring-gold-dim/30' : ''}"
	data-chart={underlying}
>
	<!-- header: icons top-left + label, live number on the right -->
	<div class="flex items-center justify-between gap-2">
		<span class="inline-flex items-center gap-1.5">
			<button
				type="button"
				class="inline-flex h-7 w-7 items-center justify-center rounded-md border text-[11px] leading-none transition {isTheater
					? 'border-gold bg-gold/15 text-amber-700 dark:text-gold'
					: 'border-zinc-200 bg-white text-zinc-600 hover:border-gold-dim hover:text-gold dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400'}"
				title={isTheater
					? 'Exit theater — back to 3-wide'
					: 'Theater — expand this chart, hide the others'}
				aria-label={isTheater ? 'Exit theater mode' : 'Theater mode — expand this chart'}
				aria-pressed={isTheater}
				on:click={() => dispatch('theater', { on: !isTheater })}
			>
				<span aria-hidden="true">▭</span>
			</button>
			<button
				type="button"
				class="inline-flex h-7 w-7 items-center justify-center rounded-md border text-[11px] leading-none transition {isFullscreen
					? 'border-gold bg-gold/15 text-amber-700 dark:text-gold'
					: 'border-zinc-200 bg-white text-zinc-600 hover:border-gold-dim hover:text-gold dark:border-felt-700 dark:bg-felt-800 dark:text-zinc-400'}"
				title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen — fill the screen'}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen — fill the screen'}
				aria-pressed={isFullscreen}
				on:click={() => dispatch('fullscreen', { on: !isFullscreen })}
			>
				<span aria-hidden="true">⛶</span>
			</button>
			<span
				class="ml-1 text-sm font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-300"
				>{label}</span
			>
		</span>
		<span class="flex items-baseline gap-2">
			<span class="num text-xl font-semibold leading-none text-zinc-900 dark:text-zinc-100">
				{headerValue === null ? '—' : formatIndexLevel(headerValue)}
			</span>
			<span
				class="num text-xs {headerDirection === 'up'
					? 'text-up'
					: headerDirection === 'down'
						? 'text-down'
						: 'text-zinc-500'}"
			>
				{#if headerChange === null}
					—
				{:else if headerChange === 0}
					0
				{:else}
					{headerChange > 0 ? '▲' : '▼'}{formatIndexLevel(Math.abs(headerChange)).replace(
						/\.00$/,
						''
					)}
				{/if}
			</span>
		</span>
	</div>

	<!-- the chart, or the felt placeholder that SSR and an empty day render -->
	<div class="relative mt-2" style={`height:${effectiveHeight}px`} bind:this={container}>
		{#if !ready}
			<div
				class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-zinc-50 px-3 text-center dark:border-felt-700 dark:bg-felt-900"
			>
				{#if displayPoints.length === 0 && !showAwaiting}
					<!-- No LTP point and no cash ticks yet (slow ladder read): shimmer first, then hand the surface to the chart. -->
					<Skeleton variant="block" height={64} label="Loading the {label} chart" />
				{/if}
				<p class="text-xs leading-relaxed text-zinc-500 dark:text-zinc-600">
					{#if displayPoints.length === 0}
						{showAwaiting
							? 'No indicative ticks recorded for today.'
							: 'Waiting for the last traded price…'}
					{:else if points.length === 0}
						Last traded price — the cash-session line starts here at 15:20 IST
					{:else}
						Loading chart…
					{/if}
				</p>
			</div>
		{/if}
		{#if crosshair}
			<div
				class="pointer-events-none absolute right-2 top-2 rounded border bg-white/95 px-2 py-1 text-xs leading-tight shadow-sm dark:border-felt-700 dark:bg-felt-950/90"
			>
				<span class="num text-zinc-700 dark:text-zinc-300">{crosshair.time}</span>
				<span class="num ml-2 text-amber-600 dark:text-gold">{crosshair.value}</span>
			</div>
		{/if}
	</div>

	<!-- overlay states: awaiting the official close, or the settled verdict -->
	{#if result}
		<div
			class="mt-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 dark:border-gold-dim/40 dark:bg-gold/10"
		>
			<span class="num text-xs font-semibold text-amber-700 dark:text-gold-glow">{result.text}</span
			>
			<span class="text-xs uppercase tracking-widest text-zinc-500">settled</span>
		</div>
	{:else if showAwaiting}
		<div
			class="mt-2 flex items-center gap-2 rounded-lg border bg-zinc-50 px-2.5 py-1.5 dark:border-felt-700 dark:bg-felt-800/60"
		>
			<span class="text-xs text-zinc-600 dark:text-zinc-400">⏳ awaiting official close…</span>
			<span class="text-xs text-zinc-500">re-reading every 30s</span>
		</div>
	{/if}

	<!-- payout preview: the same verdict the settlement engine will reach -->
	<div class="mt-2 min-h-[22px]">
		{#if preview && myBet}
			<p class="text-xs text-zinc-600 dark:text-zinc-400">
				if closed now:
				<span
					class="num font-semibold {preview.tier === 'hit'
						? 'text-emerald-600 dark:text-up'
						: preview.tier === 'flat'
							? 'text-zinc-700 dark:text-zinc-300'
							: 'text-red-600 dark:text-down'}">{preview.text}</span
				>
				<span class="text-zinc-500">
					· {myBet.targetKind === 'up' ? '▲' : '▼'}
					{formatNC(myBet.deltaPoints)} pts @ {myBet.odds}× on {formatNC(myBet.stake)} NC</span
				>
			</p>
		{:else if myBet}
			<p class="text-xs text-zinc-500">if closed now: —</p>
		{:else}
			<p class="text-xs text-zinc-500">
				no bet on {label} — a target line appears when you place one
			</p>
		{/if}
	</div>
</div>
