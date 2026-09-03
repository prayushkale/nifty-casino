import { describe, expect, it } from 'vitest';
import {
	BSE_SENSEX_INDEX_NAME,
	bseNum,
	extractBseCasTick,
	extractBseLtp,
	extractLtpQuotes,
	extractNseCasTick,
	extractNseCasTicks,
	extractNseLtp,
	extractNseMarketStatusIndicative,
	extractNseMarketStatusNiftyTick,
	extractNseMarketStatusOk
} from './types';
import {
	BANKNIFTY_QUOTE,
	NIFTY_QUOTE,
	buildBseSensexRow,
	buildMarketStatusResponse,
	buildNseIndexDataResponse,
	buildNseIndexQuote
} from './test-fixtures';

const TS = 1_786_000_000_000; // fixed poll instant — extraction must not read the clock

describe('extractNseCasTick (E1 → normalized tick)', () => {
	it('fixture sanity: the default E1 payload carries both NSE indices', () => {
		expect(NIFTY_QUOTE.indexName).toBe('NIFTY 50');
		expect(buildNseIndexDataResponse().data.map((q) => q.indexName)).toEqual([
			NIFTY_QUOTE.indexName,
			BANKNIFTY_QUOTE.indexName
		]);
	});

	it('extracts indicativeClose/icChange/icPerChange for NIFTY 50', () => {
		const tick = extractNseCasTick(buildNseIndexDataResponse(), 'nifty', TS);
		expect(tick).toEqual({
			underlying: 'nifty',
			value: 24624.65,
			changePts: 38.5,
			changePct: 0.16,
			prevClose: 24586.15,
			ts: TS,
			source: 'nse'
		});
	});

	it('extracts NIFTY BANK from the same payload', () => {
		const tick = extractNseCasTick(buildNseIndexDataResponse(), 'banknifty', TS);
		expect(tick?.value).toBe(56240.3);
		expect(tick?.changePts).toBe(135.5);
		expect(tick?.underlying).toBe('banknifty');
	});

	it('returns null for sensex — a BSE index that never appears in the E1 feed', () => {
		expect(extractNseCasTick(buildNseIndexDataResponse(), 'sensex', TS)).toBeNull();
	});

	it('stamps every underlying with the same caller-supplied poll instant', () => {
		const ticks = extractNseCasTicks(buildNseIndexDataResponse(), TS);
		expect(ticks.map((t) => t.ts)).toEqual([TS, TS]);
		expect(ticks.map((t) => t.underlying)).toEqual(['nifty', 'banknifty']);
	});

	it('returns null while the indicative is still 0 (outside the CAS window)', () => {
		const raw = buildNseIndexDataResponse([
			buildNseIndexQuote({ indicativeClose: 0, icChange: 0, icPerChange: 0 })
		]);
		expect(extractNseCasTick(raw, 'nifty', TS)).toBeNull();
	});

	it('returns null when the indicatives are absent rather than zero', () => {
		const raw = {
			data: [
				{
					indexName: 'NIFTY 50',
					last: 24630.2,
					previousClose: 24586.15
				}
			]
		};
		expect(extractNseCasTick(raw, 'nifty', TS)).toBeNull();
	});

	it('never throws on a malformed envelope (schema drift degrades to no data)', () => {
		expect(extractNseCasTick(null, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick(undefined, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick({}, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick({ data: [] }, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick({ data: [{}] }, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick({ data: 'nope' }, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick('blocked', 'nifty', TS)).toBeNull();
	});

	it('returns null when only the matching row is missing', () => {
		const raw = buildNseIndexDataResponse([BANKNIFTY_QUOTE]);
		expect(extractNseCasTick(raw, 'nifty', TS)).toBeNull();
		expect(extractNseCasTick(raw, 'banknifty', TS)).not.toBeNull();
	});

	it('tolerates comma-formatted strings for the numeric fields', () => {
		const raw = {
			data: [
				{
					indexName: 'NIFTY 50',
					indicativeClose: '24,624.65',
					icChange: '+38.50',
					icPerChange: '0.16',
					previousClose: '24,586.15'
				}
			]
		};
		expect(extractNseCasTick(raw, 'nifty', TS)).toMatchObject({
			value: 24624.65,
			changePts: 38.5,
			changePct: 0.16,
			prevClose: 24586.15
		});
	});

	it('keeps the tick even when prevClose is missing (only that field goes null)', () => {
		const raw = buildNseIndexDataResponse([
			buildNseIndexQuote({ previousClose: undefined as unknown as number })
		]);
		const tick = extractNseCasTick(raw, 'nifty', TS);
		expect(tick?.prevClose).toBeNull();
		expect(tick?.value).toBe(24624.65);
	});
});

describe('extractNseMarketStatusIndicative (E3 cross-check)', () => {
	it('parses the indicativenifty50 block', () => {
		const ind = extractNseMarketStatusIndicative(buildMarketStatusResponse());
		expect(ind).toEqual({
			closingValue: 24624.65,
			change: 9.54,
			perChange: 0.04,
			status: 'CLOSE'
		});
	});

	it('null when the block or marketState is absent', () => {
		expect(extractNseMarketStatusIndicative(null)).toBeNull();
		expect(extractNseMarketStatusIndicative({})).toBeNull();
		expect(extractNseMarketStatusIndicative({ marketState: [] })).toBeNull();
		expect(extractNseMarketStatusIndicative({ marketState: 'x' })).toBeNull();
	});

	it('null when closingValue is 0/absent (schema drift tolerated)', () => {
		expect(
			extractNseMarketStatusIndicative({
				marketState: [{ indicativenifty50: { status: 'CLOSE' } }]
			})
		).toBeNull();
		expect(
			extractNseMarketStatusIndicative({
				marketState: [{ indicativenifty50: { closingValue: 0 } }]
			})
		).toBeNull();
	});

	it('extractMarketStatusOk reports whether the marketState array is usable', () => {
		expect(extractNseMarketStatusOk(buildMarketStatusResponse())).toBe(true);
		expect(extractNseMarketStatusOk({ marketState: [] })).toBe(false);
		expect(extractNseMarketStatusOk(null)).toBe(false);
	});

	it('builds a NIFTY tick from E3 alone (fallback while E1 is still 0)', () => {
		const tick = extractNseMarketStatusNiftyTick(buildMarketStatusResponse(), TS);
		expect(tick).toEqual({
			underlying: 'nifty',
			value: 24624.65,
			changePts: 9.54,
			changePct: 0.04,
			prevClose: null,
			ts: TS,
			source: 'nse'
		});
		expect(extractNseMarketStatusNiftyTick({ marketState: [] }, TS)).toBeNull();
	});
});

describe('bseNum (BSE numeric parsing)', () => {
	it('strips commas and keeps signs', () => {
		expect(bseNum('78,845.12')).toBe(78845.12);
		expect(bseNum('+264.12')).toBe(264.12);
		expect(bseNum('-3.5')).toBe(-3.5);
		expect(bseNum('0.34')).toBe(0.34);
		expect(bseNum(78845.12)).toBe(78845.12);
	});

	it('maps absent sentinels to 0', () => {
		expect(bseNum('-')).toBe(0);
		expect(bseNum('')).toBe(0);
		expect(bseNum('   ')).toBe(0);
		expect(bseNum('0')).toBe(0);
		expect(bseNum(undefined)).toBe(0);
		expect(bseNum(null)).toBe(0);
		expect(bseNum('not-a-number')).toBe(0);
	});
});

describe('extractBseCasTick (GetSensexDatanew → normalized tick)', () => {
	it('maps iclsprice/iclsChg/iclsPchg/Prev_Close onto the normalized payload', () => {
		const tick = extractBseCasTick([buildBseSensexRow()], TS);
		expect(tick).toEqual({
			underlying: 'sensex',
			value: 78845.12,
			changePts: 264.12,
			changePct: 0.34,
			prevClose: 78581,
			ts: TS,
			source: 'bse'
		});
	});

	it('null while the indicative close is "-" (outside the CAS window)', () => {
		expect(extractBseCasTick([buildBseSensexRow({ iclsprice: '-' })], TS)).toBeNull();
		expect(extractBseCasTick([buildBseSensexRow({ iclsprice: '0' })], TS)).toBeNull();
		expect(extractBseCasTick([buildBseSensexRow({ iclsprice: '' })], TS)).toBeNull();
	});

	it('null when the SENSEX row is missing or the envelope is not an array', () => {
		expect(extractBseCasTick([], TS)).toBeNull();
		expect(extractBseCasTick([{ indxnm: 'BSE 500' }], TS)).toBeNull();
		expect(extractBseCasTick({ indxnm: BSE_SENSEX_INDEX_NAME }, TS)).toBeNull();
		expect(extractBseCasTick(null, TS)).toBeNull();
	});

	it('does not throw on rows of the wrong shape', () => {
		expect(extractBseCasTick([null, 42, {}], TS)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// LTP extractors — the all-day last-traded-price fields
// ---------------------------------------------------------------------------

describe('extractNseLtp (E1 `last` → normalized LTP)', () => {
	it('extracts last/previousClose and derives the change', () => {
		const quote = extractNseLtp(buildNseIndexDataResponse(), 'nifty', TS);
		expect(quote).toEqual({
			underlying: 'nifty',
			value: 24630.2,
			changePts: 44.05, // 24630.2 − 24586.15
			changePct: 0.18,
			prevClose: 24586.15,
			ts: TS,
			source: 'nse'
		});
	});

	it('extracts BANKNIFTY by its index name', () => {
		expect(extractNseLtp(buildNseIndexDataResponse(), 'banknifty', TS)?.value).toBe(56210.4);
	});

	it('returns null for SENSEX (a BSE index — never in the E1 feed)', () => {
		expect(extractNseLtp(buildNseIndexDataResponse(), 'sensex', TS)).toBeNull();
	});

	it('returns null when the row is missing or `last` is absent/zero', () => {
		expect(extractNseLtp({ data: [] }, 'nifty', TS)).toBeNull();
		expect(
			extractNseLtp(buildNseIndexDataResponse([buildNseIndexQuote({ last: 0 })]), 'nifty', TS)
		).toBeNull();
	});
});

describe('extractBseLtp (BSE `ltp` → normalized SENSEX LTP)', () => {
	it('extracts ltp/chg/perchg with the carried change', () => {
		const quote = extractBseLtp([buildBseSensexRow()], TS);
		expect(quote).toEqual({
			underlying: 'sensex',
			value: 78831.32,
			changePts: 250.32,
			changePct: 0.32,
			prevClose: 78581.0,
			ts: TS,
			source: 'bse'
		});
	});

	it('falls back to arithmetic when BSE carries no change fields', () => {
		const row = buildBseSensexRow({ chg: '0', perchg: '0' });
		const quote = extractBseLtp([row], TS);
		expect(quote?.changePts).toBeCloseTo(78831.32 - 78581.0, 2);
	});

	it('returns null outside the day (ltp is "-") or when the row is missing', () => {
		expect(extractBseLtp([buildBseSensexRow({ ltp: '-' })], TS)).toBeNull();
		expect(extractBseLtp([], TS)).toBeNull();
	});
});

describe('extractLtpQuotes — both feeds, one instant', () => {
	it('fills every underlying and leaves failures as null', () => {
		const quotes = extractLtpQuotes(buildNseIndexDataResponse(), [buildBseSensexRow()], TS);
		expect(quotes.nifty?.value).toBe(24630.2);
		expect(quotes.banknifty?.value).toBe(56210.4);
		expect(quotes.sensex?.value).toBe(78831.32);
		expect(extractLtpQuotes(null, null, TS)).toEqual({
			nifty: null,
			banknifty: null,
			sensex: null
		});
	});
});
