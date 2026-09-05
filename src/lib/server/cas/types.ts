/**
 * Normalized CAS contract — the ONLY shape that ever leaves this module toward
 * the poller, the tick store, the SSE fan-out and the settlement engine.
 *
 * Deliberately dependency-free: no imports at all, so it is safe to share with
 * any layer (and trivially testable). It lives under $lib/server because every
 * consumer of it is server-side — browsers only ever see JSON derived from it.
 *
 * RAW upstream JSON never crosses this boundary. All upstream field-name
 * knowledge (`indicativeClose`/`icChange`/`icPerChange` for NSE,
 * `iclsprice`/`iclsChg`/`Prev_Close` for BSE, `indicativenifty50` for E3) is
 * locked inside the extractors below — an upstream schema change is a one-file
 * fix, never a leak into the rest of the app.
 */

/** The three tradable indices of the game. */
export type Underlying = 'nifty' | 'banknifty' | 'sensex';

/** Which exchange fed a tick. */
export type CasSource = 'nse' | 'bse';

/**
 * One normalized CAS observation.
 * `value` is the indicative close; `changePts`/`changePct` are measured against
 * the previous day's official close (matches NSE `icChange` semantics, which is
 * the game's anchor). `ts` is epoch ms — IST wall time is derived from it.
 *
 * `upstreamTs` is the exchange's OWN timestamp for the value (`timeVal` on NSE
 * E1 rows, `dttm` on BSE rows), when one is carried and parseable. It is the
 * freshness measurement for the whole feed: `ts - upstreamTs` = how old the
 * exchange says the number is when we received it — the number that separates
 * "our pipeline is slow" from "the exchange/CDN published it late". null when
 * the feed carried no parseable time (freshness is then unmeasurable).
 */
export type CasTickPayload = {
	underlying: Underlying;
	value: number;
	changePts: number;
	changePct: number;
	/** Previous day's official close, or null when the feed did not carry one. */
	prevClose: number | null;
	ts: number;
	/** Exchange-side timestamp of the value (epoch ms), or null when not carried. */
	upstreamTs: number | null;
	source: CasSource;
};

/** IST = UTC+5:30, no DST — inlined so this module stays dependency-free. */
const IST_OFFSET_MS = 330 * 60_000;

const MONTHS: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11
};

/**
 * Parse an IST wall-clock date-time into epoch ms, or null when unparseable.
 * `day`/`mon`/`year` may be zero-padded; the result is exact to the second.
 */
function istPartsToEpochMs(
	year: number,
	month: number,
	day: number,
	hh: number,
	mm: number,
	ss: number
): number | null {
	if (
		!Number.isFinite(year) ||
		!Number.isFinite(month) ||
		!Number.isFinite(day) ||
		!Number.isFinite(hh) ||
		!Number.isFinite(mm) ||
		!Number.isFinite(ss)
	) {
		return null;
	}
	// Build UTC ms for the IST wall clock, then subtract the IST offset.
	return Date.UTC(year, month, day, hh, mm, ss) - IST_OFFSET_MS;
}

/**
 * Parse NSE E1 `timeVal` — IST "dd-MMM-yyyy HH:mm:ss" (e.g. "06-Aug-2026 15:30:00")
 * — into epoch ms. Returns null for anything unexpected (never throws, never guesses).
 */
export function parseNseTimeVal(raw: unknown): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const month = MONTHS[m[2]];
	if (month === undefined) return null;
	return istPartsToEpochMs(+m[3], month, +m[1], +m[4], +m[5], +m[6]);
}

/**
 * Parse BSE `dttm` — IST "dd MMM yy | HH:mm" (e.g. "06 Aug 26 | 13:38") — into
 * epoch ms, seconds defaulted to 0 (BSE does not carry them). Returns null for
 * anything unexpected.
 */
