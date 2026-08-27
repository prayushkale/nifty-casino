/**
 * BSE public API client — server-only. Ported from Market OI Analyzer unchanged
 * (same headers, same timeout, same error classification).
 *
 * Endpoint (verified Aug 6 2026 from a residential IP — requires Origin +
 * Referer, NO cookies):
 *   GET https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexDatanew/w
 *
 * Returns an array of index rows; each carries `iclsprice` (indicative close,
 * "-" outside the CAS window) + `iclsChg`/`iclsPchg`/`IndicativeNm`.
 *
 * Field names are read ONLY by `extractBseCasTick` in ./types — this module
 * hands back the raw rows as `unknown` so nothing upstream-shaped escapes.
 */
import { NseAPIError, type NseAPIErrorCode } from './nse-api';

// `bseNum` is the pure BSE number parser; it lives with the other extractors so
// ./types stays dependency-free. Re-exported here for API-layer ergonomics.
export { bseNum } from './types';

const BSE_API = 'https://api.bseindia.com/RealTimeBseIndiaAPI/api';
const BSE_REFERER = 'https://www.bseindia.com/markets/equity/closing_auction_session';
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 10000;

/** Map a failed BSE response to its error, or null for a usable JSON 200. */
export function classifyBseFailure(
	status: number,
	contentType: string | null,
	body: string
): NseAPIError | null {
	if (status === 200 && contentType?.includes('application/json')) return null;
	if (status === 403 || /Access Denied|error_Bse/i.test(body)) {
		return new NseAPIError('BLOCKED', 'BSE blocked this request. Retry may help.', status);
	}
	return new NseAPIError('AUTH', `BSE returned HTTP ${status}`, status);
}

/** Raw rows of `GetSensexDatanew` — feed these to `extractBseCasTick`. */
export async function fetchBseSensexRows(): Promise<unknown[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(`${BSE_API}/GetSensexDatanew/w`, {
			headers: {
				'User-Agent': BROWSER_UA,
				Accept: 'application/json, text/plain, */*',
				'Accept-Language': 'en-US,en;q=0.9',
				Origin: 'https://www.bseindia.com',
				Referer: BSE_REFERER
			},
			signal: controller.signal
		});
	} catch (err: unknown) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new NseAPIError('TIMEOUT', `BSE did not respond within ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw new NseAPIError(
			'NETWORK',
			err instanceof Error ? err.message : 'Network failure reaching BSE'
		);
	} finally {
		clearTimeout(timer);
	}

	const contentType = res.headers.get('content-type');
	if (!res.ok || !contentType?.includes('application/json')) {
		const body = await res.text().catch(() => '');
		// classifyBseFailure only returns null for a usable JSON 200 — excluded above.
		throw (
			classifyBseFailure(res.status, contentType, body) ??
			new NseAPIError('PARSE', `BSE returned an unusable response (HTTP ${res.status})`, res.status)
		);
	}

	const data: unknown = await res.json();
	if (!Array.isArray(data)) {
		throw new NseAPIError('PARSE', 'BSE returned a non-array response');
	}
	return data;
}

/** Error codes this BSE client can raise (subset of the NSE ones). */
export type BseAPIErrorCode = NseAPIErrorCode;
