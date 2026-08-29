import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
	NseAPIError,
	classifyNseFailure,
	fetchIndexData,
	fetchIndexDataWithMeta,
	fetchMarketStatus,
	nseInFlightCount,
	probeNseHealth
} from './nse-api';
import { FeedBaseUrlError } from './feed-base-url';
import { resetNseSession } from './nse-session';
import {
	buildMarketStatusResponse,
	buildNseIndexDataResponse,
	buildNseIndexQuote
} from './test-fixtures';

const NSE_HOME = 'https://www.nseindia.com/';
const E1_URL = 'https://www.nseindia.com/api/NextApi/apiClient?functionName=getIndexData&&type=All';
const E3_URL = 'https://www.nseindia.com/api/marketStatus';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function stubFetch(impl: (url: string, init: RequestInit | undefined) => Promise<Response>): Mock {
	const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, init });
		return impl(url, init);
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

/** Only the API calls — the homepage warm-ups are filtered out. */
const apiCalls = (needle: string) => calls.filter((c) => c.url.includes(needle));

beforeEach(() => {
	calls = [];
	resetNseSession();
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('classifyNseFailure (Akamai/HTML classification)', () => {
	it('accepts a JSON 200', () => {
		expect(classifyNseFailure(200, 'application/json; charset=utf-8', '{"data":[]}')).toBeNull();
	});

	it('BLOCKED on HTTP 403 even without a readable body', () => {
		const err = classifyNseFailure(403, 'text/html', '');
		expect(err?.code).toBe('BLOCKED');
		expect(err?.status).toBe(403);
	});

	it('BLOCKED when the body is an Akamai Access Denied page', () => {
		expect(classifyNseFailure(200, 'text/html', '<h1>Access Denied</h1>')?.code).toBe('BLOCKED');
	});

	it('AUTH when an HTML challenge comes back instead of JSON', () => {
		const err = classifyNseFailure(200, 'text/html', '<html>please enable js</html>');
		expect(err?.code).toBe('AUTH');
		expect(err?.message).toContain('session expired');
	});

	it('AUTH on any other non-OK status with a JSON content type', () => {
		const err = classifyNseFailure(502, 'application/json', '{}');
		expect(err?.code).toBe('AUTH');
		expect(err?.message).toBe('NSE returned HTTP 502');
	});

	it('treats a missing content type as non-JSON (AUTH)', () => {
		expect(classifyNseFailure(200, null, '')?.code).toBe('AUTH');
	});
});

describe('fetchIndexData (E1)', () => {
	it('uses the exact upstream E1 URL, including the literal &&', async () => {
		const mock = stubFetch(async () => json(buildNseIndexDataResponse()));
		await fetchIndexData();
		expect(apiCalls('apiClient').map((c) => c.url)).toEqual([E1_URL]);
		// the Akamai warm-up precedes the API call
		expect(calls[0].url).toBe(NSE_HOME);
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it('returns the parsed JSON envelope untouched (no field knowledge here)', async () => {
		const envelope = buildNseIndexDataResponse();
		stubFetch(async () => json(envelope));
		await expect(fetchIndexData()).resolves.toEqual(envelope);
	});

	it('sends a browser UA + Referer and deliberately NO Cookie header', async () => {
		stubFetch(async () => json(buildNseIndexDataResponse()));
		await fetchIndexData();
		const headers = new Headers(apiCalls('apiClient')[0].init?.headers);
		expect(headers.get('user-agent')).toContain('Mozilla/5.0');
		expect(headers.get('referer')).toBe('https://www.nseindia.com/');
		expect(headers.get('accept')).toContain('application/json');
		expect(headers.has('cookie')).toBe(false);
	});

	it('retries exactly once after resetNseSession when the session is stale', async () => {
		stubFetch(async (url) =>
			url.includes('apiClient') && apiCalls('apiClient').length === 1
				? html('<html>challenge</html>')
				: json(buildNseIndexDataResponse())
		);
		const res = await fetchIndexDataWithMeta();
		expect(res.sessionReset).toBe(true);
		expect(res.data).toEqual(buildNseIndexDataResponse());
		expect(apiCalls('apiClient')).toHaveLength(2);
		// a reset drops the cached jar, so the homepage is re-warmed before attempt #2
		expect(calls.filter((c) => c.url === NSE_HOME)).toHaveLength(2);
	});

	it('retries once on an Akamai block (403) too', async () => {
		stubFetch(async (url) =>
			url.includes('apiClient') && apiCalls('apiClient').length === 1
				? html('Access Denied', 403)
				: json(buildNseIndexDataResponse())
		);
		const res = await fetchIndexDataWithMeta();
		expect(res.sessionReset).toBe(true);
		expect(apiCalls('apiClient')).toHaveLength(2);
	});

	it('does NOT retry when the second attempt fails as well (error propagates)', async () => {
		stubFetch(async (url) => (url.includes('apiClient') ? html('Access Denied', 403) : html('')));
		await expect(fetchIndexData()).rejects.toBeInstanceOf(NseAPIError);
		expect(apiCalls('apiClient')).toHaveLength(2);
	});

	it('does NOT retry on a plain network failure (only AUTH/BLOCKED)', async () => {
		stubFetch(async () => {
			throw new Error('ECONNRESET');
		});
		await expect(fetchIndexData()).rejects.toMatchObject({ code: 'NETWORK' });
		expect(apiCalls('apiClient')).toHaveLength(1);
	});

	it('maps an aborted request to TIMEOUT', async () => {
		stubFetch(async (url) => {
			if (!url.includes('apiClient')) return html('');
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		});
		await expect(fetchIndexData()).rejects.toMatchObject({ code: 'TIMEOUT' });
	});
});

describe('fetchMarketStatus (E3)', () => {
	it('calls /api/marketStatus and returns the raw envelope', async () => {
		const envelope = buildMarketStatusResponse();
		stubFetch(async (url) => (url.includes('marketStatus') ? json(envelope) : html('')));
		await expect(fetchMarketStatus()).resolves.toEqual(envelope);
		expect(apiCalls('marketStatus').map((c) => c.url)).toEqual([E3_URL]);
	});
});

describe('NSE concurrency limiter', () => {
	it('keeps at most 2 NSE calls on the wire and drains to 0', async () => {
		let inFlight = 0;
		let peak = 0;
		stubFetch(async (url) => {
			if (!url.includes('apiClient')) return html('');
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 15));
			inFlight--;
			return json(buildNseIndexDataResponse());
		});
		await Promise.all(Array.from({ length: 6 }, () => fetchIndexData()));
		expect(peak).toBe(2);
		expect(nseInFlightCount()).toBe(0);
	});
});

describe('probeNseHealth (watchdog probe)', () => {
	it('ok when E3 answers with a marketState array', async () => {
		stubFetch(async (url) =>
			url.includes('marketStatus') ? json(buildMarketStatusResponse()) : html('')
		);
		const report = await probeNseHealth();
		expect(report.ok).toBe(true);
		expect(typeof report.checkedAt).toBe('number');
		expect(report.detail).toContain('marketStatus');
	});

	it('ok:false with a readable detail when NSE blocks the probe — never throws', async () => {
		stubFetch(async (url) =>
			url.includes('marketStatus') ? html('Access Denied', 403) : html('')
		);
		const report = await probeNseHealth();
		expect(report.ok).toBe(false);
		expect(report.detail).toContain('BLOCKED');
	});

	it('ok:false on schema drift (no marketState array)', async () => {
		stubFetch(async (url) =>
			url.includes('marketStatus') ? json({ unexpected: true }) : html('')
		);
		const report = await probeNseHealth();
		expect(report.ok).toBe(false);
		expect(report.detail).toContain('marketState');
	});

	it('deep mode additionally requires E1 to answer with rows', async () => {
		stubFetch(async (url) => {
			if (url.includes('marketStatus')) return json(buildMarketStatusResponse());
			if (url.includes('apiClient')) return json(buildNseIndexDataResponse([buildNseIndexQuote()]));
			return html('');
		});
		const ok = await probeNseHealth({ deep: true });
		expect(ok.ok).toBe(true);
		expect(ok.detail).toContain('E1');

		resetNseSession();
		stubFetch(async (url) =>
			url.includes('marketStatus') ? json(buildMarketStatusResponse()) : json({ data: [] })
		);
		const degraded = await probeNseHealth({ deep: true });
		expect(degraded.ok).toBe(false);
		expect(degraded.detail).toContain('E1');
	});
});

describe('NSE_BASE_URL override (the residential-relay path)', () => {
	const RELAY = 'http://mac.tail1234.ts.net:8081';

	it('routes E1 through the override, keeping the path and the literal && intact', async () => {
		vi.stubEnv('NSE_BASE_URL', `${RELAY}/`);
		stubFetch(async (url) =>
			url.includes('apiClient') ? json(buildNseIndexDataResponse()) : html('')
		);
		await fetchIndexData();
		expect(apiCalls('apiClient').map((c) => c.url)).toEqual([
			`${RELAY}/api/NextApi/apiClient?functionName=getIndexData&&type=All`
		]);
	});

	it('sends the Akamai warm-up to the same base — the handshake warms the calling IP', async () => {
		vi.stubEnv('NSE_BASE_URL', RELAY);
		const mock = stubFetch(async (url) =>
			url.includes('apiClient') ? json(buildNseIndexDataResponse()) : html('')
		);
		await fetchIndexData();
		expect(calls[0].url).toBe(`${RELAY}/`);
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it('keeps the Referer pinned to the real origin while the socket points at the relay', async () => {
		vi.stubEnv('NSE_BASE_URL', RELAY);
		stubFetch(async (url) =>
			url.includes('apiClient') ? json(buildNseIndexDataResponse()) : html('')
		);
		await fetchIndexData();
		const headers = new Headers(apiCalls('apiClient')[0].init?.headers);
		expect(headers.get('referer')).toBe('https://www.nseindia.com/');
		expect(headers.get('user-agent')).toContain('Mozilla/5.0');
		expect(headers.has('cookie')).toBe(false);
	});

	it('re-points E3 (the watchdog probe) too', async () => {
		vi.stubEnv('NSE_BASE_URL', RELAY);
		stubFetch(async (url) =>
			url.includes('marketStatus') ? json(buildMarketStatusResponse()) : html('')
		);
		await probeNseHealth();
		expect(apiCalls('marketStatus').map((c) => c.url)).toEqual([`${RELAY}/api/marketStatus`]);
	});

	it('leaves production untouched when the variable is unset', async () => {
		stubFetch(async (url) =>
			url.includes('apiClient') ? json(buildNseIndexDataResponse()) : html('')
		);
		await fetchIndexData();
		expect(apiCalls('apiClient')[0].url).toBe(E1_URL);
		expect(calls[0].url).toBe(NSE_HOME);
	});

	it('fails loudly on an override without a scheme — never silently back at NSE', async () => {
		vi.stubEnv('NSE_BASE_URL', 'mac.tail1234.ts.net:8081');
		stubFetch(async () => json(buildNseIndexDataResponse()));
		await expect(fetchIndexData()).rejects.toBeInstanceOf(FeedBaseUrlError);
		// not one byte left the process: no warm-up, no API call, and no accidental
		// request to the real NSE from a blocked IP
		expect(calls).toHaveLength(0);
	});
});
