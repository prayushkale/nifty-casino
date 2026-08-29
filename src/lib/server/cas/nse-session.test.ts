import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NSE_BROWSER_UA, getNseSession, resetNseSession } from './nse-session';

const NSE_HOME = 'https://www.nseindia.com/';
const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** Homepage response carrying the two anti-bot cookies NSE sets. */
function withCookies(body: string): Response {
	const res = html(body);
	res.headers.append('set-cookie', 'nseappid=abc123; Path=/; HttpOnly');
	res.headers.append('set-cookie', 'AKA_A2=A; Path=/');
	return res;
}

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function stubFetch(impl: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			calls.push({ url, init });
			return impl(url, init);
		})
	);
}

beforeEach(() => {
	calls = [];
	resetNseSession();
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('getNseSession (Akamai warm-up)', () => {
	it('hits the homepage with a browser UA and no Cookie header', async () => {
		stubFetch(async () => html('<html></html>', 200));
		await getNseSession();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(NSE_HOME);
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get('user-agent')).toBe(NSE_BROWSER_UA);
		expect(headers.get('cache-control')).toBe('no-cache');
		expect(headers.has('cookie')).toBe(false);
	});

	it('caches the jar for the session TTL once the handshake yields cookies', async () => {
		stubFetch(async () => withCookies('<html></html>'));
		await expect(getNseSession()).resolves.toBe('nseappid=abc123; AKA_A2=A');
		await getNseSession();
		await getNseSession();
		expect(calls).toHaveLength(1);
	});

	it('re-handshakes on every call when the handshake yields no cookies', async () => {
		// No set-cookie (challenge/403) → nothing to cache, so each API call re-warms.
		// That is deliberate upstream behavior, not a bug.
		stubFetch(async () => html('<html></html>', 200));
		await getNseSession();
		await getNseSession();
		expect(calls).toHaveLength(2);
	});

	it('resetNseSession forces a fresh handshake on the next call', async () => {
		stubFetch(async () => withCookies('<html></html>'));
		await getNseSession();
		resetNseSession();
		await getNseSession();
		expect(calls).toHaveLength(2);
	});

	it('collects anti-bot cookies from set-cookie headers', async () => {
		stubFetch(async () => withCookies('<html></html>'));
		const jar = await getNseSession();
		expect(jar).toBe('nseappid=abc123; AKA_A2=A');
	});

	it('resolves to "" (and never throws) when the handshake fails', async () => {
		stubFetch(async () => {
			throw new Error('network down');
		});
		await expect(getNseSession()).resolves.toBe('');
	});

	it('resolves to "" when the homepage answers 403 without cookies (Akamai challenge)', async () => {
		stubFetch(async () => html('Access Denied', 403));
		await expect(getNseSession()).resolves.toBe('');
	});
});

describe('getNseSession under NSE_BASE_URL (the residential-relay path)', () => {
	const RELAY = 'http://mac.tail1234.ts.net:8081';

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('warms up through the override too — the handshake must egress from the relay’s IP', async () => {
		vi.stubEnv('NSE_BASE_URL', `${RELAY}/`);
		stubFetch(async () => withCookies('<html></html>'));
		await expect(getNseSession()).resolves.toBe('nseappid=abc123; AKA_A2=A');
		expect(calls[0].url).toBe(`${RELAY}/`);
	});

	it('keeps the handshake headers exactly as they are without an override', async () => {
		vi.stubEnv('NSE_BASE_URL', RELAY);
		stubFetch(async () => withCookies('<html></html>'));
		await getNseSession();
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get('user-agent')).toBe(NSE_BROWSER_UA);
		expect(headers.get('cache-control')).toBe('no-cache');
		expect(headers.has('cookie')).toBe(false);
	});

	it('still resolves to "" (never throws) when the override base is unreachable', async () => {
		vi.stubEnv('NSE_BASE_URL', 'http://127.0.0.1:9');
		stubFetch(async () => {
			throw new Error('ECONNREFUSED');
		});
		await expect(getNseSession()).resolves.toBe('');
	});
});
