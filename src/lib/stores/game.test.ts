/**
 * The game page's pure logic, as tables.
 *
 * Two of these functions are load-bearing for money and time — `bettingPhase`
 * decides whether a player may bet at all, `projectedPayout` decides what they are
 * told they will win — so both are pinned on their exact boundaries. The rest
 * (`countdownToCutoff`, `formatNC`, `stakeValidationError`) are the small
 * functions the whole screen reads. Everything here is pure: no fetches, no
 * stores, no clock — the instants are built from the IST helpers the server uses.
 */
import { describe, expect, it } from 'vitest';
import { CUTOFF_HMS } from '$lib/config/app';
import type { LadderOption, LadderUnderlying } from '$lib/config/ladder';
import { isWeekend, istDateStrToMidnightUtcMs, istHmsToUtcMs, shiftIstDate } from '$lib/time/ist';
import {
	bettingPhase,
	countdownToCutoff,
	formatCountdown,
	formatDurationShort,
	formatNC,
	isLivePhase,
	nextWindowOpen,
	projectedPayout,
	stakeValidationError,
	type GamePhase
} from './game';
import type { StatePayload } from '$lib/server/state';

// ---------------------------------------------------------------------------
// clock helpers — instants built the same way the server builds them
// ---------------------------------------------------------------------------

/** A weekday to test against; the guard below keeps the table honest. */
const WEEKDAY = '2026-08-26';
const SATURDAY = '2026-08-29';
expect(isWeekend(WEEKDAY)).toBe(false);
expect(isWeekend(SATURDAY)).toBe(true);

const midnight = (date: string): number => istDateStrToMidnightUtcMs(date);

/** An instant on `date` at IST {h,m,s} plus `ms`, as epoch ms. */
const at = (date: string, h: number, m: number, s: number, ms = 0): number =>
	istHmsToUtcMs(midnight(date), { h, m, s }) + ms;

/** The day's 15:20:00 IST cutoff, the same instant the session row would carry. */
const CUTOFF = at(WEEKDAY, CUTOFF_HMS.h, CUTOFF_HMS.m, CUTOFF_HMS.s);

/** A minimal `/api/state` slice — the real `StateSession` shape, filled in. */
const stateAt = (
	now: number,
	over: {
		tradeDate?: string;
		settled?: boolean;
		status?: 'open' | 'locked' | 'settling' | 'settled';
	} = {}
): Pick<StatePayload, 'tradeDate' | 'session'> => ({
	tradeDate: over.tradeDate ?? WEEKDAY,
	session: {
		exists: true,
		status: over.status ?? 'open',
		cutoffAtMs: CUTOFF,
		// The two window flags are the server's own view; the phase machine reads the
		// clock itself so a stale payload cannot show a closed window as open.
		bettingWindowOpen: !over.settled && now >= CUTOFF - 20 * 60_000 && now <= CUTOFF,
		auctionLive: false,
		settled: over.settled ?? false
	}
});

// ---------------------------------------------------------------------------
// bettingPhase
// ---------------------------------------------------------------------------

describe('bettingPhase — the 15:00 → 15:20 IST window on its exact boundaries', () => {
	it.each([
		['one tick before the window', at(WEEKDAY, 14, 59, 59, 999), 'pre'],
		['the opening instant itself', at(WEEKDAY, 15, 0, 0, 0), 'open'],
		['mid-window', at(WEEKDAY, 15, 9, 30, 0), 'open'],
		['one tick before the cutoff', at(WEEKDAY, 15, 19, 59, 999), 'open'],
		[
			'the cutoff instant — the window is inclusive on BOTH ends, as the server judges it',
			at(WEEKDAY, 15, 20, 0, 0),
			'open'
		],
		['one tick past the cutoff', at(WEEKDAY, 15, 20, 0, 1), 'locked'],
		['the auction, still betting', at(WEEKDAY, 15, 13, 30, 0), 'open'],
		['the auction, after the cutoff', at(WEEKDAY, 15, 30, 0, 0), 'locked'],
		['long after close', at(WEEKDAY, 21, 0, 0, 0), 'locked'],
		['the small hours of the same day', at(WEEKDAY, 0, 0, 0, 0), 'pre']
	] as const)('%s → %s', (_label, now, expected: GamePhase) => {
		expect(bettingPhase(stateAt(now), now)).toBe(expected);
	});

	it('agrees with the money path at the cutoff: a bet at 15:20:00.000 is legal, at .001 it is not', () => {
		// The service accepts a bet while `now <= session.cutoffAt`, so a UI that
		// locked its form one tick early would be refusing a bet the server takes.
		expect(bettingPhase(stateAt(CUTOFF), CUTOFF)).toBe('open');
		expect(bettingPhase(stateAt(CUTOFF + 1), CUTOFF + 1)).toBe('locked');
	});

	it('accepts a Date as well as an epoch number', () => {
		expect(bettingPhase(stateAt(CUTOFF), new Date(at(WEEKDAY, 15, 5, 0)))).toBe('open');
	});
});

