/**
 * Snapshot assembly tests — the refresh/reconnect path (PLAN §2).
 *
 * The scenario that matters: a player closes the tab at 15:05 and reopens at
 * 15:38. RAM holds the last 48 minutes, Postgres holds everything, and
 * `buildCasSnapshot` is the join between the two. The memory GameStore stands in
 * for Postgres, so the merge is exercised against the real repo API.
 */
import { describe, expect, it } from 'vitest';
import { istAt, THURSDAY, WEDNESDAY } from './cas/test-clock';
import { CasStore } from './cas-store';
import type { CasTickPayload, Underlying } from './cas/types';
import { MemoryStore } from './db';
import type { CasTickRow } from './db/types';
import { buildCasSnapshot, mergeCasSeries, MAX_SNAPSHOT_TICKS } from './cas-snapshot';

const DAY = WEDNESDAY;
const NOW = new Date(istAt(DAY, 15, 20, 0));

function row(ts: number, value: number, underlying: Underlying = 'nifty'): CasTickRow {
	return { tradeDate: DAY, underlying, ts, value, changePts: 10, changePct: 0.04 };
}

function payload(ts: number, value: number, underlying: Underlying = 'nifty'): CasTickPayload {
	return {
		underlying,
		value,
		changePts: 10,
		changePct: 0.04,
		prevClose: 24988,
		ts,
		source: 'nse'
	};
}

/** Ticks every 4s across [fromMinute, toMinute) — one minute = 15 ticks. */
function minuteOfTicks(
	minute: number,
	value: number,
	underlying: Underlying = 'nifty'
): CasTickRow[] {
	return Array.from({ length: 15 }, (_, i) =>
		row(istAt(DAY, 15, minute, (i % 15) * 4) + Math.floor(i / 15) * 1000, value + i, underlying)
	);
}

async function seededStore(rows: CasTickRow[]): Promise<MemoryStore> {
	const store = new MemoryStore();
	await store.ticks.insertCasTicks(rows);
	return store;
}

describe('mergeCasSeries', () => {
	it('merges a DB backfill with the hot tail, ascending and deduped', () => {
		const hot = [
			{ ts: 3000, value: 3 },
			{ ts: 4000, value: 4 }
		];
		const backfill: CasTickRow[] = [row(2000, 2), row(3000, 99), row(1000, 1)];
		expect(mergeCasSeries(hot, backfill)).toEqual({
			ticks: [
				{ ts: 1000, value: 1 },
				{ ts: 2000, value: 2 },
				{ ts: 3000, value: 3 }, // RAM wins the ts collision
				{ ts: 4000, value: 4 }
			],
			truncated: false
		});
	});

	it('caps from the front (the oldest rows survive) and flags it', () => {
		const hot: { ts: number; value: number }[] = [];
		const backfill = Array.from({ length: 12 }, (_, i) => row((i + 1) * 1000, i + 1));
		const merged = mergeCasSeries(hot, backfill, 5);
		expect(merged.truncated).toBe(true);
		expect(merged.ticks.map((t) => t.ts)).toEqual([1000, 2000, 3000, 4000, 5000]);
	});

	it('does not flag a series that lands exactly on the cap', () => {
		const backfill = Array.from({ length: MAX_SNAPSHOT_TICKS }, (_, i) => row(i * 1000, i));
		expect(mergeCasSeries([], backfill).truncated).toBe(false);
	});
});

