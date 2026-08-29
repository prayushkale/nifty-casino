/**
 * The rank ladder, as tables (PLAN §5 T13).
 *
 * A rank title is public identity — it shows on `/u/<handle>` next to a real
 * balance — so the ladder's contract is pinned here exactly: strictly ascending
 * thresholds starting at zero, a promotion landing exactly ON a `minXp`, no next
 * rank at the top, and a progress value that can never leave 0..1 whatever a
 * corrupted payload hands it.
 */
import { describe, expect, it } from 'vitest';
import { RANKS, nextRank, progressToNext, rankFor, rankViewFor, xpToNext } from './ranks';

describe('RANKS — the ladder itself', () => {
	it('has eight rungs with the titles the floor uses', () => {
		expect(RANKS.map((rank) => rank.title)).toEqual([
			'Rookie',
			'Floor Walker',
			'Chip Stack',
			'Card Counter',
			'High Roller',
			'Pit Boss',
			'Whale',
			'Legend'
		]);
	});

	it('starts at zero and ascends strictly', () => {
		expect(RANKS[0].minXp).toBe(0);
		for (let i = 1; i < RANKS.length; i += 1) {
			expect(RANKS[i].minXp).toBeGreaterThan(RANKS[i - 1].minXp);
		}
	});

	it('numbers the levels 1..8 so `rankFor` can index straight to the next rung', () => {
		RANKS.forEach((rank, index) => expect(rank.level).toBe(index + 1));
	});

	it('gives every rung a non-empty title and tagline (they are rendered verbatim)', () => {
		for (const rank of RANKS) {
			expect(rank.title.trim().length).toBeGreaterThan(0);
			expect(rank.tagline.trim().length).toBeGreaterThan(0);
		}
	});

	it('is shaped by the economy: 10 XP a bet, 100 a hit, three bets a day', () => {
		// One full session of three calls with no hit must promote a player.
		expect(rankFor(30).level).toBe(2);
		// A single hit-day (three bets + one hit) does not skip a whole rung.
		expect(rankFor(130).level).toBe(2);
		// Legend is a months-scale grind even for a strong ~200 XP/day player.
		expect(rankFor(20_000 - 1).level).toBe(7);
		expect(rankFor(20_000).level).toBe(8);
	});
});

describe('rankFor — boundaries land exactly on minXp', () => {
	const cases: [number, number, string][] = RANKS.flatMap((rank) => [
		[rank.minXp, rank.level, rank.title],
		[rank.minXp + 1, rank.level, rank.title],
		[rank.minXp - 1, Math.max(1, rank.level - 1), RANKS[Math.max(0, rank.level - 2)].title]
	]);

	it.each(cases)('xp %i → L%i %s', (xp, level, title) => {
		const rank = rankFor(xp);
		expect(rank.level).toBe(level);
		expect(rank.title).toBe(title);
	});

	it('clamps junk instead of returning undefined', () => {
		for (const junk of [-1, -10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
			const rank = rankFor(junk);
			expect(rank.level).toBe(junk === Number.POSITIVE_INFINITY ? RANKS.length : 1);
			expect(rank.title).toBe(junk === Number.POSITIVE_INFINITY ? 'Legend' : 'Rookie');
		}
	});
});

describe('nextRank — null at the top', () => {
	it('walks the ladder one rung at a time', () => {
		expect(nextRank(0)?.title).toBe('Floor Walker');
		expect(nextRank(29)?.title).toBe('Floor Walker');
		expect(nextRank(30)?.title).toBe('Chip Stack');
		expect(nextRank(19_999)?.title).toBe('Legend');
	});

	it('is null for a Legend, and stays null forever after', () => {
		expect(nextRank(20_000)).toBeNull();
		expect(nextRank(1_000_000)).toBeNull();
	});
});

describe('progressToNext — clamped to 0..1', () => {
	it('is 0 on a threshold and 0 just below the next one', () => {
		expect(progressToNext(0)).toBe(0);
		expect(progressToNext(30)).toBe(0);
		expect(progressToNext(150)).toBe(0);
	});

	it('is 1 exactly one XP before the promotion', () => {
		expect(progressToNext(29)).toBeCloseTo(29 / 30, 10);
		expect(progressToNext(149)).toBeCloseTo(119 / 120, 10);
	});

	it('is halfway through the rung at the midpoint', () => {
		expect(progressToNext(90)).toBeCloseTo(0.5, 10); // 30..150
	});

	it('reads full for a Legend, who has no next rung', () => {
		expect(progressToNext(20_000)).toBe(1);
		expect(progressToNext(500_000)).toBe(1);
	});

	it('never leaves the unit interval, even for junk input', () => {
		for (const xp of [-100, Number.NaN, Number.POSITIVE_INFINITY, 12_345_678]) {
			const p = progressToNext(xp);
			expect(p).toBeGreaterThanOrEqual(0);
			expect(p).toBeLessThanOrEqual(1);
			expect(Number.isFinite(p)).toBe(true);
		}
	});
});

describe('xpToNext', () => {
	it('counts down to the next title', () => {
		expect(xpToNext(0)).toBe(30);
		expect(xpToNext(29)).toBe(1);
		expect(xpToNext(30)).toBe(120);
	});

	it('is null at the top', () => {
		expect(xpToNext(20_000)).toBeNull();
	});

	it('never reports a negative gap, even for junk XP below zero', () => {
		// -5 clamps to the bottom rung, so the gap is 30 - (-5): still positive.
		expect(xpToNext(-5)).toBe(35);
	});
});

describe('rankViewFor — the compact payload projection', () => {
	it('carries the title without the threshold (nothing a client needs)', () => {
		expect(rankViewFor(0)).toEqual({
			level: 1,
			title: 'Rookie',
			tagline: 'First chips on the felt.'
		});
		expect(rankViewFor(1_500)).toEqual({
			level: 5,
			title: 'High Roller',
			tagline: 'Treats the stake limit as a suggestion.'
		});
	});

	it('never carries minXp, so a payload cannot leak the tuning table', () => {
		expect(Object.keys(rankViewFor(4_000)).sort()).toEqual(['level', 'tagline', 'title']);
	});
});
