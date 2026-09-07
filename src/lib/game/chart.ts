/**
 * Pure chart-data preparation for the auction charts (PLAN §5 T12).
 *
 * Kept SEPARATE from `CasChart.svelte` on purpose: everything here is a table
 * function with no canvas, no `lightweight-charts` import and no store, so it is
 * unit-testable in plain node (`./chart.test.ts`) and reusable by any future
 * surface (history replay, `/u/<handle>` sparkline) without dragging the chart
 * library along.
 *
 * The one non-obvious rule in this file is the timezone. lightweight-charts
 * formats its time axis from the *browser's* local offset, and a CAS session is
 * an IST event: a player in London must read 15:20, not 11:50. So every point's
 * `time` is a plain UTC second — the library's native unit — and the IST
 * wall-clock is applied only inside the two formatters, which shift the instant
 * by the fixed +05:30 offset and read UTC getters off it. No `Intl`, no
 * `toLocaleTimeString`, no locale dependence: the same trick `$lib/time/ist` uses,
 * at second resolution because a chart axis never needs a date.
 */
import { APP_TIMEZONE_OFFSET_MIN } from '$lib/config/app';

/** One CAS observation as the feed and the chart both see it. `ts` is epoch ms. */
export type CasPoint = { ts: number; value: number };

/** A `lightweight-charts` line point: `time` is epoch SECONDS (UTC), never ms. */
export type ChartPoint = { time: number; value: number };

const OFFSET_MS = APP_TIMEZONE_OFFSET_MIN * 60_000;

/** Width below which the chart is asked to give up decoration rather than overflow. */
export const MIN_CHART_WIDTH = 320;

// ---------------------------------------------------------------------------
// points
// ---------------------------------------------------------------------------

/**
 * Ticks → chart points: ascending `time`, deduped on the whole second, non-finite
 * and non-positive values dropped.
 *
 * `lightweight-charts` rejects a repeated `time` outright, and two polls can land
 * inside the same second (server restart catch-up, a backfill batch), so the whole
 * second is the dedupe key here even though the feed dedupes on the millisecond.
 * On a collision the LATER value wins — it is the fresher observation of the same
 * second, and a chart that kept the stale one would show a move that never happened.
 */
export function ticksToChartPoints(ticks: readonly CasPoint[]): ChartPoint[] {
	const points: ChartPoint[] = [];
	let lastTime = -Infinity;
	for (const tick of ticks) {
		if (!Number.isFinite(tick.ts) || !Number.isFinite(tick.value) || tick.value <= 0) continue;
		const time = Math.floor(tick.ts / 1000);
		if (time < lastTime) continue; // out of order — the feed never sends this, but a merge might
		if (time === lastTime) {
			points[points.length - 1] = { time, value: tick.value }; // same second: newer wins
			continue;
		}
		lastTime = time;
		points.push({ time, value: tick.value });
	}
	return points;
}

/**
 * Collapse a CAS price path so each distinct price level is drawn at most once —
 * at its FIRST-seen time — instead of re-drawing every flat tick (which stacks
 * identical dots during a hold). The very latest tick is always kept as the
 * terminal point, so the current price stays pinned at the line's
 * `lastValueVisible` marker: a staircase whose body is one dot per move and
 * whose head reads the latest price.
 *
 * Exact-price dedupe, not epsilon: a 12.40 → 12.35 wiggle is a real move and
 * must not be swallowed; only genuine holds collapse. A return to an earlier
 * level is drawn again at its later time, which is how a two-way move reads.
 */
export function collapseLevels(points: readonly ChartPoint[]): ChartPoint[] {
	const out: ChartPoint[] = [];
	const seen = new Set<number>();
	for (const point of points) {
		if (seen.has(point.value)) continue;
		seen.add(point.value);
		out.push(point);
	}
	// Always keep the latest tick visible: if the collapsed head does not carry
	// the latest price (a return to an earlier level), re-draw that latest point
	// as the terminal dot so the line's head reads the current price. If it
	// already does (all-flat, or a plain advancing move), appending a same-price
	// dot would just re-introduce the duplicate we collapsed away.
	const last = points[points.length - 1];
	if (last && out[out.length - 1].value !== last.value) out.push(last);
	return out;
}

/**
 * Merge the LTP seed point into a collapsed CAS path for the chart.
 *
 * The LTP point's job is to seed the chart BEFORE the auction ticks exist — a
 * single dot at the price the spot market stopped at. Once the CAS line exists
 * (its ticks start at 15:13:30, BEFORE the 15:15:01 LTP freeze), the LTP point
 * is only kept when it genuinely precedes the line: `lightweight-charts`
 * requires strictly ascending times, and a page loaded mid-auction carries an
 * LTP timestamp NEWER than the first tick, which would make the whole day's
 * line fail to draw (the reported "movement is gone" bug). A point at or past
 * the first tick is dropped — the auction's own first indicative already
 * starts the line.
 */
export function mergeLtpAnchor(
	casPath: readonly ChartPoint[],
	ltpPoint: ChartPoint | null
): ChartPoint[] {
	if (ltpPoint === null) return [...casPath];
	if (casPath.length === 0) return [ltpPoint];
	return ltpPoint.time < casPath[0].time ? [ltpPoint, ...casPath] : [...casPath];
}