export function parseBseDttm(raw: unknown): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{2}) \| (\d{2}):(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const month = MONTHS[m[2]];
	if (month === undefined) return null;
	// BSE uses a 2-digit year; NSE-style quotes are all 2000+ so this is exact.
	return istPartsToEpochMs(2000 + +m[3], month, +m[1], +m[4], +m[5], 0);
}

/** NSE index names feeding each underlying (SENSEX is BSE — never in this map). */
export const NSE_INDEX_NAME_BY_UNDERLYING: Partial<Record<Underlying, string>> = {
	nifty: 'NIFTY 50',
	banknifty: 'NIFTY BANK'
};

/** BSE index name feeding each underlying (only SENSEX is served by BSE). */
export const BSE_INDEX_NAME_BY_UNDERLYING: Partial<Record<Underlying, string>> = {
	sensex: 'BSE SENSEX'
};

/** Live row label used by BSE's GetSensexDatanew response for the SENSEX index. */
export const BSE_SENSEX_INDEX_NAME = 'BSE SENSEX';

// ---------------------------------------------------------------------------
// tolerant raw-JSON readers (all upstream values arrive as numbers OR strings)
// ---------------------------------------------------------------------------

function isRecord(raw: unknown): raw is Record<string, unknown> {
	return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function asRecord(raw: unknown): Record<string, unknown> | null {
	return isRecord(raw) ? raw : null;
}

/** The `data` array of NSE's E1 envelope, tolerating a missing/malformed one. */
function asRowArray(raw: unknown): Record<string, unknown>[] {
	const rows = asRecord(raw)?.data;
	return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

/**
 * Read a numeric field, tolerating comma-formatted strings ("78,845.12").
 * Returns null when absent/non-numeric — callers decide whether that is fatal.
 */
export function casNum(raw: unknown): number | null {
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw !== 'string') return null;
	const cleaned = raw.replace(/,/g, '').trim();
	if (!cleaned || cleaned === '-') return null;
	const n = Number(cleaned);
	return Number.isNaN(n) || !Number.isFinite(n) ? null : n;
}

/** A positive finite number, or null (0/-/blank mean "not published yet"). */
function positiveOrNull(raw: unknown): number | null {
	const n = casNum(raw);
	return n !== null && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// E1 — NSE index quotes (NIFTY 50, NIFTY BANK)
// ---------------------------------------------------------------------------

/**
 * Extract the normalized NIFTY/BANKNIFTY CAS tick from the RAW E1 response
 * (`GET /api/NextApi/apiClient?functionName=getIndexData&&type=All`).
 *
 * Returns null — never throws, never fabricates a zero — when the row is
 * missing or the indicatives are absent/zero, which is the state outside the
 * ~15:20–15:35 IST CAS window. `ts` is injectable so callers (and tests) stamp
 * every underlying of one poll with the same instant.
 */
export function extractNseCasTick(
	raw: unknown,
	underlying: Underlying,
	ts: number = Date.now()
): CasTickPayload | null {
	const indexName = NSE_INDEX_NAME_BY_UNDERLYING[underlying];
	if (!indexName) return null; // SENSEX is a BSE index — not in the E1 feed
	const row = asRowArray(raw).find((r) => r.indexName === indexName);
	if (!row) return null;
	const value = positiveOrNull(row.indicativeClose);
	if (value === null) return null;
	return {
		underlying,
		value,
		changePts: casNum(row.icChange) ?? 0,
		changePct: casNum(row.icPerChange) ?? 0,
		prevClose: positiveOrNull(row.previousClose),
		ts,
		upstreamTs: parseNseTimeVal(row.timeVal),
		source: 'nse'
	};
}

/** Both NSE underlyings at once, stamped with one poll instant. */
export function extractNseCasTicks(raw: unknown, ts: number = Date.now()): CasTickPayload[] {
	const out: CasTickPayload[] = [];
	for (const underlying of ['nifty', 'banknifty'] as const) {
		const tick = extractNseCasTick(raw, underlying, ts);
		if (tick) out.push(tick);
	}
	return out;
}

// ---------------------------------------------------------------------------
// E3 — /api/marketStatus cross-check (indicative NIFTY 50)
// ---------------------------------------------------------------------------

export type NseMarketStatusIndicative = {
	closingValue: number;
	change: number;
	perChange: number;
	status: string | null;
};

/**
 * Extract `indicativenifty50` from the RAW E3 market-status response. The block
 * carries the ticking indicative NIFTY level and can populate earlier than E1's
 * `indicativeClose` (which stays 0 until ~15:20), so it is both a cross-check
 * and a fallback. Returns null when absent — a schema change degrades to
 * "no data", never a crash.
 */
export function extractNseMarketStatusIndicative(raw: unknown): NseMarketStatusIndicative | null {
	const env = asRecord(raw);
	const marketState = env?.marketState;
	if (!Array.isArray(marketState)) return null;
	for (const entry of marketState) {
		const blk = asRecord(asRecord(entry)?.indicativenifty50);
		if (!blk) continue;
		const closingValue = positiveOrNull(blk.closingValue);
		if (closingValue === null) continue;
		return {
			closingValue,
			change: casNum(blk.change) ?? 0,
			perChange: casNum(blk.perChange) ?? 0,
			status: typeof blk.status === 'string' ? blk.status : null
		};
	}
	return null;
}

/** Whether the E3 probe saw a well-formed marketState array (watchdog signal). */
export function extractNseMarketStatusOk(raw: unknown): boolean {
	const marketState = asRecord(raw)?.marketState;
	return Array.isArray(marketState) && marketState.length > 0;
}

/**
 * Normalized NIFTY tick built from the E3 cross-check alone — used only when
 * E1's indicative has not started publishing yet. `prevClose` is unknown here
 * (E3 does not carry it), so it stays null.
 */
export function extractNseMarketStatusNiftyTick(
	raw: unknown,
	ts: number = Date.now()
): CasTickPayload | null {
	const ind = extractNseMarketStatusIndicative(raw);
	if (!ind) return null;
	return {
		underlying: 'nifty',
		value: ind.closingValue,
		changePts: ind.change,
		changePct: ind.perChange,
		prevClose: null,
		ts,
		// E3 carries no timestamp of its own — the E1 tick is the freshness source.
		upstreamTs: null,
		source: 'nse'
	};
}

// ---------------------------------------------------------------------------
// LTP — last traded price (the pre-auction display + the 15:15 betting anchor)
// ---------------------------------------------------------------------------

/**
 * One normalized LTP observation. Same display shape as `CasTickPayload` minus
 * the indicatives: `value` is the LAST TRADED price of the regular session (NSE
 * E1 `last`, BSE `ltp`), and `changePts`/`changePct` are measured against the
 * previous day's close. Unlike the CAS ticks, the LTP is available all day — it
 * is what a visitor sees on page load and the price the 15:15:01 anchor freezes.
 */
export type LtpQuote = {
	underlying: Underlying;
	value: number;
	changePts: number;
	changePct: number;
	/** Previous day's official close, or null when the feed did not carry one. */
	prevClose: number | null;
	ts: number;
	source: CasSource;
};

/** Change vs a positive prevClose, or zeros when no reference was carried. */
function changeAgainst(
	value: number,
	prevClose: number | null
): { changePts: number; changePct: number } {
	if (prevClose === null || !(prevClose > 0)) return { changePts: 0, changePct: 0 };
	const changePts = Math.round((value - prevClose) * 100) / 100;
	return { changePts, changePct: Math.round((changePts / prevClose) * 10_000) / 100 };
}

/**
 * Extract the normalized LTP for one NSE index from the RAW E1 response. The
 * `last` field publishes all day (unlike `indicativeClose`, which is 0 outside
 * the CAS window), so this works at any hour. Returns null when the row is
 * missing or `last` is absent/zero — never a fabricated price.
 */
export function extractNseLtp(
	raw: unknown,
	underlying: Underlying,
	ts: number = Date.now()
): LtpQuote | null {
	const indexName = NSE_INDEX_NAME_BY_UNDERLYING[underlying];
	if (!indexName) return null; // SENSEX is a BSE index — not in the E1 feed
	const row = asRowArray(raw).find((r) => r.indexName === indexName);
	if (!row) return null;
	const value = positiveOrNull(row.last);
	if (value === null) return null;
	const prevClose = positiveOrNull(row.previousClose);
	const change = changeAgainst(value, prevClose);
	return { underlying, value, ...change, prevClose, ts, source: 'nse' };
}

/**
 * Extract the normalized SENSEX LTP from the RAW BSE GetSensexDatanew response
 * (`ltp`, which — unlike `iclsprice` — carries a real price all day).
 */
export function extractBseLtp(raw: unknown, ts: number = Date.now()): LtpQuote | null {
	const rows = Array.isArray(raw) ? raw.filter(isRecord) : [];
	const row = rows.find((r) => r.indxnm === BSE_SENSEX_INDEX_NAME);
	if (!row) return null;
	const value = bseNum(row.ltp as string | number | null | undefined);
	if (!(value > 0)) return null;
	const prevClose = positiveOrNull(row.Prev_Close);
	// BSE carries its own signed point change (`chg`); fall back to arithmetic.
	const carried = bseNum(row.chg as string | number | null | undefined);
	const changePts = carried !== 0 ? carried : changeAgainst(value, prevClose).changePts;
	const changePct =
		bseNum(row.perchg as string | number | null | undefined) !== 0
			? bseNum(row.perchg as string | number | null | undefined)
			: changeAgainst(value, prevClose).changePct;
	return { underlying: 'sensex', value, changePts, changePct, prevClose, ts, source: 'bse' };
}

/** Both feeds at once, stamped with one instant. Either side may fail to null. */
export function extractLtpQuotes(
	nseRaw: unknown,
	bseRaw: unknown,
	ts: number = Date.now()
): {
	nifty: LtpQuote | null;
	banknifty: LtpQuote | null;
	sensex: LtpQuote | null;
} {
	return {
		nifty: extractNseLtp(nseRaw, 'nifty', ts),
		banknifty: extractNseLtp(nseRaw, 'banknifty', ts),
		sensex: extractBseLtp(bseRaw, ts)
	};
}

// ---------------------------------------------------------------------------
// GetSensexDatanew — BSE SENSEX
// ---------------------------------------------------------------------------

/**
 * Parse a numeric BSE field ("78,845.12") into a number; '-'/blank/'0'/null → 0.
 * BSE publishes "-" for every indicative field outside the CAS window.
 */
export function bseNum(raw: string | number | null | undefined): number {
	if (raw == null) return 0;
	const cleaned = String(raw).replace(/,/g, '').trim();
	if (!cleaned || cleaned === '-' || Number.isNaN(Number(cleaned))) return 0;
	return Number(cleaned);
}

/**
 * Extract the normalized SENSEX CAS tick from the RAW BSE GetSensexDatanew
 * response (an array of index rows). Returns null when the row is missing or
 * `iclsprice` is absent/'-'/0 (outside the CAS window).
 */
export function extractBseCasTick(raw: unknown, ts: number = Date.now()): CasTickPayload | null {
	const rows = Array.isArray(raw) ? raw.filter(isRecord) : [];
	const row = rows.find((r) => r.indxnm === BSE_SENSEX_INDEX_NAME);
	if (!row) return null;
	const value = bseNum(row.iclsprice as string | number | null | undefined);
	if (!(value > 0)) return null;
	return {
		underlying: 'sensex',
		value,
		changePts: bseNum(row.iclsChg as string | number | null | undefined),
		changePct: bseNum(row.iclsPchg as string | number | null | undefined),
		prevClose: positiveOrNull(row.Prev_Close),
		ts,
		upstreamTs: parseBseDttm(row.dttm as string | undefined),
		source: 'bse'
	};
}
