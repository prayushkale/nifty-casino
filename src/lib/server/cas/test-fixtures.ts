/**
 * Raw-upstream fixtures for the CAS fetch layer tests.
 *
 * These are RAW upstream shapes on purpose: they mirror what NSE/BSE actually
 * returns (field names locked from live in-window captures in Market OI
 * Analyzer) so the extractors are exercised against the real schema, not a
 * hand-wavy one. Nothing here is ever served to a client.
 */

/** NSE E1 index row — field names locked from the live getIndexData payload. */
export type NseIndexQuoteFixture = {
	indexName: string;
	open: number;
	high: number;
	low: number;
	last: number;
	previousClose: number;
	percChange: number;
	yearHigh: number;
	yearLow: number;
	timeVal: string;
	constituents: unknown[];
	/** 0 outside the CAS window. */
	indicativeClose: number;
	icChange: number;
	icPerChange: number;
	isConstituents: string;
};

export function buildNseIndexQuote(
	overrides: Partial<NseIndexQuoteFixture> = {}
): NseIndexQuoteFixture {
	return {
		indexName: 'NIFTY 50',
		open: 24598.1,
		high: 24655.4,
		low: 24561.75,
		last: 24630.2,
		previousClose: 24586.15,
		percChange: 0.18,
		yearHigh: 26277.35,
		yearLow: 21743.3,
		timeVal: '06-Aug-2026 15:30:00',
		constituents: [],
		indicativeClose: 24624.65,
		icChange: 38.5,
		icPerChange: 0.16,
		isConstituents: 'true',
		...overrides
	};
}

export const NIFTY_QUOTE = buildNseIndexQuote();

export const BANKNIFTY_QUOTE = buildNseIndexQuote({
	indexName: 'NIFTY BANK',
	open: 55980.5,
	high: 56310.9,
	low: 55902.15,
	last: 56210.4,
	previousClose: 56104.8,
	percChange: 0.19,
	indicativeClose: 56240.3,
	icChange: 135.5,
	icPerChange: 0.24
});

/** E1 envelope: `{ data: NseIndexQuote[] }`. */
export function buildNseIndexDataResponse(
	quotes: NseIndexQuoteFixture[] = [NIFTY_QUOTE, BANKNIFTY_QUOTE]
): { data: NseIndexQuoteFixture[] } {
	return { data: quotes };
}

/** BSE `GetSensexDatanew` row — field names locked from the live payload. */
export type BseIndexQuoteFixture = {
	indxnm: string;
	ltp: string;
	chg: string;
	perchg: string;
	F: string;
	dttm: string;
	istream: string;
	msg: string;
	Prev_Close: string;
	I_open: string;
	High: string;
	Low: string;
	source: string;
	iclsprice: string;
	iclsflag: string;
	iclsChg: string;
	iclsPchg: string;
	IndicativeNm: string;
	indxcode: string;
};

export function buildBseSensexRow(
	overrides: Partial<BseIndexQuoteFixture> = {}
): BseIndexQuoteFixture {
	return {
		indxnm: 'BSE SENSEX',
		ltp: '78,831.32',
		chg: '+250.32',
		perchg: '+0.32',
		F: '0',
		dttm: '06 Aug 26 | 13:38',
		istream: '1',
		msg: '',
		Prev_Close: '78,581.00',
		I_open: '78,782.43',
		High: '78,904.37',
		Low: '78,633.73',
		source: 'DB',
		// "-" outside the CAS window; numeric strings with commas in-window.
		iclsprice: '78,845.12',
		iclsflag: '1',
		iclsChg: '+264.12',
		iclsPchg: '+0.34',
		IndicativeNm: 'BSE SENSEX (Indicative Close)',
		indxcode: '16',
		...overrides
	};
}

/** E3 market-status envelope — `marketState[0]` is Capital Market. */
export function buildMarketStatusResponse(
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		marketState: [
			{
				market: 'Capital Market',
				marketStatus: 'Open',
				tradeDate: '06-Aug-2026',
				indicativenifty50: {
					change: 9.54,
					closingValue: 24624.65,
					dateTime: '06-Aug-2026 15:30',
					finalClosingValue: 24624.65,
					perChange: 0.04,
					status: 'CLOSE'
				}
			},
			{ market: 'Currency', marketStatus: 'Open', tradeDate: '06-Aug-2026' },
			{ market: 'Derivative Market', marketStatus: 'Open', tradeDate: '06-Aug-2026' },
			{ market: 'Debt Market', marketStatus: 'Close', tradeDate: '06-Aug-2026' },
			{ market: 'SLB Market', marketStatus: 'Open', tradeDate: '06-Aug-2026' }
		],
		marketcap: { label: 'Market Capitalization', value: '4,59,00,000' },
		...overrides
	};
}