/**
 * Which way the day has moved, judged the way the game judges it: the newest
 * indicative against the previous day's official close (PLAN §0 "Anchor"). This
 * picks the line colour, so it is a display concern — `computeTier` remains the
 * only thing allowed to decide money.
 */
export type DayDirection = 'up' | 'down' | 'flat' | 'unknown';

export function dayDirection(anchor: number | null, ticks: readonly CasPoint[]): DayDirection {
	if (anchor === null || !Number.isFinite(anchor) || anchor <= 0) return 'unknown';
	for (let i = ticks.length - 1; i >= 0; i -= 1) {
		const value = ticks[i].value;
		if (!Number.isFinite(value)) continue;
		if (value > anchor) return 'up';
		if (value < anchor) return 'down';
		return 'flat';
	}
	return 'unknown';
}

// ---------------------------------------------------------------------------
// IST labels
// ---------------------------------------------------------------------------

/** The IST wall-clock parts of a chart `time` (epoch seconds). */
export function istWallClock(epochSec: number): { h: number; m: number; s: number } {
	const shifted = new Date(epochSec * 1000 + OFFSET_MS);
	return {
		h: shifted.getUTCHours(),
		m: shifted.getUTCMinutes(),
		s: shifted.getUTCSeconds()
	};
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** '15:20' — the time-axis tick label. ≤8 chars, which is what the axis asks for. */
export function formatIstHm(epochSec: number): string {
	const { h, m } = istWallClock(epochSec);
	return `${pad2(h)}:${pad2(m)}`;
}

/** '15:20:00' — the crosshair label, where the seconds are the information. */
export function formatIstHms(epochSec: number): string {
	const { h, m, s } = istWallClock(epochSec);
	return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * Adapter for `timeScale.tickMarkFormatter` / `localization.timeFormatter`, which
 * hand the chart's own `Time` shape through. Returns `'HH:mm'` for a numeric
 * timestamp and `null` for anything else so the library falls back to its default
 * rather than rendering `NaN:NaN` on a business-day time it was not given.
 */
export function istTickLabel(time: unknown): string | null {
	if (typeof time !== 'number' || !Number.isFinite(time)) return null;
	return formatIstHm(time);
}

// ---------------------------------------------------------------------------
// numbers + palette
// ---------------------------------------------------------------------------

/** Indian-digit grouping of an integer string: '2501240' → '25,01,240'. Same rule as `formatNC`. */
function groupIndian(digits: string): string {
	if (digits.length <= 3) return digits;
	const parts: string[] = [digits.slice(-3)];
	let rest = digits.slice(0, -3);
	while (rest.length > 2) {
		parts.unshift(rest.slice(-2));
		rest = rest.slice(0, -2);
	}
	if (rest.length > 0) parts.unshift(rest);
	return parts.join(',');
}

/**
 * An index level as the exchange prints it: two decimals, Indian grouping —
 * 25,012.40. Duplicated from `formatNC`'s grouping (that one rounds to whole
 * chips on purpose) rather than imported, so this module stays store-free.
 */
export function formatIndexLevel(n: number): string {
	if (!Number.isFinite(n)) return '—';
	const sign = n < 0 ? '-' : '';
	const [int, dec] = Math.abs(n).toFixed(2).split('.');
	return `${sign}${groupIndian(int)}.${dec}`;
}

/** Signed whole points for the header's move chip: +12 / −80 / 0. */
export function formatSignedPoints(n: number | null): string {
	if (n === null || !Number.isFinite(n)) return '—';
	const rounded = Math.round(n);
	if (rounded === 0) return '0';
	return `${rounded > 0 ? '+' : '−'}${groupIndian(String(Math.abs(rounded)))}`;
}

/**
 * The casino's chart palette — the dark felt of PLAN §4, not M.OI's light theme.
 * Kept here (not in Tailwind) because canvas cannot read Tailwind classes: the
 * chart needs the resolved hex of the same tokens the surrounding card uses.
 * Light-mode overrides live alongside (CHART_COLORS_LIGHT) and CasChart picks at
 * runtime — canvas can't read CSS vars either.
 */
export const CHART_COLORS = {
	/** felt-950 — the chart's own background, one shade under the felt-900 card. */
	background: '#09090b',
	/** felt-700 — grid lines, present but never competing with the line. */
	grid: '#23232d',
	/** zinc-300 — axis text. */
	text: '#d4d4d8',
	/** zinc-500 — the crosshair label's background border. */
	crosshair: '#71717a',
	/** gold — the dashed target lines a bet hangs off. */
	target: '#f5c451',
	/** up / down — the same two tokens the cards use for ▲ / ▼. */
	up: '#34d399',
	down: '#f87171',
	/** No anchor yet (or a dead-flat day): neutral zinc, never a fake direction. */
	flat: '#a1a1aa'
} as const;

export const CHART_COLORS_LIGHT = {
	background: '#ffffff',
	grid: '#e5e7eb',
	text: '#52525b',
	crosshair: '#a1a1aa',
	target: '#d97706',
	up: '#059669',
	down: '#dc2626',
	flat: '#71717a'
} as const;