describe('bettingPhase — the read-only phases outrank the clock', () => {
	it('a settled day stays settled however late it is', () => {
		for (const now of [at(WEEKDAY, 15, 19, 0), at(WEEKDAY, 15, 20, 0, 1), at(WEEKDAY, 23, 0, 0)]) {
			expect(bettingPhase(stateAt(now, { settled: true, status: 'settled' }), now)).toBe('settled');
		}
	});

	it('a weekend reads as closed even in what would be the betting window', () => {
		for (const now of [
			at(SATURDAY, 12, 0, 0),
			at(SATURDAY, 15, 5, 0),
			at(SATURDAY, 15, 19, 59, 999),
			at(SATURDAY, 15, 20, 0)
		]) {
			expect(bettingPhase(stateAt(now, { tradeDate: SATURDAY }), now)).toBe('closed-weekend');
		}
	});

	it('the next IST day after a Friday is closed, and it is the Saturday two days on', () => {
		const sunday = shiftIstDate(SATURDAY, 1);
		const now = at(sunday, 15, 5, 0);
		expect(isWeekend(sunday)).toBe(true);
		expect(bettingPhase(stateAt(now, { tradeDate: sunday }), now)).toBe('closed-weekend');
	});

	it('settled outranks weekend when both could be argued (a hand-settled day)', () => {
		const now = at(SATURDAY, 16, 0, 0);
		expect(
			bettingPhase(stateAt(now, { tradeDate: SATURDAY, settled: true, status: 'settled' }), now)
		).toBe('settled');
	});
});

// ---------------------------------------------------------------------------
// countdownToCutoff
// ---------------------------------------------------------------------------

describe('countdownToCutoff', () => {
	it('splits the remaining time into h/m/s', () => {
		expect(countdownToCutoff(CUTOFF - ((3 * 60 + 4) * 60 + 5) * 1000, CUTOFF)).toEqual({
			h: 3,
			m: 4,
			s: 5
		});
		expect(countdownToCutoff(CUTOFF - 4525 * 1000, CUTOFF)).toEqual({ h: 1, m: 15, s: 25 });
	});

	it('carries no fractional seconds and counts down to zero at the cutoff', () => {
		// Floor semantics: the pill reaches 00:00 at the exact cutoff instant, and
		// never shows a second it has not counted yet.
		expect(countdownToCutoff(CUTOFF - 59_999, CUTOFF)).toEqual({ h: 0, m: 0, s: 59 });
		expect(countdownToCutoff(CUTOFF - 60_000, CUTOFF)).toEqual({ h: 0, m: 1, s: 0 });
		expect(countdownToCutoff(CUTOFF - 60_001, CUTOFF)).toEqual({ h: 0, m: 1, s: 0 });
	});

	it.each([
		['exactly at the cutoff', CUTOFF],
		['one tick past it', CUTOFF + 1],
		['hours past it', CUTOFF + 3_600_000]
	] as const)('returns null %s', (_label, now) => {
		expect(countdownToCutoff(now, CUTOFF)).toBeNull();
	});

	it('returns null when there is no cutoff to count to', () => {
		expect(countdownToCutoff(at(WEEKDAY, 15, 0, 0), null)).toBeNull();
	});

	it('is drift-corrected: a clock 50s slow sees 50s more than its own time says', () => {
		const clientNow = Date.now();
		const cutoff = clientNow + 10_000;
		// Naive client arithmetic: 10s left, and the server says 60s.
		expect(countdownToCutoff(clientNow, cutoff)).toEqual({ h: 0, m: 0, s: 10 });
		// The same instant, corrected by the drift the last /api/state measured.
		const drift = -50_000; // serverNow − clientNow
		expect(countdownToCutoff(clientNow + drift, cutoff)).toEqual({ h: 0, m: 1, s: 0 });
	});
});

