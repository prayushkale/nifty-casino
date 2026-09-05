/**
 * The chart-data tables (PLAN §5 T12, test plan D).
 *
 * Nothing here instantiates a chart: these are the pure functions CasChart feeds
 * `lightweight-charts` with, pinned on the two things a live chart can get silently
 * wrong — a point list the library refuses (duplicate/regressing times) and an axis
 * labelled in the wrong timezone (a CAS chart that reads 11:20 to a player in
 * London is not a stylistic slip, it is the wrong auction).
 */
import { describe, expect, it } from 'vitest';
import {
	dayDirection,
	formatIndexLevel,
	formatIstHm,
	formatIstHms,
	formatSignedPoints,
	istTickLabel,
	istWallClock,
	ticksToChartPoints,
	collapseLevels,
	type CasPoint
} from './chart';
import { APP_TIMEZONE_OFFSET_MIN } from '$lib/config/app';
import { istDateStrToMidnightUtcMs } from '$lib/time/ist';

/** A weekday to test against. */
const DAY = '2026-08-26';

/** Epoch ms of IST {h,m,s} on `DAY`. */
const at = (h: number, m: number, s: number, ms = 0): number =>
	istDateStrToMidnightUtcMs(DAY) + ((h * 60 + m) * 60 + s) * 1000 + ms;

// ---------------------------------------------------------------------------
// ticks → points
// ---------------------------------------------------------------------------

