/**
 * TDD coverage for the pure IST wall-clock helpers (`./ist`).
 *
 * Every instant in this suite is a FIXED absolute timestamp — an ISO string with an explicit
 * `Z`, or an epoch-ms number computed from one. `new Date()` without args and `Date.now()` are
 * never used, so results cannot depend on host timezone/locale or on when the suite runs.
 */
import { describe, expect, it } from 'vitest';
import {
	APP_TIMEZONE_OFFSET_MIN,
	AUCTION_END_HMS,
	AUCTION_START_HMS,
	CUTOFF_HMS,
	type Hms
} from '$lib/config/app';
import {
	hmsToSeconds,
	isBetweenHMS,
	isWeekend,
	istDateStr,
	istDateStrToMidnightUtcMs,
	istHmsToUtcMs,
	istTodayIsTradingDay,
	secOfDayIst,
	shiftIstDate
} from './ist';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** IST is a fixed UTC+5:30 — no DST — so plain UTC arithmetic describes the IST clock. */
const IST_OFFSET_MS = APP_TIMEZONE_OFFSET_MIN * MS_PER_MINUTE;

/** The absolute instant of an IST wall-clock time on an IST date (config-only arithmetic). */
function atIst(istDate: string, t: Hms, extraMs = 0): Date {
	const midnightIst = Date.parse(`${istDate}T00:00:00Z`) - IST_OFFSET_MS;
	return new Date(midnightIst + t.h * 3_600_000 + t.m * MS_PER_MINUTE + t.s * 1_000 + extraMs);
}

