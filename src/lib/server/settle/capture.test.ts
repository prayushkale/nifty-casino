/**
 * Official-close capture (PLAN §5 T9).
 *
 * The upstream fetchers are injected fakes carrying RAW NSE/BSE shapes (the same
 * fixtures the T3 extractor tests use), so these tests prove the two things the
 * whole settlement depends on: an official close is only ever written when the
 * exchange actually published one, and a close we already have is never revised
 * by a retry. No network, no timers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildBseSensexRow,
	buildMarketStatusResponse,
	buildNseIndexDataResponse,
	buildNseIndexQuote
} from '$lib/server/cas/test-fixtures';
import { istAt } from '$lib/server/cas/test-clock';
import { MemoryStore, type GameStore } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import {
	captureIsComplete,
	captureOfficialCloses,
	marketCloseMsFor,
	type OfficialCloseFetchers
} from './capture';

/** A Thursday; 15:30:00 IST is the market close — the earliest settle instant. */
const THURSDAY = '2026-08-27';
const IN_WINDOW = new Date(istAt(THURSDAY, 15, 43, 0));
const BEFORE_CLOSE = new Date(istAt(THURSDAY, 15, 29, 59, 999));
const AT_CLOSE = new Date(istAt(THURSDAY, 15, 30, 0));

let store: GameStore;
let nseE1: ReturnType<typeof vi.fn>;
let nseE3: ReturnType<typeof vi.fn>;
let bse: ReturnType<typeof vi.fn>;

/** Injectable fetchers with every call recorded. */
function theFetchers(): OfficialCloseFetchers {
	return { fetchNseIndexData: nseE1, fetchNseMarketStatus: nseE3, fetchBseSensexRows: bse };
}

/** Both NSE indices publishing, the shape E1 gives ~15:30 IST. */
const fullE1 = (): unknown =>
	buildNseIndexDataResponse([
		buildNseIndexQuote({ indexName: 'NIFTY 50', indicativeClose: 25_050.5 }),
		buildNseIndexQuote({ indexName: 'NIFTY BANK', indicativeClose: 56_010.25 })
	]);

beforeEach(() => {
	store = new MemoryStore();
	nseE1 = vi.fn(async () => fullE1());
	nseE3 = vi.fn(async () => buildMarketStatusResponse());
	bse = vi.fn(async () => [buildBseSensexRow()]);
});

const closesFor = async (): Promise<Partial<Record<Underlying, number>>> => {
	const rows = await store.closes.getIndexCloses(THURSDAY);
	return Object.fromEntries(rows.map((row) => [row.underlying, row.close]));
};

describe('the market-close guard', () => {
	it('refuses to fetch or write before 15:30:00 IST', async () => {
		const report = await captureOfficialCloses(store, BEFORE_CLOSE, theFetchers());

		expect(report.attempted).toBe(false);
		expect(report.reason).toBe('BEFORE_AUCTION_END');
		expect(nseE1).not.toHaveBeenCalled();
		expect(bse).not.toHaveBeenCalled();
		expect(await store.closes.getIndexCloses(THURSDAY)).toHaveLength(0);
	});

	it('starts exactly at the market close', async () => {
		const report = await captureOfficialCloses(store, AT_CLOSE, theFetchers());
		expect(report.attempted).toBe(true);
		expect(report.reason).toBeUndefined();
	});

	it('derives the deadline from the trade date, not the wall clock', () => {
		expect(marketCloseMsFor(THURSDAY)).toBe(istAt(THURSDAY, 15, 30, 0));
		expect(marketCloseMsFor('2026-09-01')).toBe(istAt('2026-09-01', 15, 30, 0));
	});
});

