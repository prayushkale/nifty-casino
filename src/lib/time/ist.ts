/**
 * Pure IST wall-clock helpers.
 *
 * All trading-day logic runs on IST (UTC+5:30, no DST) regardless of server locale.
 * Implemented with UTC arithmetic only: shift an epoch timestamp by the fixed offset and
 * read back UTC fields — no Intl formatting, no locale dependence, deterministic everywhere.
 */
import { APP_TIMEZONE_OFFSET_MIN, type Hms } from '$lib/config/app';

const MS_PER_MINUTE = 60_000;
const OFFSET_MS = APP_TIMEZONE_OFFSET_MIN * MS_PER_MINUTE;

/**
 * The parts of an instant when read on the IST clock.
 * Reading UTC getters off a shifted date gives IST wall-clock fields.
 */
function istFields(d: Date): {
	y: number;
	mo: number;
	da: number;
	h: number;
	mi: number;
	s: number;
	ms: number;
	weekday: number;
} {
	const shifted = new Date(d.getTime() + OFFSET_MS);
	return {
		y: shifted.getUTCFullYear(),
		mo: shifted.getUTCMonth(),
		da: shifted.getUTCDate(),
		h: shifted.getUTCHours(),
		mi: shifted.getUTCMinutes(),
		s: shifted.getUTCSeconds(),
		ms: shifted.getUTCMilliseconds(),
		weekday: shifted.getUTCDay()
	};
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Strictly formatted IST calendar date, e.g. '2026-08-27'. */
const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an 'YYYY-MM-DD' calendar date into its UTC-midnight instant, or throw.
 * A NaN check alone is not enough: JS date parsing silently rolls impossible dates
 * forward ('2023-02-29' → 2023-03-01), so require the round-trip to match too.
 */
function parseIstDate(dateStr: string): Date {
	const d = new Date(`${dateStr}T00:00:00Z`);
	if (
		!IST_DATE_RE.test(dateStr) ||
		Number.isNaN(d.getTime()) ||
		d.toISOString().slice(0, 10) !== dateStr
	) {
		throw new Error(`invalid date string: ${dateStr}`);
	}
	return d;
}

/** 'YYYY-MM-DD' calendar date of an instant on the IST clock. */
export function istDateStr(d: Date = new Date()): string {
	const f = istFields(d);
	return `${f.y}-${pad2(f.mo + 1)}-${pad2(f.da)}`;
}

/**
 * Seconds elapsed since IST midnight for an instant, fractional to millisecond precision.
 * E.g. 09:30:15.500 IST → 34215.5
 */
export function secOfDayIst(d: Date = new Date()): number {
	const f = istFields(d);
	return f.h * 3600 + f.mi * 60 + f.s + f.ms / 1000;
}

/** {h,m,s} → seconds since midnight. */
export function hmsToSeconds({ h, m, s }: Hms): number {
	return h * 3600 + m * 60 + s;
}

/** Convert IST wall-clock {h,m,s} on a given epoch day into an absolute UTC ms timestamp. */
export function istHmsToUtcMs(epochMsOfDay: number, t: Hms): number {
	const midnightIstMs =
		Math.floor((epochMsOfDay + OFFSET_MS) / 86_400_000) * 86_400_000 - OFFSET_MS;
	return midnightIstMs + Math.round(hmsToSeconds(t) * 1000);
}

/** Inclusive on BOTH ends: start <= t <= end. Handles windows crossing midnight. */
export function isBetweenHMS(d: Date, start: Hms, end: Hms): boolean {
	const sec = secOfDayIst(d);
	const lo = hmsToSeconds(start);
	const hi = hmsToSeconds(end);
	if (lo <= hi) return sec >= lo && sec <= hi;
	return sec >= lo || sec <= hi; // window wraps past midnight
}

/** Saturday/Sunday check for an IST calendar date ('YYYY-MM-DD'). */
export function isWeekend(dateStr: string): boolean {
	// Parse as pure UTC date — no TZ shifts since we only need the weekday.
	const d = parseIstDate(dateStr);
	const wd = d.getUTCDay();
	return wd === 0 || wd === 6;
}

/** Shift an IST calendar date ('YYYY-MM-DD') by n days → next IST date string. */
export function shiftIstDate(dateStr: string, days: number): string {
	const d = parseIstDate(dateStr);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** ISO timestamp of IST midnight (as absolute ms) for a given IST date string — session boundaries. */
export function istDateStrToMidnightUtcMs(dateStr: string): number {
	return parseIstDate(dateStr).getTime() - OFFSET_MS;
}

/** Current instant's IST date + whether today is a trading day (weekend filter; holidays handled by data layer). */
export function istTodayIsTradingDay(now: Date = new Date()): boolean {
	return !isWeekend(istDateStr(now));
}
