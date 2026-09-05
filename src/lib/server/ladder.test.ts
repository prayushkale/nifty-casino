/**
 * Ladder service (PLAN §5 T8) — anchors out of `index_closes`, the ±3% clamp and
 * the odds round-trip bet placement depends on.
 *
 * Runs against the memory driver: the service only ever reads `closes`, which the
 * two drivers already agree on (see ./db/postgres.test.ts for the driver contract).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	MAX_HIT_ODDS,
	LADDER_UNDERLYINGS,
	generateLadderOptions,
	type LadderTargetKind,
	type LadderUnderlying
} from '$lib/config/ladder';
import { MemoryStore, type GameStore } from '$lib/server/db';
import type { CloseSource } from '$lib/server/db/types';
import { getLadderForDate, invalidateLadderCache, resolveLadderOption } from './ladder';

/** A Wednesday / Thursday / Friday triple, then the weekend and the Monday after. */
const WEDNESDAY = '2026-08-26';
const THURSDAY = '2026-08-27';
const FRIDAY = '2026-08-28';
const SATURDAY = '2026-08-29';
const SUNDAY = '2026-08-30';
const MONDAY = '2026-08-31';

/** The PLAN §0.1 launch anchors, as the previous trading day's official closes. */
const LAUNCH_ANCHORS: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

async function seedCloses(
	store: GameStore,
	tradeDate: string,
	closes: Partial<Record<LadderUnderlying, number>>,
	source: CloseSource = 'official'
): Promise<void> {
	for (const underlying of LADDER_UNDERLYINGS) {
		const close = closes[underlying];
		if (close === undefined) continue;
		await store.closes.upsertIndexClose({ tradeDate, underlying, close, source });
	}
}

/** A store whose previous trading day closed at the launch anchors. */
async function ladderStore(tradeDate: string, prevDay: string): Promise<GameStore> {
	const store = new MemoryStore();
	await seedCloses(store, prevDay, LAUNCH_ANCHORS);
	return store;
}

beforeEach(() => {
	// The cache is process-wide; every test builds its own store behind it.
	invalidateLadderCache();
});