describe('buildCasSnapshot — hot buffer only', () => {
	it('serves the ring buffer without touching the DB when the cursor is inside it', async () => {
		const store = await seededStore([...minuteOfTicks(0, 24000), ...minuteOfTicks(1, 24015)]);
		const hot = new CasStore();
		hot.ingest(
			[
				payload(istAt(DAY, 15, 14), 25000),
				payload(istAt(DAY, 15, 14, 4), 25002),
				payload(istAt(DAY, 15, 14, 8), 25004)
			],
			NOW
		);

		const snapshot = await buildCasSnapshot({ store, hot, since: istAt(DAY, 15, 14, 4), now: NOW });

		expect(snapshot.tradeDate).toBe(DAY);
		expect(snapshot.serverNow).toBe(istAt(DAY, 15, 20, 0));
		expect(snapshot.bufferedFrom).toBe(istAt(DAY, 15, 14));
		expect(snapshot.ticks.nifty.map((t) => t.value)).toEqual([25004]);
		expect(snapshot.latest.nifty?.value).toBe(25004);
		expect(snapshot.latest.nifty?.prevClose).toBe(24988);
		expect(snapshot.truncated).toBe(false);
	});

	it('returns the whole buffered tail when no cursor is given', async () => {
		const store = await seededStore([]);
		const hot = new CasStore();
		hot.ingest([payload(istAt(DAY, 15, 14), 1), payload(istAt(DAY, 15, 14, 4), 2, 'sensex')], NOW);
		const snapshot = await buildCasSnapshot({ store, hot, now: NOW });
		expect(snapshot.ticks.nifty).toHaveLength(1);
		expect(snapshot.ticks.sensex).toHaveLength(1);
		expect(snapshot.ticks.banknifty).toHaveLength(0);
	});

	it('flags staleness only when the auction is live and the feed has gone quiet', async () => {
		const hot = new CasStore();
		hot.ingest([payload(istAt(DAY, 15, 19, 47), 1)], NOW);
		const stale = await buildCasSnapshot({ store: new MemoryStore(), hot, now: NOW });
		expect(stale.stale).toBe(true);

		const fresh = await buildCasSnapshot({
			store: new MemoryStore(),
			hot,
			now: new Date(istAt(DAY, 15, 19, 52))
		});
		expect(fresh.stale).toBe(false);

		const afterClose = await buildCasSnapshot({
			store: new MemoryStore(),
			hot,
			now: new Date(istAt(DAY, 18, 0, 0))
		});
		expect(afterClose.stale).toBe(false);
	});
});

describe('buildCasSnapshot — the DB backfill beyond the RAM horizon', () => {
	it('joins cas_ticks with the hot tail for a cursor older than bufferedFrom', async () => {
		// two full minutes in the archive (15:00, 15:01), the last three polls in RAM
		const store = await seededStore([...minuteOfTicks(0, 24000), ...minuteOfTicks(1, 24015)]);
		const hot = new CasStore();
		hot.ingest(
			[
				payload(istAt(DAY, 15, 14), 25000),
				payload(istAt(DAY, 15, 14, 4), 25002),
				payload(istAt(DAY, 15, 14, 8), 25004)
			],
			NOW
		);

		const snapshot = await buildCasSnapshot({ store, hot, since: istAt(DAY, 15, 0, 0), now: NOW });

		const series = snapshot.ticks.nifty;
		// the tick at `since` itself is the one the client already has — not re-sent
		expect(series).toHaveLength(29 + 3);
		expect(series[0]?.value).toBe(24001);
		expect(series.at(-1)?.value).toBe(25004);
		// ascending, no duplicates: a chart can feed this straight in
		const tsList = series.map((t) => t.ts);
		expect([...tsList].sort((a, b) => a - b)).toEqual(tsList);
		expect(new Set(tsList).size).toBe(tsList.length);
		// the archive gap stops exactly where the RAM tail starts
		expect(series.filter((t) => t.ts < istAt(DAY, 15, 14)).length).toBe(29);
		expect(snapshot.bufferedFrom).toBe(istAt(DAY, 15, 14));
	});

	it('rebuilds a whole day from the archive when RAM is empty (mid-auction restart)', async () => {
		const store = await seededStore([...minuteOfTicks(0, 24000), ...minuteOfTicks(13, 24195)]);
		const hot = new CasStore(); // the process just restarted: nothing buffered

		const snapshot = await buildCasSnapshot({ store, hot, now: NOW });

		expect(snapshot.ticks.nifty).toHaveLength(30);
		expect(snapshot.bufferedFrom).toBeNull();
		expect(snapshot.latest.nifty?.value).toBe(24195 + 14);
	});

	it('does not re-send ticks the client already has when RAM is empty', async () => {
		const store = await seededStore(minuteOfTicks(0, 24000));
		const hot = new CasStore();
		const snapshot = await buildCasSnapshot({
			store,
			hot,
			since: istAt(DAY, 15, 0, 32),
			now: NOW
		});
		expect(snapshot.ticks.nifty.every((t) => t.ts > istAt(DAY, 15, 0, 32))).toBe(true);
		expect(snapshot.ticks.nifty.length).toBeGreaterThan(0);
	});

	it('caps a huge backfill and says so', async () => {
		const rows: CasTickRow[] = Array.from({ length: 40 }, (_, i) =>
			row(istAt(DAY, 14, 0) + i * 1000, i)
		);
		const store = await seededStore(rows);
		const snapshot = await buildCasSnapshot({
			store,
			hot: new CasStore(),
			now: NOW,
			cap: 10
		});
		expect(snapshot.ticks.nifty).toHaveLength(10);
		expect(snapshot.truncated).toBe(true);
	});

	it('answers a cursor the archive cannot satisfy with an empty series, not an error', async () => {
		const store = await seededStore([]);
		const snapshot = await buildCasSnapshot({
			store,
			hot: new CasStore(),
			since: istAt(DAY, 15, 0, 0),
			now: NOW
		});
		expect(snapshot.ticks.nifty).toEqual([]);
		expect(snapshot.latest).toEqual({});
	});
});