/** Whole seconds elapsed since IST midnight, truncating sub-second precision. */
function istWholeSecondsOfDay(epochMs: number): number {
	const intoDay = (((epochMs + IST_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
	return Math.floor(intoDay / 1000);
}

/** Split seconds-since-midnight back into {h,m,s}. */
function splitHms(totalSec: number): Hms {
	return {
		h: Math.floor(totalSec / 3600),
		m: Math.floor((totalSec % 3600) / 60),
		s: totalSec % 60
	};
}

const hms = (hour: number, minute: number, second = 0): Hms => ({ h: hour, m: minute, s: second });

describe('offset assumptions', () => {
	it('hard-coded fixtures below assume IST = UTC+05:30 (19_800_000 ms)', () => {
		expect(APP_TIMEZONE_OFFSET_MIN).toBe(330);
		expect(IST_OFFSET_MS).toBe(19_800_000);
	});
});

describe('istDateStr()', () => {
	it('formats an ordinary afternoon instant', () => {
		// 10:00:00Z + 5:30 = 15:30 IST — same calendar date.
		expect(istDateStr(new Date('2026-08-27T10:00:00Z'))).toBe('2026-08-27');
	});

	it('rolls into the next IST date when UTC and IST dates disagree', () => {
		// 2026-01-01T20:00:00Z is 2026-01-02 01:30 IST.
		expect(istDateStr(new Date('2026-01-01T20:00:00Z'))).toBe('2026-01-02');
	});

	it('flips exactly at IST midnight (18:30Z of the previous UTC day)', () => {
		expect(istDateStr(new Date('2026-08-26T18:29:59Z'))).toBe('2026-08-26');
		expect(istDateStr(new Date('2026-08-26T18:29:59.999Z'))).toBe('2026-08-26');
		expect(istDateStr(new Date('2026-08-26T18:30:00Z'))).toBe('2026-08-27');
	});

	it('handles end-of-month rollover on the IST clock', () => {
		// 2026-03-31T19:00:00Z -> 2026-04-01 00:30 IST (month + day both advance).
		expect(istDateStr(new Date('2026-03-31T19:00:00Z'))).toBe('2026-04-01');
		// Same IST evening, still March.
		expect(istDateStr(new Date('2026-03-31T18:00:00Z'))).toBe('2026-03-31');
	});

	it('handles year rollover on the IST clock', () => {
		expect(istDateStr(new Date('2025-12-31T18:29:59.999Z'))).toBe('2025-12-31');
		expect(istDateStr(new Date('2025-12-31T18:30:00Z'))).toBe('2026-01-01');
	});

	it('zero-pads month and day for every instant', () => {
		for (const iso of [
			'2026-01-01T20:00:00Z',
			'2026-02-03T00:00:00Z',
			'2026-12-31T18:30:00Z',
			'1970-01-01T00:00:00Z'
		]) {
			expect(istDateStr(new Date(iso))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});
});

describe('secOfDayIst()', () => {
	it('returns 0 at IST midnight, i.e. 18:30Z of the previous UTC day', () => {
		expect(secOfDayIst(new Date('2026-08-26T18:30:00Z'))).toBe(0);
		// One ms earlier is still the previous IST day, one ms shy of a full day.
		expect(secOfDayIst(new Date('2026-08-26T18:29:59.999Z'))).toBe(86_399.999);
	});

	it('keeps fractional milliseconds', () => {
		// 09:50:00.500Z + 5:30 = 15:20:00.5 IST — half a second past the bet cutoff.
		expect(secOfDayIst(new Date('2026-08-27T09:50:00.500Z'))).toBe(hmsToSeconds(CUTOFF_HMS) + 0.5);
		// 04:00:15.500Z + 5:30 = 09:30:15.5 IST.
		expect(secOfDayIst(new Date('2026-08-27T04:00:15.500Z'))).toBe(34_215.5);
	});

	it('is exact at second granularity for clean instants', () => {
		// 09:43:30Z + 5:30 = 15:13:30 IST == AUCTION_START_HMS.
		expect(secOfDayIst(new Date('2026-08-27T09:43:30Z'))).toBe(hmsToSeconds(AUCTION_START_HMS));
		// 10:12:00Z + 5:30 = 15:42:00 IST == AUCTION_END_HMS.
		expect(secOfDayIst(new Date('2026-08-27T10:12:00Z'))).toBe(hmsToSeconds(AUCTION_END_HMS));
	});

	it('advances monotonically across a whole IST day', () => {
		const start = Date.parse('2026-08-26T18:30:00Z'); // IST midnight
		let prev = secOfDayIst(new Date(start));
		expect(prev).toBe(0);
		for (let add = MS_PER_MINUTE; add < MS_PER_DAY; add += MS_PER_MINUTE) {
			const now = secOfDayIst(new Date(start + add));
			expect(now).toBeCloseTo(prev + 60, 6);
			prev = now;
		}
	});
});

describe('hmsToSeconds()', () => {
	it('converts the configured windows', () => {
		expect(hmsToSeconds({ h: 0, m: 0, s: 0 })).toBe(0);
		expect(hmsToSeconds(AUCTION_START_HMS)).toBe(54_810); // 15:13:30
		expect(hmsToSeconds(AUCTION_END_HMS)).toBe(56_520); // 15:42:00
		expect(hmsToSeconds(CUTOFF_HMS)).toBe(55_200); // 15:20:00
		expect(hmsToSeconds({ h: 23, m: 59, s: 59 })).toBe(86_399);
	});
});

describe('isBetweenHMS()', () => {
	describe('auction window 15:13:30 – 15:42:00 IST (does not wrap)', () => {
		const day = '2026-08-27';

		it('is false one second and one millisecond before the start', () => {
			expect(isBetweenHMS(atIst(day, hms(15, 13, 29)), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				false
			);
			expect(
				isBetweenHMS(atIst(day, AUCTION_START_HMS, -1), AUCTION_START_HMS, AUCTION_END_HMS)
			).toBe(false);
		});

		it('includes the start instant', () => {
			expect(isBetweenHMS(atIst(day, AUCTION_START_HMS), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				true
			);
		});

		it('is true inside the window', () => {
			expect(isBetweenHMS(atIst(day, hms(15, 20, 0)), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				true
			);
			expect(isBetweenHMS(atIst(day, hms(15, 41, 59)), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				true
			);
		});

		it('includes the end instant', () => {
			expect(isBetweenHMS(atIst(day, AUCTION_END_HMS), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				true
			);
		});

		it('is false one second past the end and well after it', () => {
			expect(isBetweenHMS(atIst(day, hms(15, 42, 1)), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				false
			);
			expect(isBetweenHMS(atIst(day, hms(16, 30, 0)), AUCTION_START_HMS, AUCTION_END_HMS)).toBe(
				false
			);
		});
	});

	describe('window wrapping past midnight, 23:00 – 01:00 IST', () => {
		const start = hms(23, 0, 0);
		const end = hms(1, 0, 0);

		it('includes the late-evening side', () => {
			// 2026-08-26 23:00:00 / 23:30:00 IST.
			expect(isBetweenHMS(atIst('2026-08-26', start), start, end)).toBe(true);
			expect(isBetweenHMS(atIst('2026-08-26', hms(23, 30, 0)), start, end)).toBe(true);
		});

		it('excludes the last second before the window opens', () => {
			expect(isBetweenHMS(atIst('2026-08-26', hms(22, 59, 59)), start, end)).toBe(false);
		});

		it('includes the early-morning side of midnight', () => {
			// 2026-08-27 00:30:00 IST lives on the next calendar date but same wrapped window.
			expect(isBetweenHMS(atIst('2026-08-27', hms(0, 30, 0)), start, end)).toBe(true);
		});

		it('includes the end instant and excludes one second past it', () => {
			expect(isBetweenHMS(atIst('2026-08-27', end), start, end)).toBe(true);
			expect(isBetweenHMS(atIst('2026-08-27', hms(1, 0, 1)), start, end)).toBe(false);
		});

		it('is false at midday', () => {
			expect(isBetweenHMS(atIst('2026-08-27', hms(12, 0, 0)), start, end)).toBe(false);
		});
	});

	describe('degenerate window where start === end', () => {
		const only = hms(15, 0, 0);

		it('matches a single instant rather than the whole day', () => {
			expect(isBetweenHMS(atIst('2026-08-27', only), only, only)).toBe(true);
			expect(isBetweenHMS(atIst('2026-08-27', hms(14, 59, 59)), only, only)).toBe(false);
			expect(isBetweenHMS(atIst('2026-08-27', hms(15, 0, 1)), only, only)).toBe(false);
		});
	});
});

describe('isWeekend()', () => {
	it('flags Saturday and Sunday', () => {
		// Mon 2026-08-24 .. Sun 2026-08-30 covers a full week in order.
		const week: Array<[string, boolean]> = [
			['2026-08-24', false],
			['2026-08-25', false],
			['2026-08-26', false],
			['2026-08-27', false],
			['2026-08-28', false],
			['2026-08-29', true],
			['2026-08-30', true]
		];
		for (const [date, expected] of week) {
			expect(isWeekend(date), date).toBe(expected);
		}
	});

	it('reads a date-only string, independent of the server clock zone', () => {
		// 2000-01-01 was a Saturday, so the 2nd is a Sunday.
		expect(isWeekend('2000-01-01')).toBe(true);
		expect(isWeekend('2000-01-02')).toBe(true);
		expect(isWeekend('2000-01-03')).toBe(false);
	});

	it('accepts the real leap day 2024-02-29', () => {
		// 2024-02-29 fell on a Thursday.
		expect(isWeekend('2024-02-29')).toBe(false);
	});

	it('throws on garbage input', () => {
		for (const bad of ['2026-13-99', 'abc', '', '2026-08-27T10:00:00Z']) {
			expect(() => isWeekend(bad), JSON.stringify(bad)).toThrow(/invalid date string/);
		}
	});

	it('throws on impossible calendar dates instead of rolling them forward', () => {
		for (const bad of ['2023-02-29', '2026-02-30', '2026-04-31']) {
			expect(() => isWeekend(bad), JSON.stringify(bad)).toThrow(/invalid date string/);
		}
	});
});

describe('shiftIstDate()', () => {
	it('shifts within a month, including backwards and by zero', () => {
		expect(shiftIstDate('2026-08-27', 3)).toBe('2026-08-30');
		expect(shiftIstDate('2026-08-27', -3)).toBe('2026-08-24');
		expect(shiftIstDate('2026-08-27', 0)).toBe('2026-08-27');
	});

	it('rolls across months: 2026-01-31 + 31 days lands on 2026-03-03', () => {
		expect(shiftIstDate('2026-01-31', 31)).toBe('2026-03-03');
		expect(shiftIstDate('2026-02-28', 1)).toBe('2026-03-01');
	});

	it('rolls across years', () => {
		expect(shiftIstDate('2025-12-31', 1)).toBe('2026-01-01');
		expect(shiftIstDate('2026-01-01', -1)).toBe('2025-12-31');
	});

	it('honours leap years: 2024-02-28 + 1 = 2024-02-29', () => {
		expect(shiftIstDate('2024-02-28', 1)).toBe('2024-02-29');
		expect(shiftIstDate('2024-02-29', -1)).toBe('2024-02-28');
	});

	it('keeps 2023 non-leap and skips 2100 (divisible by 100, not 400)', () => {
		expect(shiftIstDate('2023-02-28', 1)).toBe('2023-03-01');
		expect(shiftIstDate('2100-02-28', 1)).toBe('2100-03-01');
	});

	it('always returns a zero-padded YYYY-MM-DD string', () => {
		expect(shiftIstDate('2026-01-05', 4)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(shiftIstDate('2026-01-05', 4)).toBe('2026-01-09');
	});

	it('throws on garbage and impossible dates', () => {
		for (const bad of ['abc', '', 'not-a-date', '2026-13-99', '2023-02-29', '2026-02-30']) {
			expect(() => shiftIstDate(bad, 1), JSON.stringify(bad)).toThrow(/invalid date string/);
		}
	});
});

describe('istHmsToUtcMs()', () => {
	it('maps the bet cutoff on a known date to 09:50:00Z (15:20 IST)', () => {
		// Any epoch inside the IST day works as the anchor; 10:00Z is comfortably within 2026-08-27 IST.
		const anchor = Date.parse('2026-08-27T10:00:00Z');
		const got = istHmsToUtcMs(anchor, CUTOFF_HMS);
		expect(got).toBe(Date.parse('2026-08-27T09:50:00Z'));
		expect(new Date(got).toISOString()).toBe('2026-08-27T09:50:00.000Z');
	});

	it('maps the auction edges onto absolute instants', () => {
		const anchor = Date.parse('2026-08-27T10:00:00Z');
		expect(istHmsToUtcMs(anchor, AUCTION_START_HMS)).toBe(Date.parse('2026-08-27T09:43:30Z'));
		expect(istHmsToUtcMs(anchor, AUCTION_END_HMS)).toBe(Date.parse('2026-08-27T10:12:00Z'));
	});

	it('round-trips: building the IST clock of an instant reproduces that instant, second-truncated', () => {
		const anchors = [
			'2026-08-26T18:00:00Z', // straddles IST midnight
			'2026-08-27T05:00:00Z', // straddles UTC midnight
			'2026-01-01T18:00:00Z', // IST year rollover
			'2024-02-28T18:00:00Z', // leap day
			'2023-02-27T23:00:00Z',
			'2000-02-28T12:00:00Z',
			'2100-02-26T18:00:00Z',
			'2026-03-31T17:00:00Z', // IST month rollover
			'1969-12-31T17:00:00Z' // negative epoch ms
		];
		let checked = 0;
		for (const iso of anchors) {
			const base = Date.parse(iso);
			for (let add = 0; add <= MS_PER_DAY; add += 90_000) {
				const t = base + add;
				const istClock = splitHms(istWholeSecondsOfDay(t));
				// Dropping the wall-clock fields back in must land on the very same instant,
				// truncated to the second — proving the anchor day itself round-trips losslessly.
				expect(istHmsToUtcMs(t, istClock), `${iso}+${add}ms`).toBe(Math.floor(t / 1000) * 1000);

				// Zero o'clock of that IST day must equal the parsed IST date minus the offset.
				const istDay = istDateStr(new Date(t));
				expect(istHmsToUtcMs(t, hms(0, 0, 0)), `${iso}+${add}ms`).toBe(
					Date.parse(`${istDay}T00:00:00Z`) - IST_OFFSET_MS
				);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(8000);
	});

	it('is independent of where inside the IST day the anchor sits', () => {
		// 2026-08-27 IST runs from 2026-08-26T18:35Z-ish through 2026-08-27T18:25Z-ish,
		// crossing UTC midnight in between — both anchors must agree exactly.
		const early = Date.parse('2026-08-26T18:35:00Z'); // 00:05 IST
		const late = Date.parse('2026-08-27T05:25:00Z'); // 10:55 IST
		expect(istDateStr(new Date(early))).toBe(istDateStr(new Date(late)));
		expect(istHmsToUtcMs(early, CUTOFF_HMS)).toBe(istHmsToUtcMs(late, CUTOFF_HMS));
	});
});

describe('istDateStrToMidnightUtcMs()', () => {
	it("maps an IST date to 18:30Z of the previous UTC day ('2026-08-27' example)", () => {
		const ms = istDateStrToMidnightUtcMs('2026-08-27');
		expect(ms).toBe(Date.parse('2026-08-26T18:30:00Z'));
		expect(ms).toBe(1_787_769_000_000);
		expect(new Date(ms).toISOString()).toBe('2026-08-26T18:30:00.000Z');
	});

	it('yields a negative epoch at the Unix epoch boundary', () => {
		expect(istDateStrToMidnightUtcMs('1970-01-01')).toBe(Date.parse('1969-12-31T18:30:00Z'));
		expect(istDateStrToMidnightUtcMs('1970-01-01')).toBe(-19_800_000);
	});

	it('is the exact lower bound of the corresponding IST day', () => {
		for (const day of ['2024-02-29', '2026-01-01', '2025-12-31', '2026-08-27']) {
			const midnight = istDateStrToMidnightUtcMs(day);
			expect(istDateStr(new Date(midnight)), day).toBe(day);
			// One millisecond earlier still belongs to the previous IST date.
			expect(istDateStr(new Date(midnight - 1)), `${day}-1ms`).not.toBe(day);
		}
	});

	it('throws on garbage and impossible dates', () => {
		for (const bad of ['abc', '', '2026-13-99', '2026-02-30', '2021-02-29']) {
			expect(() => istDateStrToMidnightUtcMs(bad), JSON.stringify(bad)).toThrow(
				/invalid date string/
			);
		}
	});
});

describe('istTodayIsTradingDay()', () => {
	it('is true on a weekday', () => {
		expect(istTodayIsTradingDay(new Date('2026-08-27T10:00:00Z'))).toBe(true); // Thu
		expect(istTodayIsTradingDay(new Date('2026-08-28T10:00:00Z'))).toBe(true); // Fri
	});

	it('is false on the weekend as read on the IST clock', () => {
		expect(istTodayIsTradingDay(new Date('2026-08-29T10:00:00Z'))).toBe(false); // Sat
		expect(istTodayIsTradingDay(new Date('2026-08-30T10:00:00Z'))).toBe(false); // Sun
	});

	it('switches with IST midnight, not UTC midnight', () => {
		// Friday 23:59:59 IST ...
		expect(istTodayIsTradingDay(new Date('2026-08-28T18:29:59Z'))).toBe(true);
		// ... becomes Saturday 00:00:00 IST one millisecond later.
		expect(istTodayIsTradingDay(new Date('2026-08-28T18:30:00Z'))).toBe(false);
		// Sunday 23:59:59 IST -> Monday 00:00:00 IST.
		expect(istTodayIsTradingDay(new Date('2026-08-30T18:29:59Z'))).toBe(false);
		expect(istTodayIsTradingDay(new Date('2026-08-30T18:30:00Z'))).toBe(true);
	});
});
