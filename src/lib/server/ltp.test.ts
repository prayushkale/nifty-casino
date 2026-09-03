/**
 * ltp — the last-traded-price service. No network: every upstream fetcher is
 * injected, and the store is an in-memory one, so the whole
 * fetch → persist → ensure → read-back cycle runs hermetically.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './db';
import type { Underlying } from './db/types';
import { istAt, SATURDAY, THURSDAY } from './cas/test-clock';
import type { LtpQuotes } from './ltp';
import { buildBseSensexRow, buildNseIndexDataResponse } from './cas/test-fixtures';
import { invalidateLadderCache } from './ladder';
import {
	ensureLtpAnchors,
	fetchLiveLtp,
	invalidateLtpCache,
	isLtpAnchorDue,
	persistLtpAnchors,
	readLtpAnchors
} from './ltp';
import { getLadderForDate, getLadderForDateWithLiveFallback } from './ladder';

const DAY = THURSDAY;

/** Feeds carrying a real `last`/`ltp` — the all-day LTP fields. */
const LIVE_DEPS = {
	fetchNseIndexData: async () => buildNseIndexDataResponse(), // nifty last 24630.2, banknifty last 56210.4
	fetchBseSensexRows: async () => [buildBseSensexRow()] // sensex ltp 78831.32
};

beforeEach(() => {
	invalidateLtpCache();
	invalidateLadderCache();
});

describe('isLtpAnchorDue — the 15:15:01 freeze boundary', () => {
	it.each([
		['one second early', istAt(DAY, 15, 15, 0), false],
		['the anchor second (inclusive)', istAt(DAY, 15, 15, 1), true],
		['mid-afternoon', istAt(DAY, 15, 42, 0), true],
		['the morning', istAt(DAY, 9, 0, 0), false],
		['Saturday afternoon (market closed)', istAt(SATURDAY, 15, 30, 0), false]
	])('%s → %s', (_label, at, expected) => {
		expect(isLtpAnchorDue(new Date(at))).toBe(expected);
	});
});

describe('fetchLiveLtp — normalized quotes per index', () => {
	it('extracts the LTP for all three indices from the injected feeds', async () => {
		const quotes = await fetchLiveLtp(LIVE_DEPS);
		expect(quotes.nifty).toMatchObject({ value: 24630.2, source: 'nse' });
		expect(quotes.banknifty).toMatchObject({ value: 56210.4, source: 'nse' });
		expect(quotes.sensex).toMatchObject({ value: 78831.32, source: 'bse' });
		// change vs the fixture's prev closes
		expect(quotes.nifty?.changePts).toBeCloseTo(24630.2 - 24586.15, 2);
		expect(quotes.sensex?.changePts).toBeCloseTo(250.32, 2);
	});

	it('never throws on a dead feed — the index just reads null', async () => {
		const quotes = await fetchLiveLtp({
			fetchNseIndexData: async () => {
				throw new Error('blocked');
			},
			fetchBseSensexRows: async () => {
				throw new Error('blocked');
			}
		});
		expect(quotes).toEqual({ nifty: null, banknifty: null, sensex: null });
	});
});

describe('persistLtpAnchors — first wins, official is sacred', () => {
	it('writes source=ltp_anchor rows for the quotes given', async () => {
		const store = new MemoryStore();
		const quotes = await fetchLiveLtp(LIVE_DEPS);
		const written = await persistLtpAnchors(store, DAY, quotes);
		expect(written).toEqual(['nifty', 'banknifty', 'sensex']);
		const rows = await store.closes.getIndexCloses(DAY);
		for (const row of rows) {
			expect(row.source).toBe('ltp_anchor');
		}
		expect(rows.find((r) => r.underlying === 'nifty')?.close).toBe(24630.2);
	});

	it('a second call writes nothing (the row already holds the anchor)', async () => {
		const store = new MemoryStore();
		const quotes = await fetchLiveLtp(LIVE_DEPS);
		await persistLtpAnchors(store, DAY, quotes);
		const written = await persistLtpAnchors(store, DAY, quotes);
		expect(written).toEqual([]);
	});

	it('never overwrites an official close', async () => {
		const store = new MemoryStore();
		await store.closes.upsertIndexClose({
			tradeDate: DAY,
			underlying: 'nifty',
			close: 24_000,
			source: 'official'
		});
		const quotes = await fetchLiveLtp(LIVE_DEPS);
		const written = await persistLtpAnchors(store, DAY, quotes);
		expect(written).not.toContain('nifty');
		const row = (await store.closes.getIndexCloses(DAY)).find((r) => r.underlying === 'nifty');
		expect(row).toMatchObject({ close: 24_000, source: 'official' });
	});

	it('replaces a live_approx fallback row — the anchor outranks the prev-close seed', async () => {
		const store = new MemoryStore();
		await store.closes.upsertIndexCloseIfAbsent({
			tradeDate: DAY,
			underlying: 'nifty',
			close: 24_586.15,
			source: 'live_approx'
		});
		const quotes = await fetchLiveLtp(LIVE_DEPS);
		await persistLtpAnchors(store, DAY, quotes);
		const row = (await store.closes.getIndexCloses(DAY)).find((r) => r.underlying === 'nifty');
		expect(row).toMatchObject({ close: 24630.2, source: 'ltp_anchor' });
	});
});