describe('a good capture', () => {
	it('lands all three indices as official and reports complete', async () => {
		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.attempted).toBe(true);
		expect(report.written).toEqual(['nifty', 'banknifty', 'sensex']);
		expect(report.missing).toEqual([]);
		expect(captureIsComplete(report)).toBe(true);
		expect(report.origins).toEqual({ nifty: 'nse-e1', banknifty: 'nse-e1', sensex: 'bse' });

		const closes = await store.closes.getIndexCloses(THURSDAY);
		expect(closes).toHaveLength(3);
		expect(closes).toEqual(
			expect.arrayContaining([
				{ tradeDate: THURSDAY, underlying: 'nifty', close: 25_050.5, source: 'official' },
				{ tradeDate: THURSDAY, underlying: 'banknifty', close: 56_010.25, source: 'official' },
				{ tradeDate: THURSDAY, underlying: 'sensex', close: 78_845.12, source: 'official' }
			])
		);
	});

	it('stamps the IST trade date of `now`, not of the test run', async () => {
		const friday = new Date(istAt('2026-08-28', 15, 45, 0));
		const report = await captureOfficialCloses(store, friday, theFetchers());
		expect(report.tradeDate).toBe('2026-08-28');
		expect(await store.closes.getIndexCloses('2026-08-28')).toHaveLength(3);
		expect(await store.closes.getIndexCloses(THURSDAY)).toHaveLength(0);
	});
});

describe('a feed that is not ready yet', () => {
	it('falls back to the frozen closing LTP when the indicatives are zeroed out', async () => {
		// The literal upstream shape minutes after the CAS window: every indicative
		// absent, but the last-traded price frozen at the 15:30 close.
		nseE1.mockResolvedValue(
			buildNseIndexDataResponse([
				buildNseIndexQuote({ indexName: 'NIFTY 50', indicativeClose: 0 }),
				buildNseIndexQuote({ indexName: 'NIFTY BANK', indicativeClose: 0, last: 56_210.4 })
			])
		);
		nseE3.mockResolvedValue(buildMarketStatusResponse({ marketState: [] }));
		bse.mockResolvedValue([buildBseSensexRow({ iclsprice: '-' })]);

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.attempted).toBe(true);
		expect(report.written).toEqual(['nifty', 'banknifty', 'sensex']);
		expect(report.missing).toEqual([]);
		expect(captureIsComplete(report)).toBe(true);
		expect(report.origins).toEqual({
			nifty: 'nse-e1-ltp',
			banknifty: 'nse-e1-ltp',
			sensex: 'bse-ltp'
		});
		await expect(closesFor()).resolves.toMatchObject({
			nifty: 24_630.2,
			banknifty: 56_210.4,
			sensex: 78_831.32
		});
	});

	it('prefers a published indicative over the LTP fallback', async () => {
		bse.mockResolvedValue([buildBseSensexRow({ iclsprice: '-' })]);

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.origins).toEqual({ nifty: 'nse-e1', banknifty: 'nse-e1', sensex: 'bse-ltp' });
		await expect(closesFor()).resolves.toMatchObject({ nifty: 25_050.5, sensex: 78_831.32 });
	});

	it('writes nothing when the exchanges answer with no rows at all', async () => {
		nseE1.mockResolvedValue({ data: [] });
		nseE3.mockResolvedValue({ marketState: [] });
		bse.mockResolvedValue([]);

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());
		expect(report.written).toEqual([]);
		expect(await store.closes.getIndexCloses(THURSDAY)).toHaveLength(0);
	});

	it('captures the indices that did publish and retries the rest', async () => {
		bse.mockResolvedValue([]); // SENSEX not published yet

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.written).toEqual(['nifty', 'banknifty']);
		expect(report.missing).toEqual(['sensex']);
		expect(captureIsComplete(report)).toBe(false);
		const closes = await closesFor();
		expect(closes.nifty).toBe(25_050.5);
		expect(closes.sensex).toBeUndefined();
	});

	it('records an upstream failure as a retry, never a throw', async () => {
		nseE1.mockRejectedValue(new Error('NSE blocked (Akamai)'));

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.errors).toEqual(['nse-e1: NSE blocked (Akamai)']);
		// NIFTY survives on the E3 fallback; BANKNIFTY has no second source.
		expect(report.missing).toEqual(['banknifty']);
		expect(report.origins.nifty).toBe('nse-e3');
		// BSE still landed.
		expect(report.captured).toEqual(['nifty', 'sensex']);
		await expect(closesFor()).resolves.toMatchObject({ nifty: 24_624.65, sensex: 78_845.12 });
	});

	it('does not fall back to E3 for BANKNIFTY, which E3 does not carry — but the LTP does', async () => {
		nseE1.mockResolvedValue(
			buildNseIndexDataResponse([
				buildNseIndexQuote({ indexName: 'NIFTY 50', indicativeClose: 25_050.5 }),
				buildNseIndexQuote({ indexName: 'NIFTY BANK', indicativeClose: 0, last: 56_210.4 })
			])
		);

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());
		expect(report.origins.nifty).toBe('nse-e1');
		expect(report.origins.banknifty).toBe('nse-e1-ltp');
		await expect(closesFor()).resolves.toMatchObject({ banknifty: 56_210.4 });
	});
});

