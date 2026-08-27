/**
 * NSE cookie-session manager (server-only).
 *
 * NSE's public JSON APIs are Akamai-protected: they expect a browser-like
 * User-Agent and usually cookies from a prior visit to https://www.nseindia.com/
 * (notably the `nseappid` / `AKA_A2` anti-bot cookies). Cookies are short-lived,
 * so we cache them with a TTL and refresh on demand (the API layer resets the
 * session and retries once on an AUTH/BLOCKED failure).
 *
 * IMPORTANT: lives under $lib/server so it can never leak into client bundles.
 * In NiftyCasino the server is the ONLY scraper — browsers never reach NSE.
 * Never log cookie contents.
 */

const NSE_HOME = 'https://www.nseindia.com';

export const NSE_BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** NSE cookies are short-lived; re-handshake after this TTL. */
const SESSION_TTL_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 15000;

let cachedCookies = '';
let cachedAt = 0;

/** Drop the cached session so the next API call re-handshakes. */
export function resetNseSession(): void {
	cachedCookies = '';
	cachedAt = 0;
}

function extractCookies(res: Response): string {
	try {
		// getSetCookie() exists on undici/Node >= 19.7 (this app runs Node 22+).
		const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0]);
		return pairs.filter(Boolean).join('; ');
	} catch {
		return '';
	}
}

/**
 * Fetch the NSE homepage to obtain/refresh the session cookie jar.
 * A 403 on the handshake itself is common (Akamai challenge) but still sets
 * anti-bot cookies, so we keep whatever set-cookie arrived.
 */
export async function getNseSession(): Promise<string> {
	if (cachedCookies && Date.now() - cachedAt < SESSION_TTL_MS) return cachedCookies;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
	try {
		const res = await fetch(`${NSE_HOME}/`, {
			headers: {
				'User-Agent': NSE_BROWSER_UA,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
				'Cache-Control': 'no-cache'
			},
			redirect: 'follow',
			signal: controller.signal
		});
		cachedCookies = extractCookies(res);
	} catch {
		// A failed handshake still leaves whatever cookies we have; the API
		// calls themselves decide AUTH/BLOCKED and trigger a retry.
	} finally {
		clearTimeout(timer);
	}
	cachedAt = Date.now();
	return cachedCookies;
}
