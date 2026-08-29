import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NseAPIError } from './nse-api';
import { bseNum, classifyBseFailure, fetchBseSensexRows } from './bse-api';
import { FeedBaseUrlError } from './feed-base-url';
import { buildBseSensexRow } from './test-fixtures';

const BSE_URL = 'https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexDatanew/w';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function stubFetch(impl: (url: string) => Promise<Response>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			calls.push({ url, init });
			return impl(url);
		})
	);
}

beforeEach(() => {
	calls = [];
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('classifyBseFailure', () => {
	it('accepts a JSON 200', () => {
		expect(classifyBseFailure(200, 'application/json', '[]')).toBeNull();
	});

	it('BLOCKED on HTTP 403 or an error_Bse body', () => {
		expect(classifyBseFailure(403, 'text/html', '')?.code).toBe('BLOCKED');
		expect(classifyBseFailure(200, 'text/html', 'error_Bse: blocked')?.code).toBe('BLOCKED');
		expect(classifyBseFailure(200, 'text/html', 'Access Denied')?.code).toBe('BLOCKED');
	});

	it('AUTH otherwise (non-JSON / non-OK)', () => {
		expect(classifyBseFailure(500, 'application/json', '{}')?.code).toBe('AUTH');
		expect(classifyBseFailure(200, null, '')?.code).toBe('AUTH');
		expect(classifyBseFailure(200, 'text/html', '<html/>')?.code).toBe('AUTH');
	});
});

describe('fetchBseSensexRows', () => {
	it('calls GetSensexDatanew with Origin + Referer and no Cookie header', async () => {
		stubFetch(async () => json([buildBseSensexRow()]));
		const rows = await fetchBseSensexRows();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(BSE_URL);
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get('origin')).toBe('https://www.bseindia.com');
		expect(headers.get('referer')).toBe(
			'https://www.bseindia.com/markets/equity/closing_auction_session'
		);
		expect(headers.get('user-agent')).toContain('Mozilla/5.0');
		expect(headers.has('cookie')).toBe(false);
		// raw rows are passed through untouched — the extractors own the field names
		expect(rows).toHaveLength(1);
		expect((rows[0] as { indxnm?: string }).indxnm).toBe('BSE SENSEX');
	});

	it('PARSE error when BSE answers with a JSON object instead of an array', async () => {
		stubFetch(async () => json({ error: 'nope' }));
		await expect(fetchBseSensexRows()).rejects.toMatchObject({ code: 'PARSE' });
	});

	it('BLOCKED error on a 403 (Akamai/origin block)', async () => {
		stubFetch(async () => html('Access Denied', 403));
		const err = await fetchBseSensexRows().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NseAPIError);
		expect((err as NseAPIError).code).toBe('BLOCKED');
		expect((err as NseAPIError).status).toBe(403);
	});

	it('AUTH error on an unexpected non-JSON 200', async () => {
		stubFetch(async () => html('<html></html>'));
		await expect(fetchBseSensexRows()).rejects.toMatchObject({ code: 'AUTH' });
	});

	it('NETWORK error when the endpoint is unreachable', async () => {
		stubFetch(async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		});
		await expect(fetchBseSensexRows()).rejects.toMatchObject({ code: 'NETWORK' });
	});

	it('TIMEOUT error when the request is aborted', async () => {
		stubFetch(async () => {
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		});
		await expect(fetchBseSensexRows()).rejects.toMatchObject({ code: 'TIMEOUT' });
	});
});

describe('bseNum re-export parity', () => {
	it('matches the extractor module definition', () => {
		expect(bseNum('-')).toBe(0);
		expect(bseNum('78,845.12')).toBe(78845.12);
	});
});

describe('BSE_BASE_URL override (the residential-relay path)', () => {
	const RELAY = 'http://mac.tail1234.ts.net:8081';

	it('routes GetSensexDatanew through the override, trimming a trailing slash', async () => {
		vi.stubEnv('BSE_BASE_URL', `${RELAY}/`);
		stubFetch(async () => json([buildBseSensexRow()]));
		const rows = await fetchBseSensexRows();
		expect(calls[0].url).toBe(`${RELAY}/GetSensexDatanew/w`);
		expect(rows).toHaveLength(1);
	});

	it('keeps Origin + Referer pinned to the real site and sends no cookies', async () => {
		vi.stubEnv('BSE_BASE_URL', RELAY);
		stubFetch(async () => json([buildBseSensexRow()]));
		await fetchBseSensexRows();
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get('origin')).toBe('https://www.bseindia.com');
		expect(headers.get('referer')).toBe(
			'https://www.bseindia.com/markets/equity/closing_auction_session'
		);
		expect(headers.has('cookie')).toBe(false);
	});

	it('keeps the literal upstream URL when the variable is unset', async () => {
		stubFetch(async () => json([buildBseSensexRow()]));
		await fetchBseSensexRows();
		expect(calls[0].url).toBe(BSE_URL);
	});

	it('fails loudly on an override without a scheme — never silently back at BSE', async () => {
		vi.stubEnv('BSE_BASE_URL', 'mac.tail1234.ts.net:8081');
		stubFetch(async () => json([buildBseSensexRow()]));
		await expect(fetchBseSensexRows()).rejects.toBeInstanceOf(FeedBaseUrlError);
		expect(calls).toHaveLength(0);
	});
});