describe('getLadderForDate', () => {
	it('hangs 8 options per index off the previous trading day close', async () => {
		const store = await ladderStore(THURSDAY, WEDNESDAY);
		const ladder = await getLadderForDate(store, THURSDAY);

		expect(ladder.tradeDate).toBe(THURSDAY);
		expect(ladder.anchors).toEqual({ nifty: 25_000, banknifty: 56_000, sensex: 82_000 });
		expect(ladder.options).toEqual(generateLadderOptions(ladder.anchors));
		expect(ladder.options).toHaveLength(94);
		expect(ladder.generatedAt).toBeGreaterThan(0);
	});

	it('skips weekends to find the anchor: the Friday close serves Monday', async () => {
		const store = await ladderStore(MONDAY, FRIDAY);
		const ladder = await getLadderForDate(store, MONDAY);

		expect(ladder.anchors).toEqual(LAUNCH_ANCHORS);
		expect(ladder.options).toHaveLength(94);
	});

	it('serves Saturday and Sunday too — nothing bets on them, but the ladder is answerable', async () => {
		for (const weekendDay of [SATURDAY, SUNDAY]) {
			invalidateLadderCache();
			const store = await ladderStore(weekendDay, FRIDAY);
			const ladder = await getLadderForDate(store, weekendDay);
			// Saturday's walk-back lands on Friday directly; Sunday skips Saturday too.
			expect(ladder.anchors, weekendDay).toEqual(LAUNCH_ANCHORS);
			expect(ladder.options, weekendDay).toHaveLength(94);
		}
	});

	it('walks back over a holiday-ridden gap but gives up after ten days', async () => {
		// 2026-08-21 (a Friday) is 8 calendar days before that Monday — reachable.
		const nearer = new MemoryStore();
		await seedCloses(nearer, '2026-08-21', LAUNCH_ANCHORS);
		expect((await getLadderForDate(nearer, MONDAY)).anchors).toEqual(LAUNCH_ANCHORS);

		// 2026-08-14 is 17 calendar days back — outside the window, no ladder at all.
		invalidateLadderCache(); // same trade date, different store: drop the cached one
		const tooFar = new MemoryStore();
		await seedCloses(tooFar, '2026-08-14', LAUNCH_ANCHORS);
		expect((await getLadderForDate(tooFar, MONDAY)).anchors).toEqual({
			nifty: null,
			banknifty: null,
			sensex: null
		});
	});

	it('falls back to today’s own live_approx row when no official close exists yet', async () => {
		const store = new MemoryStore();
		// The poller's 15:13:30 write: today's date, previous day's close, live_approx.
		await seedCloses(store, THURSDAY, LAUNCH_ANCHORS, 'live_approx');
		expect((await getLadderForDate(store, THURSDAY)).anchors).toEqual(LAUNCH_ANCHORS);
	});

	it('prefers the official close over a live_approx row', async () => {
		const store = new MemoryStore();
		await seedCloses(store, WEDNESDAY, LAUNCH_ANCHORS, 'official');
		await seedCloses(store, THURSDAY, LAUNCH_ANCHORS, 'live_approx');
		// Both would anchor the day; make the live one obviously wrong so the
		// preference is visible rather than coincidental.
		await store.closes.upsertIndexClose({
			tradeDate: THURSDAY,
			underlying: 'nifty',
			close: 99_999,
			source: 'live_approx'
		});

		expect((await getLadderForDate(store, THURSDAY)).anchors.nifty).toBe(25_000);
	});

	it('never anchors a day on its own official close (the T9 regression)', async () => {
		// Once settlement lands today's official close it sits in the same table the
		// ladder reads. It is a CLOSE, not a previous-day anchor: anchoring on it
		// would make every Δ zero and refund the entire day.
		const store = new MemoryStore();
		await seedCloses(store, WEDNESDAY, LAUNCH_ANCHORS, 'official');
		await seedCloses(
			store,
			THURSDAY,
			{ nifty: 25_050, banknifty: 56_010, sensex: 82_600 },
			'official'
		);

		expect((await getLadderForDate(store, THURSDAY)).anchors).toEqual(LAUNCH_ANCHORS);
	});

	it('still falls back to today’s own row after the walk-back finds nothing', async () => {
		// First trading day of a deployment: no previous day at all, but the poller
		// has already written the feed's prevClose for today.
		const store = new MemoryStore();
		await seedCloses(store, THURSDAY, LAUNCH_ANCHORS, 'live_approx');
		expect((await getLadderForDate(store, THURSDAY)).anchors).toEqual(LAUNCH_ANCHORS);

		// …whereas today's OFFICIAL close is never mistaken for one.
		invalidateLadderCache();
		const settled = new MemoryStore();
		await seedCloses(settled, THURSDAY, LAUNCH_ANCHORS, 'official');
		expect((await getLadderForDate(settled, THURSDAY)).anchors).toEqual({
			nifty: null,
			banknifty: null,
			sensex: null
		});
	});

	it('yields options for the anchored indices only, and never throws', async () => {
		const store = new MemoryStore();
		await seedCloses(store, WEDNESDAY, { nifty: 25_000 }); // banknifty + sensex dark
		const ladder = await getLadderForDate(store, THURSDAY);

		expect(ladder.anchors).toEqual({ nifty: 25_000, banknifty: null, sensex: null });
		expect(ladder.options).toHaveLength(30);
		expect(ladder.options.every((o) => o.underlying === 'nifty')).toBe(true);
	});

	it('ignores a nonsense (zero) close rather than anchoring a ladder at zero', async () => {
		const store = new MemoryStore();
		await seedCloses(store, WEDNESDAY, { nifty: 0, banknifty: 56_000 });
		const ladder = await getLadderForDate(store, THURSDAY);
		expect(ladder.anchors.nifty).toBeNull();
		expect(ladder.anchors.banknifty).toBe(56_000);
	});

	it('clamps a small anchor: the ±400 banknifty step is dropped, the rest survive', async () => {
		const store = new MemoryStore();
		await seedCloses(store, WEDNESDAY, { banknifty: 10_000 }); // ±3% = 300pts
		const ladder = await getLadderForDate(store, THURSDAY);

		expect(ladder.anchors.banknifty).toBe(10_000);
		const banknifty = ladder.options.filter((o) => o.underlying === 'banknifty');
		// CE strikes first (10,100/10,200/10,300), then the PE mirrors below 10,000.
		expect(banknifty.map((o) => [o.targetKind, o.deltaPoints])).toEqual([
			['up', 100],
			['up', 200],
			['up', 300],
			['down', 100],
			['down', 200],
			['down', 300]
		]);
		expect(banknifty.filter((o) => o.deltaPoints === 400)).toHaveLength(0);
	});

	it('caches per process for the day until invalidateLadderCache()', async () => {
		const store = await ladderStore(THURSDAY, WEDNESDAY);
		const first = await getLadderForDate(store, THURSDAY);

		// The anchor moves behind the service's back (a late official close lands).
		await seedCloses(store, WEDNESDAY, { nifty: 30_000 }, 'official');
		expect(await getLadderForDate(store, THURSDAY)).toBe(first); // stale by design

		invalidateLadderCache();
		const second = await getLadderForDate(store, THURSDAY);
		expect(second).not.toBe(first);
		expect(second.anchors.nifty).toBe(30_000);
		expect(second.options.filter((o) => o.underlying === 'nifty')).toHaveLength(36);
		expect(second.generatedAt).toBeGreaterThanOrEqual(first.generatedAt);
	});

	it('stays healthy when many trade days flow through the cache', async () => {
		const store = await ladderStore(THURSDAY, WEDNESDAY);
		for (let day = 10; day < 20; day += 1) {
			await getLadderForDate(store, `2026-09-${String(day).padStart(2, '0')}`);
		}
		expect((await getLadderForDate(store, THURSDAY)).options).toHaveLength(94);
	});
});

