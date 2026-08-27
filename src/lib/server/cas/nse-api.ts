/**
 * NSE public JSON API client — server-only, trimmed to what NiftyCasino needs:
 *
 *  E1  GET /api/NextApi/apiClient?functionName=getIndexData&&type=All
 *      index quotes incl. `indicativeClose`/`icChange`/`icPerChange` — THE chart feed.
 *  E3  GET /api/marketStatus
 *      market state + `indicativenifty50.closingValue` — the cheap cross-check /
 *      health probe (and a fallback for NIFTY when E1 has not started publishing).
 *
 * Ported from Market OI Analyzer. Dropped on purpose: E2 (per-scrip CAS IEPs),
 * E4 (constituent symbol lists + their 6h cache), the client bundle helper and
 * everything option-chain/Dhan related — none of it feeds this game.
 *
 * Raw upstream JSON is returned as `unknown`; only `../cas/types` extractors
 * know NSE field names, so nothing upstream-shaped can leak into a response.
 */
import { getNseSession, resetNseSession, NSE_BROWSER_UA } from './nse-session';
import { extractNseMarketStatusOk } from './types';

const NSE_API = 'https://www.nseindia.com';
const REQUEST_TIMEOUT_MS = 8000;

export type NseAPIErrorCode = 'AUTH' | 'BLOCKED' | 'TIMEOUT' | 'NETWORK' | 'PARSE';

export class NseAPIError extends Error {
	constructor(
		public code: NseAPIErrorCode,
		message: string,
		public status?: number
	) {
		super(message);
		this.name = 'NseAPIError';
	}
}

/**
 * Map a failed NSE response to its error, or null when it is a usable JSON 200.
 * Kept pure (and exported) so the Akamai classification is unit-testable.
 */
export function classifyNseFailure(
	status: number,
	contentType: string | null,
	body: string
): NseAPIError | null {
	if (status === 200 && contentType?.includes('application/json')) return null;
	if (status === 403 || /Access Denied/i.test(body)) {
		return new NseAPIError(
			'BLOCKED',
			'NSE blocked this request (Akamai). Refreshing the session and retrying may help.',
			status
		);
	}
	if (!contentType?.includes('application/json')) {
		return new NseAPIError(
			'AUTH',
			'NSE session expired — HTML challenge returned instead of JSON',
			status
		);
	}
	return new NseAPIError('AUTH', `NSE returned HTTP ${status}`, status);
}

// Akamai throttles parallel bursts, so serialize NSE calls: at most 2 in flight.
let nseInFlight = 0;
const nseWaiters: Array<() => void> = [];
const NSE_MAX_CONCURRENT = 2;

/** Test/observability hook: how many NSE calls are on the wire right now. */
export function nseInFlightCount(): number {
	return nseInFlight;
}

async function acquireNseSlot(): Promise<void> {
	if (nseInFlight < NSE_MAX_CONCURRENT) {
		nseInFlight++;
		return;
	}
	await new Promise<void>((resolve) => nseWaiters.push(resolve));
	nseInFlight++;
}
function releaseNseSlot(): void {
	nseInFlight--;
	const next = nseWaiters.shift();
	if (next) next();
}

async function nseFetchJson(path: string): Promise<unknown> {
	await acquireNseSlot();
	try {
		// Warm the Akamai session/IP reputation; cookies are deliberately NOT
		// forwarded on API calls (see the headers note below).
		await getNseSession();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(`${NSE_API}${path}`, {
				headers: {
					'User-Agent': NSE_BROWSER_UA,
					Accept: 'application/json, text/plain, */*',
					'Accept-Language': 'en-US,en;q=0.9',
					Referer: `${NSE_API}/`
					// NB: deliberately NO Cookie header. From a residential IP the APIs
					// answer without cookies; the handshake's ak_bmsc/bm_sv cookies are
					// JS-bound and CHALLENGE the API calls when forwarded (verified live
					// Aug 6 2026: cookie-less = 200 in ~0.15s, with cookies = timeouts).
				},
				signal: controller.signal
			});
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw new NseAPIError('TIMEOUT', `NSE did not respond within ${REQUEST_TIMEOUT_MS}ms`);
			}
			throw new NseAPIError(
				'NETWORK',
				err instanceof Error ? err.message : 'Network failure reaching NSE'
			);
		} finally {
			clearTimeout(timer);
		}

		const contentType = res.headers.get('content-type');
		if (contentType?.includes('application/json') && res.ok) return await res.json();
		const body = await res.text().catch(() => '');
		// classifyNseFailure only returns null for a usable JSON 200 — excluded above.
		throw (
			classifyNseFailure(res.status, contentType, body) ??
			new NseAPIError('PARSE', `NSE returned an unusable response (HTTP ${res.status})`, res.status)
		);
	} finally {
		releaseNseSlot();
	}
}

