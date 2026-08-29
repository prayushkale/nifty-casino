import { describe, expect, it } from 'vitest';
import { BSE_BASE_URL_ENV, NSE_BASE_URL_ENV, FeedBaseUrlError, feedBaseUrl } from './feed-base-url';

describe('feedBaseUrl (NSE_BASE_URL / BSE_BASE_URL seam)', () => {
	const resolve = (value: string | undefined, fallback = 'https://www.nseindia.com'): string =>
		feedBaseUrl({ [NSE_BASE_URL_ENV]: value }, NSE_BASE_URL_ENV, fallback);

	it('falls back to the literal upstream when the variable is unset', () => {
		expect(feedBaseUrl({}, NSE_BASE_URL_ENV, 'https://www.nseindia.com')).toBe(
			'https://www.nseindia.com'
		);
		expect(resolve(undefined)).toBe('https://www.nseindia.com');
	});

	it('treats empty and whitespace-only as unset', () => {
		expect(resolve('')).toBe('https://www.nseindia.com');
		expect(resolve('   ')).toBe('https://www.nseindia.com');
		expect(resolve('\t')).toBe('https://www.nseindia.com');
	});

	it('honours an override and trims surrounding whitespace', () => {
		expect(resolve('http://mac:8081')).toBe('http://mac:8081');
		expect(resolve('  https://relay.tail-scale.ts.net  ')).toBe('https://relay.tail-scale.ts.net');
	});

	it('trims trailing slashes so base + path never yields "//"', () => {
		expect(resolve('http://mac:8081/')).toBe('http://mac:8081');
		expect(resolve('http://mac:8081///')).toBe('http://mac:8081');
	});

	it('keeps an explicit path (a relay that fronts only one of the upstreams)', () => {
		expect(resolve('http://mac:8081/bse')).toBe('http://mac:8081/bse');
	});

	it('is case-insensitive about the scheme', () => {
		expect(resolve('HTTP://mac:8081')).toBe('HTTP://mac:8081');
	});

	it('throws rather than silently ignoring a bad override', () => {
		expect(() => resolve('mac:8081')).toThrow(FeedBaseUrlError);
		expect(() => resolve('ftp://mac:8081')).toThrow(FeedBaseUrlError);
		expect(() => resolve('//mac:8081')).toThrow(FeedBaseUrlError);
	});

	it('names the offending variable in the error', () => {
		expect(() => feedBaseUrl({ [BSE_BASE_URL_ENV]: 'nope' }, BSE_BASE_URL_ENV, 'x')).toThrow(
			/BSE_BASE_URL/
		);
	});

	it('does not let one feed’s variable leak into the other', () => {
		const env = { [NSE_BASE_URL_ENV]: 'http://nse-relay:8081' };
		expect(
			feedBaseUrl(env, BSE_BASE_URL_ENV, 'https://api.bseindia.com/RealTimeBseIndiaAPI/api')
		).toBe('https://api.bseindia.com/RealTimeBseIndiaAPI/api');
	});
});