describe('resolveLadderOption', () => {
	it('round-trips every generated option to exactly its configured odds', async () => {
		const store = await ladderStore(THURSDAY, WEDNESDAY);
		const { options } = await getLadderForDate(store, THURSDAY);

		expect(options).toHaveLength(94);
		for (const option of options) {
			const resolved = await resolveLadderOption(
				THURSDAY,
				option.underlying,
				option.targetKind,
				option.deltaPoints,
				store
			);
			expect(resolved, `${option.underlying} ${option.targetKind} ${option.deltaPoints}`).toEqual(
				option
			);
			expect(resolved?.odds).toBe(MAX_HIT_ODDS);
		}
	});

	it('rejects a pick that is not on today’s ladder', async () => {
		const store = await ladderStore(THURSDAY, WEDNESDAY);

		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 30, store)).toBeNull(); // not a spacing multiple
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 800, store)).toBeNull(); // beyond the ±3% band
		// Off the 82,000 anchor the sensex CE distances run 200/350/500 … — 450 is
		// not a strike distance (the strikes are round 150-multiples, the anchor is not).
		expect(await resolveLadderOption(THURSDAY, 'sensex', 'up', 450, store)).toBeNull();
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', -50, store)).toBeNull(); // sign is targetKind's job
		expect(
			await resolveLadderOption(THURSDAY, 'nifty', 'sideways' as LadderTargetKind, 50, store)
		).toBeNull();
	});

	it('rejects everything once the ladder is empty (no anchors)', async () => {
		const store = new MemoryStore();
		expect(await resolveLadderOption(THURSDAY, 'nifty', 'up', 50, store)).toBeNull();
	});
});