describe('formatCountdown', () => {
	it('drops the hours while they are zero, keeps them once they are not', () => {
		expect(formatCountdown({ h: 0, m: 4, s: 31 })).toBe('04:31');
		expect(formatCountdown({ h: 0, m: 0, s: 9 })).toBe('00:09');
		expect(formatCountdown({ h: 1, m: 4, s: 31 })).toBe('1:04:31');
	});
});

// ---------------------------------------------------------------------------
// projectedPayout
// ---------------------------------------------------------------------------

const NIFTY_ANCHOR = 25_000;

/** An option exactly as `/api/state`'s ladder carries it. */
const opt = (
	underlying: LadderUnderlying,
	targetKind: 'up' | 'down',
	deltaPoints: number,
	odds: number
): LadderOption => ({
	underlying,
	targetKind,
	deltaPoints,
	odds,
	target: NIFTY_ANCHOR + deltaPoints
});

const anchors = (nifty: number | null): Record<LadderUnderlying, number | null> => ({
	nifty,
	banknifty: 56_000,
	sensex: 82_000
});

describe('projectedPayout — the same verdicts the settlement engine reaches', () => {
	const up50 = opt('nifty', 'up', 50, 6);

	it('shows a hit when the live value sits on the target', () => {
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_050, 100)).toEqual({
			tier: 'hit',
			payout: 600,
			accuracy: 1
		});
	});

	it('grades the payout by accuracy: halfway pays half, the edge pays nothing', () => {
		// err 7.5 of tol 15 → accuracy 0.5 → half the exact payout.
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_057.5, 100)).toEqual({
			tier: 'hit',
			payout: 300,
			accuracy: 0.5
		});
		// Inclusive edge is still a hit tier, but accuracy 0 prices nothing.
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_065, 100)).toEqual({
			tier: 'hit',
			payout: 0,
			accuracy: 0
		});
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_065.01, 100)).toEqual({
			tier: 'miss',
			payout: 0,
			accuracy: 1
		});
	});

	it('shows the flat refund inside the dead zone, in either direction', () => {
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_010, 100)).toEqual({
			tier: 'flat',
			payout: 100,
			accuracy: 1
		});
		expect(
			projectedPayout(opt('nifty', 'down', 50, 6), anchors(NIFTY_ANCHOR), 25_010, 100)
		).toEqual({ tier: 'flat', payout: 100, accuracy: 1 });
		// Exactly half a step is a real move, not a refund.
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_025, 100)?.tier).toBe('miss');
	});

	it('shows the full loss for a wrong direction and for an overshot target', () => {
		expect(
			projectedPayout(opt('nifty', 'down', 50, 6), anchors(NIFTY_ANCHOR), 25_050, 100)
		).toEqual({ tier: 'miss', payout: 0, accuracy: 1 });
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_200, 100)).toEqual({
			tier: 'miss',
			payout: 0,
			accuracy: 1
		});
	});

	it('measures the move from the anchor, never from zero', () => {
		// The same 50-point move at a different anchor level: still a hit.
		expect(projectedPayout(up50, { ...anchors(null), nifty: 10_000 }, 10_050, 100)?.tier).toBe(
			'hit'
		);
	});

	it('quotes a stake of 1 NC by default, which is the bare multiplier', () => {
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_050)).toEqual({
			tier: 'hit',
			payout: 6,
			accuracy: 1
		});
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_010)).toEqual({
			tier: 'flat',
			payout: 1,
			accuracy: 1
		});
	});

	it('rounds a fractional-odds payout to whole chips', () => {
		expect(projectedPayout(up50, anchors(NIFTY_ANCHOR), 25_050, 111)?.payout).toBe(666);
		expect(
			projectedPayout(opt('nifty', 'up', 100, 4.5), anchors(NIFTY_ANCHOR), 25_100, 111)?.payout
		).toBe(500); // 499.5, rounded half up
	});

	it.each([
		['no anchor for the index', anchors(null), 25_050],
		['no live value yet', anchors(NIFTY_ANCHOR), null],
		['a non-finite live value', anchors(NIFTY_ANCHOR), Number.NaN],
		['a non-positive stake', anchors(NIFTY_ANCHOR), 25_050]
	] as const)('returns null — no honest answer — when %s', (_label, a, value) => {
		const stake = _label === 'a non-positive stake' ? 0 : 100;
		expect(projectedPayout(up50, a, value, stake)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// formatNC
// ---------------------------------------------------------------------------

describe('formatNC — en-IN grouping', () => {
	it.each([
		[0, '0'],
		[7, '7'],
		[99, '99'],
		[999, '999'],
		[1000, '1,000'],
		[10_000, '10,000'],
		[1_00_000, '1,00,000'],
		[4_82_150, '4,82,150'],
		[10_00_000, '10,00,000'],
		[12_34_567, '12,34,567'],
		[-2500, '-2,500'],
		[-4_82_150, '-4,82,150']
	] as const)('formats %p as %p', (input, expected) => {
		expect(formatNC(input)).toBe(expected);
	});

	it('rounds fractional chips to the nearest whole one', () => {
		expect(formatNC(999.4)).toBe('999');
		expect(formatNC(999.6)).toBe('1,000');
		expect(formatNC(-100.5)).toBe('-101');
	});

	it('never emits NaN or Infinity', () => {
		expect(formatNC(Number.NaN)).toBe('0');
		expect(formatNC(Number.POSITIVE_INFINITY)).toBe('0');
	});
});

// ---------------------------------------------------------------------------
// stakeValidationError
// ---------------------------------------------------------------------------

describe('stakeValidationError', () => {
	it('accepts every stake the server would', () => {
		for (const stake of [10, 100, 100_000]) {
			expect(stakeValidationError(stake, 100_000)).toBeNull();
		}
		// At the top of the wallet, not above it.
		expect(stakeValidationError(1000, 1000)).toBeNull();
		// A wallet of unknown size cannot be checked against.
		expect(stakeValidationError(500, null)).toBeNull();
	});

	it('accepts the keypad string, including en-IN grouping', () => {
		expect(stakeValidationError('50', 1000)).toBeNull();
		expect(stakeValidationError(' 50 ', 1000)).toBeNull();
		expect(stakeValidationError('1,000', 5000)).toBeNull();
	});

	it.each([[''], ['   '], [null], [undefined]] as const)('asks for a stake on %p', (stake) => {
		expect(stakeValidationError(stake, 1000)).toMatch(/Enter a stake/i);
	});

	it.each([['abc'], ['10 NC'], ['1.2.3']] as const)('rejects %p as not a number', (stake) => {
		expect(stakeValidationError(stake, 1000)).toMatch(/number/i);
	});

	it.each([[10.5], ['10.5'], [0.5]] as const)('rejects %p as not a whole number', (stake) => {
		expect(stakeValidationError(stake, 1000)).toMatch(/whole number/i);
	});

	it.each([[0], [-1], [-1000]] as const)('rejects %p as not more than zero', (stake) => {
		expect(stakeValidationError(stake, 1000)).toMatch(/more than zero/i);
	});

	it.each([[9], [1]] as const)('rejects %p as below the 10 NC minimum', (stake) => {
		expect(stakeValidationError(stake, 1000)).toMatch(/Minimum stake is 10 NC/);
	});

	it.each([[100_001], [1_000_000]] as const)('rejects %p as above the maximum', (stake) => {
		expect(stakeValidationError(stake, 1_000_000)).toMatch(/Maximum stake is 1,00,000 NC/);
	});

	it.each([
		[2000, 1000],
		[11, 10],
		['1001', 1000]
	] as const)('rejects %p when the wallet holds only %p', (stake, balance) => {
		expect(stakeValidationError(stake, balance)).toMatch(/Only .* NC in your wallet/);
	});

	it('spends the whole wallet happily, one NC above it is refused', () => {
		expect(stakeValidationError(1000, 1000)).toBeNull();
		expect(stakeValidationError(1001, 1000)).toMatch(/wallet/);
	});
});

// ---------------------------------------------------------------------------
// the live-phase helper the page gates its CAS poll on
// ---------------------------------------------------------------------------

describe('isLivePhase', () => {
	it.each([
		['pre', false],
		['open', true],
		['locked', true],
		['settled', false],
		['closed-weekend', false]
	] as const)('%s → %s', (phase, expected) => {
		expect(isLivePhase(phase)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// the countdown to the NEXT session (T13)
// ---------------------------------------------------------------------------

describe('nextWindowOpen — the next 15:00:00 IST opening', () => {
	// 2026-08-26 is the Wednesday the tables above use; guard the rest of the week.
	const THURSDAY = '2026-08-27';
	const FRIDAY = '2026-08-28';
	const MONDAY = '2026-08-31';
	expect(isWeekend(THURSDAY)).toBe(false);
	expect(isWeekend(FRIDAY)).toBe(false);
	expect(isWeekend(MONDAY)).toBe(false);
	expect(isWeekend('2026-08-30')).toBe(true);

	it('opens later on a trading day → today', () => {
		expect(nextWindowOpen(at(THURSDAY, 9, 0, 0))).toEqual({
			ms: at(THURSDAY, 15, 0, 0) - at(THURSDAY, 9, 0, 0),
			label: 'today'
		});
	});

	it('one second before the open → 1,000 ms, still today', () => {
		expect(nextWindowOpen(at(FRIDAY, 14, 59, 59))).toEqual({
			ms: 1_000,
			label: 'today'
		});
	});

	it('at 15:00:00.000 exactly the window is open, so the next one is tomorrow', () => {
		expect(nextWindowOpen(at(THURSDAY, 15, 0, 0)).label).toBe('tomorrow');
		expect(nextWindowOpen(at(THURSDAY, 15, 0, 0)).ms).toBe(86_400_000);
	});

	it('after the session on a weekday → the next day at 15:00', () => {
		expect(nextWindowOpen(at(THURSDAY, 16, 0, 0))).toEqual({
			ms: at(FRIDAY, 15, 0, 0) - at(THURSDAY, 16, 0, 0),
			label: 'tomorrow'
		});
		expect(nextWindowOpen(at(THURSDAY, 23, 59, 59)).label).toBe('tomorrow');
	});

	it('Friday evening → Monday, skipping the weekend', () => {
		expect(nextWindowOpen(at(FRIDAY, 16, 0, 0))).toEqual({
			ms: at(MONDAY, 15, 0, 0) - at(FRIDAY, 16, 0, 0),
			label: 'Monday'
		});
	});

	it('any instant of the weekend → Monday 15:00 IST', () => {
		for (const instant of [
			at(SATURDAY, 0, 0, 0),
			at(SATURDAY, 15, 0, 0),
			at(SATURDAY, 23, 59, 59)
		]) {
			const next = nextWindowOpen(instant);
			expect(next.label).toBe('Monday');
			expect(next.ms).toBe(at(MONDAY, 15, 0, 0) - instant);
		}
	});

	it('Sunday reads "tomorrow" — Monday really is the next day', () => {
		const sunday = at('2026-08-30', 12, 0, 0);
		expect(nextWindowOpen(sunday)).toEqual({
			ms: at(MONDAY, 15, 0, 0) - sunday,
			label: 'tomorrow'
		});
	});

	it('never returns a zero or negative gap', () => {
		for (let ms = 0; ms < 86_400_000; ms += 971_000) {
			expect(nextWindowOpen(at(MONDAY, 0, 0, 0) + ms).ms).toBeGreaterThan(0);
		}
	});
});

describe('formatDurationShort — a countdown read at a glance', () => {
	it.each([
		[0, '0s'],
		[-5, '0s'],
		[Number.NaN, '0s'],
		[999, '0s'],
		[1_000, '1s'],
		[59_000, '59s'],
		[60_000, '1m 00s'],
		[61_000, '1m 01s'],
		[3_599_000, '59m 59s'],
		[3_600_000, '1h 00m'],
		[8_040_000, '2h 14m'],
		[86_400_000, '1d 00h'],
		[3 * 86_400_000 + 2 * 3_600_000, '3d 02h']
	] as const)('%p ms → %s', (ms, expected) => {
		expect(formatDurationShort(ms)).toBe(expected);
	});
});
