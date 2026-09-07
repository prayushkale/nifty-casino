/**
 * CAS history store — the dropdown's option list and the past-day archive
 * fetch (the same-day movement stays visible in `cas_ticks`; this is the door
 * back into it once the board moved on). All wire access is injected, so the
 * fetch layer is tested without a browser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	casHistory,
	historyLatest,
	historySeries,
	initialCasHistory,
	loadCasHistoryDays,
	parseHistoryResponse,
	selectCasHistoryDay
} from './casHistory';

const DAY = '2026-08-28';
const at = (h: number, m: number, s: number): number => Date.UTC(2026, 7, 28, h - 5, m - 30, s); // IST → UTC ms on DAY

beforeEach(() => {
	casHistory.set({ ...initialCasHistory });
	historySeries.set(null);
	historyLatest.set(null);
});

describe('parseHistoryResponse', () => {
	it('slices ticks and display values out of a /api/cas/all body', () => {
		const body = {
			tradeDate: DAY,
			ticks: {
				nifty: [
					{ ts: at(15, 13, 30), value: 25010 },
					{ ts: at(15, 13, 34), value: 25020 }
				],
				sensex: [{ ts: at(15, 13, 30), value: 82010 }]
			},
			latest: {
				nifty: {
					value: 25020,
					changePts: 20,
					changePct: 0.08,
					prevClose: 25000,
					ts: at(15, 13, 34)
				},
				sensex: {
					value: 82010,
					changePts: 10,
					changePct: 0.012,
					prevClose: 82000,
					ts: at(15, 13, 30)
				}
			}
		};
		const parsed = parseHistoryResponse(body);
		expect(parsed.ticks.nifty).toHaveLength(2);
		expect(parsed.ticks.banknifty).toEqual([]);
		expect(parsed.ticks.nifty[1]).toEqual({ ts: at(15, 13, 34), value: 25020 });
		expect(parsed.latest.nifty?.value).toBe(25020);
		expect(parsed.latest.nifty?.prevClose).toBe(25000);
	});

	it('drops junk ticks and junk display entries instead of throwing', () => {
		const body = {
			ticks: {
				nifty: [
					{ ts: 'nope', value: 1 },
					{ ts: at(15, 13, 30), value: 0 },
					{ ts: at(15, 13, 30), value: Number.NaN },
					{ ts: at(15, 13, 34), value: 25020 }
				]
			},
			latest: {
				nifty: { value: '25020', ts: at(15, 13, 34) },
				banknifty: null
			}
		};
		const parsed = parseHistoryResponse(body);
		expect(parsed.ticks.nifty).toEqual([{ ts: at(15, 13, 34), value: 25020 }]);
		expect(parsed.latest.nifty).toBeUndefined();
		expect(parsed.latest.banknifty).toBeUndefined();
	});

	it('sorts ticks ascending and yields empty slices for a non-object body', () => {
		const parsed = parseHistoryResponse({
			ticks: {
				nifty: [
					{ ts: 200, value: 1 },
					{ ts: 100, value: 2 }
				]
			}
		});
		expect(parsed.ticks.nifty.map((t) => t.ts)).toEqual([100, 200]);
		expect(parseHistoryResponse(null).ticks.nifty).toEqual([]);
		expect(parseHistoryResponse('junk').latest).toEqual({});
	});
});

describe('loadCasHistoryDays', () => {
	it('loads the option list and marks the store loaded', async () => {
		const fetchImpl = async () =>
			new Response(JSON.stringify({ days: [DAY, '2026-08-27'] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		const days = await loadCasHistoryDays({ fetchImpl });
		expect(days).toEqual([DAY, '2026-08-27']);
		expect(get(casHistory)).toMatchObject({ days: [DAY, '2026-08-27'], loaded: true, error: null });
	});

	it('ignores junk entries and survives a failed fetch with loaded=true', async () => {
		const junk = await loadCasHistoryDays({
			fetchImpl: async () =>
				new Response(JSON.stringify({ days: [DAY, 'not-a-date', 42] }), { status: 200 })
		});
		expect(junk).toEqual([DAY]);

		// A later failed re-fetch keeps the days already loaded and says so.
		await loadCasHistoryDays({ fetchImpl: async () => new Response('nope', { status: 500 }) });
		expect(get(casHistory)).toMatchObject({
			days: [DAY],
			loaded: true,
			error: 'Could not load CAS history.'
		});
	});
});

describe('selectCasHistoryDay', () => {
	it('null returns to the live board and clears the archive slices', async () => {
		historySeries.set({ nifty: [], banknifty: [], sensex: [] });
		const ok = await selectCasHistoryDay(null);
		expect(ok).toBe(true);
		expect(get(casHistory).selected).toBeNull();
		expect(get(historySeries)).toBeNull();
		expect(get(historyLatest)).toBeNull();
	});

	it('a date fetches the archive and publishes ticks + latest', async () => {
		const body = {
			tradeDate: DAY,
			ticks: { nifty: [{ ts: at(15, 13, 30), value: 25010 }] },
			latest: {
				nifty: {
					value: 25010,
					changePts: 10,
					changePct: 0.04,
					prevClose: 25000,
					ts: at(15, 13, 30)
				}
			}
		};
		const ok = await selectCasHistoryDay(DAY, {
			archiveUrl: (d) => `/api/cas/all?date=${d}`,
			fetchImpl: async (url: RequestInfo | URL) => {
				expect(String(url)).toBe(`/api/cas/all?date=${DAY}`);
				return new Response(JSON.stringify(body), { status: 200 });
			}
		});
		expect(ok).toBe(true);
		expect(get(casHistory)).toMatchObject({ selected: DAY, loading: false, error: null });
		expect(get(historySeries)?.nifty).toHaveLength(1);
		expect(get(historyLatest)?.nifty?.value).toBe(25010);
	});

	it('a failed archive fetch reverts to the live board and surfaces the error', async () => {
		await selectCasHistoryDay(DAY, {
			fetchImpl: async () => new Response('nope', { status: 502 })
		});
		expect(get(casHistory)).toMatchObject({ selected: null, loading: false });
		expect(get(casHistory).error).toMatch(/502/);
		expect(get(historySeries)).toBeNull();
		expect(get(historyLatest)).toBeNull();
	});
});
