/**
 * Fixed-interval horizontal gridlines for a chart.
 *
 * lightweight-charts picks its y-axis gridline step from a small set of "nice"
 * values (…, 50, 100, 200, …) driven by `tickMarkDensity` — so a step of 150
 * (or any exact per-index spacing) is unrepresentable as a built-in option. The
 * only honest way to draw gridlines exactly 50 / 100 / 150 index-points apart
 * is a series primitive that paints them itself from the price scale.
 *
 * The primitive owns a `series` reference it learns on `attached()`, then
 * draws a horizontal line for every multiple of `step` inside the price
 * scale's visible range. This gives exact, predictable gridline spacing per
 * index while the built-in axis labels continue to render as normal.
 *
 * Standalone, store-free module (no chart import, no stores) so it is
 * trivially attached from `CasChart.svelte` and clear of the Svelte/esbuild
 * inline-arrow pitfalls noted in the project skill.
 */

import type {
	IPrimitivePaneRenderer,
	IPrimitivePaneView,
	ISeriesPrimitive,
	ISeriesApi,
	LineData,
	PrimitivePaneViewZOrder,
	Time,
	SeriesAttachedParameter
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

type LineSeriesApi = ISeriesApi<'Line', Time, LineData<Time>>;

/** Mutable state shared between the primitive and its pane view / renderer. */
interface GridlineState {
	step: number;
	color: string;
	series: LineSeriesApi | null;
}

/**
 * A series primitive that paints horizontal gridlines every `step` price
 * points across the price scale, in `color`.
 */
export class FixedGridlinePrimitive implements ISeriesPrimitive<Time> {
	private readonly _state: GridlineState;
	private readonly _view: GridlinePaneView;

	constructor(step: number, color: string) {
		this._state = { step, color, series: null };
		this._view = new GridlinePaneView(this._state);
	}

	paneViews(): readonly IPrimitivePaneView[] {
		return [this._view];
	}

	/** Swap the line colour (light/dark theme flip) without detach/re-attach. */
	setColor(color: string): void {
		this._state.color = color;
	}

	updateAllViews(): void {
		// Nothing to recompute per-frame; the renderer reads live state via the
		// series' price scale, so a fresh draw picks up the visible range.
	}

	attached(param: SeriesAttachedParameter<Time>): void {
		this._state.series = param.series as LineSeriesApi;
	}

	detached(): void {
		this._state.series = null;
	}

	visible(): boolean {
		return true;
	}
}

class GridlinePaneView implements IPrimitivePaneView {
	private readonly _state: GridlineState;
	private readonly _renderer: GridlinePaneRenderer;

	constructor(state: GridlineState) {
		this._state = state;
		this._renderer = new GridlinePaneRenderer(this._state);
	}

	zOrder(): PrimitivePaneViewZOrder {
		return 'bottom';
	}

	renderer(): IPrimitivePaneRenderer {
		return this._renderer;
	}
}

class GridlinePaneRenderer implements IPrimitivePaneRenderer {
	private readonly _state: GridlineState;

	constructor(state: GridlineState) {
		this._state = state;
	}

	draw(target: CanvasRenderingTarget2D): void {
		const { step, color, series } = this._state;
		if (!Number.isFinite(step) || step <= 0 || !series) return;

		target.useMediaCoordinateSpace((scope) => {
			const range = series.priceScale().getVisibleRange();
			if (!range) return;
			const min = Math.min(range.from, range.to);
			const max = Math.max(range.from, range.to);
			const ctx = scope.context;
			ctx.strokeStyle = color;
			ctx.lineWidth = 1;
			ctx.lineCap = 'butt';
			ctx.beginPath();
			const start = Math.ceil(min / step) * step;
			for (let price = start; price <= max; price += step) {
				const y = series.priceToCoordinate(price);
				if (y === null) continue;
				ctx.moveTo(0, y + 0.5);
				ctx.lineTo(scope.mediaSize.width, y + 0.5);
			}
			ctx.stroke();
		});
	}
}