describe('ticksToChartPoints — ascending, deduped, library-safe', () => {
	it('converts epoch ms to whole UTC seconds', () => {
		const points = ticksToChartPoints([{ ts: at(15, 13, 30, 250), value: 25012.4 }]);
		expect(points).toEqual([{ time: Math.floor(at(15, 13, 30, 250) / 1000), value: 25012.4 }]);
	});

	it('drops non-finite and non-positive values — the indicative reads 0 outside the window', () => {
		const points = ticksToChartPoints([
			{ ts: at(15, 13, 30), value: 0 },
			{ ts: at(15, 13, 34), value: Number.NaN },
			{ ts: at(15, 13, 38), value: -12.5 },
			{ ts: at(15, 13, 42), value: 25010 }
		]);
		expect(points).toEqual([{ time: Math.floor(at(15, 13, 42) / 1000), value: 25010 }]);
	});

	it('dedupes on the whole second, keeping the LATER value of the pair', () => {
		// Two polls inside one second (a restart catch-up, or a backfill batch): the
		// library rejects a repeated time outright, so one of them has to go.
		const points = ticksToChartPoints([
			{ ts: at(15, 20, 0, 100), value: 25010 },
			{ ts: at(15, 20, 0, 900), value: 25014 }
		]);
		expect(points).toHaveLength(1);
		expect(points[0].value).toBe(25014);
	});

	it('drops a regressing ts instead of handing the library an unsorted series', () => {
		const points = ticksToChartPoints([
			{ ts: at(15, 20, 0), value: 25010 },
			{ ts: at(15, 19, 56), value: 25008 }, // out of order
			{ ts: at(15, 20, 4), value: 25011 }
		]);
		expect(points.map((p) => p.time)).toEqual([
			Math.floor(at(15, 20, 0) / 1000),
			Math.floor(at(15, 20, 4) / 1000)
		]);
	});

	it('never mutates the series it is handed', () => {
		const ticks: CasPoint[] = [
			{ ts: at(15, 20, 4), value: 25011 },
			{ ts: at(15, 20, 0), value: 25010 }
		];
		ticksToChartPoints(ticks);
		expect(ticks.map((t) => t.ts)).toEqual([at(15, 20, 4), at(15, 20, 0)]);
	});

	it('returns [] for an empty series, which is what an unstarted auction is', () => {
		expect(ticksToChartPoints([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// collapseLevels — one dot per price level, latest tick always shown
// ---------------------------------------------------------------------------

describe('collapseLevels — one dot per price level, latest tick always shown', () => {
	it('keeps each distinct price as a single dot at its first-seen time', () => {
		const pts = [
			{ time: 1, value: 25010 },
			{ time: 2, value: 25010 },
			{ time: 3, value: 25010 },
			{ time: 4, value: 25020 },
			{ time: 5, value: 25020 },
			{ time: 6, value: 25015 }
		];
		const out = collapseLevels(pts);
		expect(out.map((p) => p.time)).toEqual([1, 4, 6]);
		expect(out.map((p) => p.value)).toEqual([25010, 25020, 25015]);
	});

	it('returns [] for an empty path', () => {
		expect(collapseLevels([])).toEqual([]);
	});

	it('pins the latest tick even when it returns to an earlier level', () => {
		const out = collapseLevels([
			{ time: 1, value: 25010 },
			{ time: 2, value: 25020 },
			{ time: 3, value: 25010 } // back to an earlier level
		]);
		expect(out.map((p) => p.time)).toEqual([1, 2, 3]);
		expect(out.map((p) => p.value)).toEqual([25010, 25020, 25010]);
	});

	it('keeps a single all-flat tick as one point', () => {
		const out = collapseLevels([
			{ time: 1, value: 25010 },
			{ time: 2, value: 25010 }
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({ time: 1, value: 25010 });
	});

	it('never mutates the path it is handed', () => {
		const pts = [
			{ time: 1, value: 25010 },
			{ time: 2, value: 25010 }
		];
		collapseLevels(pts);
		expect(pts).toEqual([
			{ time: 1, value: 25010 },
			{ time: 2, value: 25010 }
		]);
	});
});

// ---------------------------------------------------------------------------
// day direction (the line colour)
// ---------------------------------------------------------------------------

describe('dayDirection — the newest indicative against the prev-close anchor', () => {
	const ticks = [
		{ ts: at(15, 14, 0), value: 25005 },
		{ ts: at(15, 14, 4), value: 25020 }
	];

	it.each([
		['above the anchor', 25000, 'up'],
		['below the anchor', 25040, 'down'],
		['exactly on the anchor', 25020, 'flat']
	])('%s', (_name, anchor, expected) => {
		expect(dayDirection(anchor, ticks)).toBe(expected);
	});

	it.each([
		['no anchor yet (the feed did not carry a prev close)', null],
		['a nonsense anchor', 0],
		['a non-finite anchor', Number.NaN]
	])('%s → unknown', (_name, anchor) => {
		expect(dayDirection(anchor as number | null, ticks)).toBe('unknown');
	});

	it('no ticks to judge → unknown, whatever the anchor', () => {
		expect(dayDirection(25000, [])).toBe('unknown');
	});

	it('judges the NEWEST tick, not the first — a day that turned around is coloured by where it ended', () => {
		expect(dayDirection(25000, ticks)).toBe('up');
		expect(dayDirection(25030, ticks)).toBe('down');
	});
});

// ---------------------------------------------------------------------------
// IST labels — the reason the formatters exist
// ---------------------------------------------------------------------------

describe('the IST axis labels', () => {
	it('labels a 09:30 UTC instant as 15:00 IST (+05:30, no DST)', () => {
		const epochSec = at(15, 0, 0) / 1000;
		expect(istWallClock(epochSec)).toEqual({ h: 15, m: 0, s: 0 });
		expect(formatIstHm(epochSec)).toBe('15:00');
	});

	it('labels the auction bookends correctly', () => {
		expect(formatIstHm(at(15, 13, 30) / 1000)).toBe('15:13');
		expect(formatIstHm(at(15, 42, 0) / 1000)).toBe('15:42');
		expect(formatIstHms(at(15, 20, 0) / 1000)).toBe('15:20:00');
	});

	it('rolls past midnight correctly (23:30 IST is the same instant as 18:00 UTC)', () => {
		const epochSec = istDateStrToMidnightUtcMs(DAY) / 1000 - 30 * 60;
		expect(formatIstHm(epochSec)).toBe('23:30');
	});

	it('pads single digits', () => {
		expect(formatIstHm(at(9, 5, 3) / 1000)).toBe('09:05');
		expect(formatIstHms(at(9, 5, 3) / 1000)).toBe('09:05:03');
	});

	it('is the offset the config declares — a config change cannot silently desync the axis', () => {
		expect(APP_TIMEZONE_OFFSET_MIN).toBe(330);
	});

	it('the tick-mark adapter maps a numeric time to HH:mm and falls back to null otherwise', () => {
		expect(istTickLabel(at(15, 20, 0) / 1000)).toBe('15:20');
		expect(istTickLabel('2026-08-26' as unknown as number)).toBeNull();
		expect(istTickLabel(Number.NaN)).toBeNull();
		// `null` is what the library treats as "use your default formatter".
		expect(istTickLabel({} as unknown as number)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

describe('formatIndexLevel / formatSignedPoints', () => {
	it('prints an index level with Indian grouping and two decimals', () => {
		expect(formatIndexLevel(25012.4)).toBe('25,012.40');
		expect(formatIndexLevel(820110.05)).toBe('8,20,110.05');
		expect(formatIndexLevel(25000)).toBe('25,000.00');
	});

	it('keeps the sign on a negative level', () => {
		expect(formatIndexLevel(-1234.5)).toBe('-1,234.50');
	});

	it('renders a non-finite level as an em dash, never as NaN', () => {
		expect(formatIndexLevel(Number.NaN)).toBe('—');
		expect(formatIndexLevel(Number.POSITIVE_INFINITY)).toBe('—');
	});

	it('formats a signed move with the Unicode minus and Indian grouping', () => {
		expect(formatSignedPoints(12)).toBe('+12');
		expect(formatSignedPoints(-80)).toBe('−80');
		expect(formatSignedPoints(-123456)).toBe('−1,23,456');
		expect(formatSignedPoints(0)).toBe('0');
		expect(formatSignedPoints(null)).toBe('—');
	});
});