describe('the E3 cross-check', () => {
	it('falls back to E3 when E1 has not started publishing NIFTY', async () => {
		nseE1.mockResolvedValue(
			buildNseIndexDataResponse([
				buildNseIndexQuote({ indexName: 'NIFTY 50', indicativeClose: 0 }),
				buildNseIndexQuote({ indexName: 'NIFTY BANK', indicativeClose: 56_010.25 })
			])
		);

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.origins.nifty).toBe('nse-e3');
		expect(report.captured).toContain('nifty');
		expect(await closesFor()).toMatchObject({ nifty: 24_624.65 });
	});

	it('keeps E1 and says so when the two sources disagree', async () => {
		// E3 publishes 25,100 while E1 says 25,050: drift far outside a rounding error.
		nseE3.mockResolvedValue({
			marketState: [
				{
					market: 'Capital Market',
					marketStatus: 'Close',
					indicativenifty50: { closingValue: 25_100, change: 50, perChange: 0.2 }
				}
			]
		});

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0]).toContain('cross-check drift');
		expect(await closesFor()).toMatchObject({ nifty: 25_050.5 });
	});

	it('stays quiet when the two sources agree', async () => {
		nseE3.mockResolvedValue({
			marketState: [{ market: 'Capital Market', indicativenifty50: { closingValue: 25_050.5 } }]
		});
		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());
		expect(report.warnings).toEqual([]);
	});
});

describe('the official close replaces the live anchor, once', () => {
	it("overwrites the poller's live_approx previous-day anchor", async () => {
		await store.closes.upsertIndexCloseIfAbsent({
			tradeDate: THURSDAY,
			underlying: 'nifty',
			close: 24_586.15,
			source: 'live_approx'
		});

		await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		const rows = await store.closes.getIndexCloses(THURSDAY);
		expect(rows.find((row) => row.underlying === 'nifty')).toEqual({
			tradeDate: THURSDAY,
			underlying: 'nifty',
			close: 25_050.5,
			source: 'official'
		});
	});

	it('never revises a close that is already official', async () => {
		await store.closes.upsertIndexClose({
			tradeDate: THURSDAY,
			underlying: 'nifty',
			close: 25_000,
			source: 'official'
		});

		const report = await captureOfficialCloses(store, IN_WINDOW, theFetchers());

		// Still counted as captured — the day IS settleable — but not rewritten.
		expect(report.captured).toContain('nifty');
		expect(report.written).toEqual(['banknifty', 'sensex']);
		expect(await closesFor()).toMatchObject({ nifty: 25_000 });
	});
});

describe('the real fetchers are wired', () => {
	it('exposes the three T3 clients as defaults', async () => {
		const { realOfficialCloseFetchers } = await import('./capture');
		expect(typeof realOfficialCloseFetchers.fetchNseIndexData).toBe('function');
		expect(typeof realOfficialCloseFetchers.fetchNseMarketStatus).toBe('function');
		expect(typeof realOfficialCloseFetchers.fetchBseSensexRows).toBe('function');
	});
});