describe('ensureLtpAnchors — the bet-time guarantee', () => {
	it('is a no-op before 15:15:01: nothing fetched, nothing persisted', async () => {
		const store = new MemoryStore();
		let fetches = 0;
		const quotes = await ensureLtpAnchors(store, DAY, new Date(istAt(DAY, 15, 15, 0)), async () => {
			fetches += 1;
			return { nifty: null, banknifty: null, sensex: null };
		});
		expect(fetches).toBe(0);
		expect(quotes).toEqual({ nifty: null, banknifty: null, sensex: null });
		expect(await store.closes.getIndexCloses(DAY)).toEqual([]);
	});

	it('at/after 15:15:01 fetches the frozen LTP and persists it', async () => {
		const store = new MemoryStore();
		let fetches = 0;
		const quotes = await ensureLtpAnchors(store, DAY, new Date(istAt(DAY, 15, 15, 1)), async () => {
			fetches += 1;
			return await fetchLiveLtp(LIVE_DEPS);
		});
		expect(fetches).toBe(1);
		expect(quotes.nifty?.value).toBe(24630.2);
		const row = (await store.closes.getIndexCloses(DAY)).find((r) => r.underlying === 'nifty');
		expect(row).toMatchObject({ close: 24630.2, source: 'ltp_anchor' });
	});

	it('does not refetch for indices already anchored, and existing anchors win', async () => {
		const store = new MemoryStore();
		await store.closes.upsertIndexLtpAnchor({ tradeDate: DAY, underlying: 'nifty', close: 24_700 });
		let fetches = 0;
		const quotes = await ensureLtpAnchors(store, DAY, new Date(istAt(DAY, 15, 20, 0)), async () => {
			fetches += 1;
			return await fetchLiveLtp(LIVE_DEPS);
		});
		expect(fetches).toBe(1); // only because banknifty/sensex were missing
		expect(quotes.nifty?.value).toBe(24_700); // the earlier anchor, not the live one
	});

	it('is a full no-op once every index is anchored', async () => {
		const store = new MemoryStore();
		const quotes = await ensureLtpAnchors(store, DAY, new Date(istAt(DAY, 15, 16, 0)), async () =>
			fetchLiveLtp(LIVE_DEPS)
		);
		let fetches = 0;
		const again = await ensureLtpAnchors(store, DAY, new Date(istAt(DAY, 15, 17, 0)), async () => {
			fetches += 1;
			return quotes;
		});
		expect(fetches).toBe(0);
		expect(again.nifty?.value).toBe(24630.2);
	});
});

describe('readLtpAnchors — reading the day back', () => {
	it('returns only the ltp_anchor rows (a page loading after 15:15:01 sees the frozen price)', async () => {
		const store = new MemoryStore();
		await store.closes.upsertIndexLtpAnchor({ tradeDate: DAY, underlying: 'nifty', close: 24_650 });
		await store.closes.upsertIndexClose({
			tradeDate: DAY,
			underlying: 'sensex',
			close: 82_000,
			source: 'official'
		});
		const quotes = await readLtpAnchors(store, DAY);
		expect(quotes.nifty?.value).toBe(24_650);
		expect(quotes.banknifty).toBeNull();
		expect(quotes.sensex).toBeNull(); // official close is not an LTP anchor
	});
});

describe('the ladder reads the LTP anchor', () => {
	it("today's ltp_anchor row outranks a previous day's official close", async () => {
		const store = new MemoryStore();
		const yesterday = '2026-08-26';
		await store.closes.upsertIndexClose({
			tradeDate: yesterday,
			underlying: 'nifty',
			close: 24_000,
			source: 'official'
		});
		await store.closes.upsertIndexLtpAnchor({ tradeDate: DAY, underlying: 'nifty', close: 24_650 });
		const ladder = await getLadderForDate(store, DAY);
		expect(ladder.anchors.nifty).toBe(24_650); // the LTP, not yesterday's close
		// Indices without an anchor today fall back to the walk-back as before.
		expect(ladder.anchors.banknifty).toBeNull();
	});
});

describe('underlying parity', () => {
	it('persistLtpAnchors ignores non-positive values silently', async () => {
		const store = new MemoryStore();
		const junk: LtpQuotes = {
			nifty: {
				underlying: 'nifty',
				value: 0, // a zero print is "not published", never an anchor
				changePts: 0,
				changePct: 0,
				prevClose: null,
				ts: 0,
				source: 'nse'
			},
			banknifty: null,
			sensex: null
		};
		expect(await persistLtpAnchors(store, DAY, junk)).toEqual([]);
	});
});

describe('the ladder cache must not outlive the anchor', () => {
	it('a ladder cached before 15:15:01 re-resolves onto the LTP anchor after it', async () => {
		const store = new MemoryStore();
		// The poller seeded the prev-close fallback at 15:13:30; the ladder built
		// from it is now in the process cache.
		for (const [u, close] of [
			['nifty', 24_586.15],
			['banknifty', 56_104.8],
			['sensex', 78_581.0]
		] as const) {
			await store.closes.upsertIndexCloseIfAbsent({
				tradeDate: DAY,
				underlying: u as Underlying,
				close,
				source: 'live_approx'
			});
		}
		const pre = await getLadderForDate(store, DAY);
		expect(pre.anchors.nifty).toBe(24_586.15);

		// 15:16: the LTP anchor is due — the wrapper must re-resolve, not serve the
		// pre-anchor cache, or bets would hang off a price nobody is showing.
		const post = await getLadderForDateWithLiveFallback(
			store,
			DAY,
			LIVE_DEPS,
			new Date(istAt(DAY, 15, 16, 0))
		);
		expect(post.anchors.nifty).toBe(24630.2);
		expect(post.anchors.banknifty).toBe(56210.4);
		expect(post.anchors.sensex).toBe(78831.32);
	});
});
