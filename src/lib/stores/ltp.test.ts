/**
 * The client LTP schedule — pure helpers only, no `fetch`, no timers. The wire
 * (`startLtpFeed`) is a thin consumer of these: the refresh contract the product
 * asked for is one load before 15:00, 30s polls from 15:00 to 15:15:01, one
 * final load at 15:15:01, and stillness after.
 */
import { describe, expect, it } from 'vitest';
import { LTP_ANCHOR_HMS, LTP_REFRESH_START_HMS } from '$lib/config/app';
import { istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import { ltpPhaseAt, msUntilHms, parseLtpResponse } from './ltp';

const DAY = '2026-08-27'; // a Thursday
const at = (h: number, m: number, s: number, ms = 0): number =>
	istHmsToUtcMs(istDateStrToMidnightUtcMs(DAY), { h, m, s }) + ms;

describe('ltpPhaseAt — the three regimes of the day', () => {
	it.each([
		['the morning: one load, then stillness', at(9, 30, 0), 'early'],
		['one second before the refresh regime starts', at(14, 59, 59), 'early'],
		['15:00:00 exactly: the 30s polls begin', at(15, 0, 0), 'refresh'],
		['mid-regime', at(15, 7, 30), 'refresh'],
		['one second before the anchor', at(15, 15, 0), 'refresh'],
		['the anchor second: one final load, then the day is frozen', at(15, 15, 1), 'final'],
		['the cash session', at(15, 30, 0), 'final'],
		['late evening', at(21, 0, 0), 'final']
	])('%s → %s', (_label, nowMs, expected) => {
		expect(ltpPhaseAt(nowMs)).toBe(expected);
	});
});

describe('msUntilHms — phase-boundary one-shots', () => {
	it('counts down to 15:00 and 15:15:01 on the IST wall clock', () => {
		expect(msUntilHms(at(14, 59, 58), LTP_REFRESH_START_HMS)).toBe(2_000);
		expect(msUntilHms(at(15, 15, 0), LTP_ANCHOR_HMS)).toBe(1_000);
	});

	it('lands exactly on the wall-clock second, never early', () => {
		// 15:14:59.400 → 15:15:01.000 is 1,600 ms, not the 1,000 a naive diff would give.
		expect(msUntilHms(at(15, 14, 59, 400), LTP_ANCHOR_HMS)).toBe(1_600);
		expect(msUntilHms(at(15, 15, 0, 200), LTP_ANCHOR_HMS)).toBe(800);
	});

	it('returns null once the instant has passed today', () => {
		expect(msUntilHms(at(15, 15, 2), LTP_ANCHOR_HMS)).toBeNull();
		expect(msUntilHms(at(15, 0, 1), LTP_REFRESH_START_HMS)).toBeNull();
	});
});

describe('parseLtpResponse — tolerant body reading', () => {
	it('reads a well-formed body and passes the final flag through', () => {
		const body = {
			tradeDate: DAY,
			serverNow: at(15, 0, 0),
			final: false,
			quotes: {
				nifty: { value: 24630.2, changePts: 44.05, changePct: 0.18, prevClose: 24586.15, ts: 1 },
				sensex: { value: 78831.32, changePts: 250.32, changePct: 0.32, prevClose: 78581, ts: 2 }
			}
		};
		const parsed = parseLtpResponse(body);
		expect(parsed?.final).toBe(false);
		expect(parsed?.quotes.nifty).toMatchObject({ value: 24630.2 });
		expect(parsed?.quotes.banknifty).toBeNull();
	});

	it('marks the frozen anchor', () => {
		const parsed = parseLtpResponse({
			final: true,
			quotes: {
				nifty: { value: 24630.2, changePts: 44.05, changePct: 0.18, prevClose: 24586.15, ts: 9 }
			}
		});
		expect(parsed?.final).toBe(true);
	});

	it('drops junk entries instead of inventing prices', () => {
		const parsed = parseLtpResponse({
			quotes: {
				nifty: { value: 0, changePts: 0, changePct: 0, prevClose: null, ts: 1 }, // zero price
				banknifty: { value: '24,000', changePts: 0, changePct: 0, prevClose: null, ts: 2 }, // string
				sensex: { value: 80_000, changePts: 0, changePct: 0, prevClose: null, ts: Number.NaN } // bad ts
			}
		});
		expect(parsed?.quotes).toEqual({ nifty: null, banknifty: null, sensex: null });
	});

	it('returns null for a body that is not an object', () => {
		expect(parseLtpResponse(null)).toBeNull();
		expect(parseLtpResponse('nope')).toBeNull();
		expect(parseLtpResponse(undefined)).toBeNull();
	});
});