export type NseFetchResult<T> = { data: T; sessionReset: boolean };

/**
 * One automatic retry after refreshing the session on AUTH/BLOCKED failures.
 * Reports whether the retry (and therefore a session reset) was needed — the
 * debug route surfaces it as `session: 'ok' | 'reset'`.
 */
async function withSessionRetry<T>(fn: () => Promise<T>): Promise<NseFetchResult<T>> {
	try {
		return { data: await fn(), sessionReset: false };
	} catch (err) {
		if (err instanceof NseAPIError && (err.code === 'AUTH' || err.code === 'BLOCKED')) {
			resetNseSession();
			return { data: await fn(), sessionReset: true };
		}
		throw err;
	}
}

/**
 * E1 — index quotes incl. `indicativeClose` for NIFTY 50 + NIFTY BANK.
 * NB: the literal `&&` in the query string is required by NSE; never build
 * this URL with URLSearchParams (it would encode the ampersand).
 */
export async function fetchIndexData(): Promise<unknown> {
	return (await fetchIndexDataWithMeta()).data;
}

/** E1 plus whether the call survived only after a `resetNseSession()`. */
export async function fetchIndexDataWithMeta(): Promise<NseFetchResult<unknown>> {
	return withSessionRetry(() =>
		nseFetchJson('/api/NextApi/apiClient?functionName=getIndexData&&type=All')
	);
}

/** E3 — market status (`marketState[]` + `indicativenifty50`). */
export async function fetchMarketStatus(): Promise<unknown> {
	return (await withSessionRetry(() => nseFetchJson('/api/marketStatus'))).data;
}

export type NseHealthReport = {
	ok: boolean;
	/** Epoch ms of the probe — lets a watchdog chart freshness. */
	checkedAt: number;
	/** Human-readable one-liner; safe to log/alert on. Never raw upstream JSON. */
	detail: string;
};

/**
 * Lightweight liveness probe for a watchdog cron (Task 16): warms the Akamai
 * session then asks E3, which shares NSE's front door — a pass means the IP is
 * not blocked and the session handshake works, at a fraction of E1's cost.
 * `deep: true` additionally requires E1 to answer with usable index rows.
 * Never throws: every failure path resolves to `ok: false` + a detail string.
 */
export async function probeNseHealth(opts: { deep?: boolean } = {}): Promise<NseHealthReport> {
	const checkedAt = Date.now();
	try {
		await getNseSession();
		const marketStatus = await fetchMarketStatus();
		if (!extractNseMarketStatusOk(marketStatus)) {
			return { ok: false, checkedAt, detail: 'marketStatus returned no marketState array' };
		}
		if (opts.deep) {
			const indexData = await fetchIndexData();
			const rows = (indexData as { data?: unknown } | null)?.data;
			if (!Array.isArray(rows) || rows.length === 0) {
				return { ok: false, checkedAt, detail: 'E1 indexData had no rows' };
			}
			return { ok: true, checkedAt, detail: `marketStatus ok; E1 returned ${rows.length} rows` };
		}
		return { ok: true, checkedAt, detail: 'marketStatus ok' };
	} catch (err) {
		const code = err instanceof NseAPIError ? err.code : 'NETWORK';
		const message = err instanceof Error ? err.message : 'unknown NSE failure';
		return { ok: false, checkedAt, detail: `${code}: ${message}` };
	}
}
