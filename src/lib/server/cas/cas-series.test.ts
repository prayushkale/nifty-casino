import { describe, expect, it } from 'vitest';
import { MAX_CAS_TICKS, appendCasTicks, istDateForTick, type CasTick } from './cas-series';
import { RING_BUFFER_CAP } from '$lib/config/app';

describe('appendCasTicks', () => {
	it('appends new ticks and dedupes by exact timestamp (first wins)', () => {
		const base = [{ ts: 1000, value: 24624.75 }];
		const out = appendCasTicks(base, [
			{ ts: 1000, value: 24624.8 },
			{ ts: 5000, value: 24625.0 }
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ ts: 1000, value: 24624.75 });
		expect(out[1]).toEqual({ ts: 5000, value: 24625.0 });
	});

	it('does not mutate the existing series', () => {
		const base: CasTick[] = [{ ts: 1000, value: 1 }];
		appendCasTicks(base, [{ ts: 2000, value: 2 }]);
		expect(base).toHaveLength(1);
	});

	it('drops ticks older than or equal to the newest retained tick (stale poll guard)', () => {
		const out = appendCasTicks(
			[{ ts: 5000, value: 1 }],
			[
				{ ts: 4000, value: 2 },
				{ ts: 5000, value: 3 }
			]
		);
		expect(out).toHaveLength(1);
		expect(out[0].value).toBe(1);
	});

	it('keeps the guard after appends: a later batch cannot rewind the series', () => {
		let ticks = appendCasTicks(
			[],
			[
				{ ts: 1000, value: 1 },
				{ ts: 5000, value: 2 }
			]
		);
		ticks = appendCasTicks(ticks, [
			{ ts: 3000, value: 9 },
			{ ts: 9000, value: 3 }
		]);
		expect(ticks.map((t) => t.ts)).toEqual([1000, 5000, 9000]);
	});

	it('drops non-positive values (indicative close is 0 outside the window)', () => {
		const out = appendCasTicks(
			[],
			[
				{ ts: 1000, value: 0 },
				{ ts: 2000, value: -1 },
				{ ts: 3000, value: 24624.75 }
			]
		);
		expect(out).toHaveLength(1);
		expect(out[0].value).toBe(24624.75);
	});

	it(`caps the series length at ${MAX_CAS_TICKS}, trimming from the front`, () => {
		let ticks: CasTick[] = [];
		for (let i = 0; i < 800; i++) ticks = appendCasTicks(ticks, [{ ts: i * 4000, value: i }]);
		expect(ticks).toHaveLength(MAX_CAS_TICKS);
		expect(ticks[0].ts).toBe((800 - MAX_CAS_TICKS) * 4000);
		expect(ticks[MAX_CAS_TICKS - 1].ts).toBe(799 * 4000);
	});

	it('matches the shared ring-buffer cap from app config (720)', () => {
		expect(MAX_CAS_TICKS).toBe(RING_BUFFER_CAP);
		expect(MAX_CAS_TICKS).toBe(720);
	});
});

describe('istDateForTick', () => {
	it('converts a UTC epoch to the IST date string', () => {
		// 2026-08-06 18:30 UTC = 2026-08-07 00:00 IST (next day)
		expect(istDateForTick(Date.UTC(2026, 7, 6, 18, 30, 0))).toBe('2026-08-07');
		// 2026-08-06 09:30 UTC = 2026-08-06 15:00 IST (same day)
		expect(istDateForTick(Date.UTC(2026, 7, 6, 9, 30, 0))).toBe('2026-08-06');
		// 09:59:59 UTC = 15:29:59 IST — still the same IST day
		expect(istDateForTick(Date.UTC(2026, 7, 6, 9, 59, 59))).toBe('2026-08-06');
		// 18:29:59 UTC = 23:59:59 IST — last instant of the IST day
		expect(istDateForTick(Date.UTC(2026, 7, 6, 18, 29, 59))).toBe('2026-08-06');
	});
});