describe('buildCasSnapshot — past-day replay (?date=)', () => {
	it('serves a past day from the archive only, anchored on the previous close', async () => {
		const store = await seededStore([
			...minuteOfTicks(0, 24000),
			...minuteOfTicks(1, 24015, 'sensex')
		]);
		await store.closes.upsertIndexClose({
			tradeDate: '2026-08-24',
			underlying: 'nifty',
			close: 24988,
			source: 'official'
		});

		const yesterday = '2026-08-25'; // the Tuesday before the fixed Wednesday
		const rows: CasTickRow[] = minuteOfTicks(0, 24000).map((r) => ({ ...r, tradeDate: yesterday }));
		await store.ticks.insertCasTicks(rows);
		await store.closes.upsertIndexClose({
			tradeDate: yesterday,
			underlying: 'sensex',
			close: 82000,
			source: 'live_approx'
		});

		const snapshot = await buildCasSnapshot({
			store,
			hot: new CasStore(),
			date: yesterday,
			now: NOW
		});

		expect(snapshot.tradeDate).toBe(yesterday);
		expect(snapshot.bufferedFrom).toBeNull(); // nothing in RAM for a past day
		expect(snapshot.stale).toBe(false); // staleness is a live-auction concept
		expect(snapshot.ticks.nifty).toHaveLength(15);
		expect(snapshot.ticks.sensex).toHaveLength(0); // that minute belongs to today
		expect(snapshot.latest.nifty).toEqual({
			value: 24014,
			changePts: 24014 - 24988,
			changePct: ((24014 - 24988) / 24988) * 100,
			prevClose: 24988,
			ts: snapshot.ticks.nifty.at(-1)?.ts,
			source: 'archive'
		});
	});

	it('serves today when the date is omitted or equals today', async () => {
		const store = await seededStore([]);
		const hot = new CasStore();
		hot.ingest([payload(istAt(DAY, 15, 14), 1)], NOW);
		const byDefault = await buildCasSnapshot({ store, hot, now: NOW });
		const explicit = await buildCasSnapshot({ store, hot, date: DAY, now: NOW });
		expect(byDefault.ticks.nifty).toEqual(explicit.ticks.nifty);
		expect(explicit.tradeDate).toBe(DAY);
	});
});

describe('the served trade date', () => {
	it('uses the hot store for today even when the archive has today’s rows too', async () => {
		const store = await seededStore(minuteOfTicks(0, 24000));
		const hot = new CasStore();
		hot.ingest([payload(istAt(DAY, 15, 14), 25000)], NOW);

		// no cursor: RAM is authoritative for the hot tail, no DB read needed
		const snapshot = await buildCasSnapshot({ store, hot, now: NOW });
		expect(snapshot.ticks.nifty).toHaveLength(1);
		expect(snapshot.bufferedFrom).toBe(istAt(DAY, 15, 14));
	});

	it('keeps THURSDAY ticks out of WEDNESDAY’s snapshot', async () => {
		const store = await seededStore([{ ...row(istAt(THURSDAY, 15, 14), 9999) }]);
		const snapshot = await buildCasSnapshot({
			store,
			hot: new CasStore(),
			since: istAt(DAY, 15, 0, 0),
			now: NOW
		});
		expect(snapshot.ticks.nifty).toEqual([]);
	});
});
