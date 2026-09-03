import { describe, expect, it } from 'vitest';
import { buildCrowdDistribution, crowdLeader, crowdTotal, type CrowdBet } from './crowd';

const bet = (underlying: string, targetKind: 'up' | 'down', deltaPoints: number): CrowdBet => ({
	underlying,
	targetKind,
	deltaPoints
});

describe('buildCrowdDistribution', () => {
	it('returns an empty record for an empty day', () => {
		expect(buildCrowdDistribution([])).toEqual({});
	});

	it('counts bets per strike and computes shares', () => {
		const bets = [
			bet('nifty', 'up', 50),
			bet('nifty', 'up', 50),
			bet('nifty', 'down', 100),
			bet('nifty', 'up', 150)
		];
		const dist = buildCrowdDistribution(bets);
		expect(dist.nifty).toEqual([
			{ targetKind: 'up', deltaPoints: 50, count: 2, pct: 50 },
			{ targetKind: 'down', deltaPoints: 100, count: 1, pct: 25 },
			{ targetKind: 'up', deltaPoints: 150, count: 1, pct: 25 }
		]);
	});

	it('keeps indexes separate — a nifty strike never picks up banknifty bets', () => {
		const dist = buildCrowdDistribution([bet('nifty', 'up', 50), bet('banknifty', 'up', 50)]);
		expect(Object.keys(dist).sort()).toEqual(['banknifty', 'nifty']);
		expect(dist.nifty[0].count).toBe(1);
		expect(dist.banknifty[0].count).toBe(1);
	});

	it('sorts biggest count first, deterministically breaking ties', () => {
		const dist = buildCrowdDistribution([
			bet('nifty', 'down', 100),
			bet('nifty', 'up', 50),
			bet('nifty', 'up', 150)
		]);
		// All count 1: ties break alphabetically by direction, then by distance.
		expect(dist.nifty.map((p) => [p.targetKind, p.deltaPoints])).toEqual([
			['down', 100],
			['up', 50],
			['up', 150]
		]);
	});

	it('rounds percentages to 1 decimal place', () => {
		const bets = [bet('sensex', 'up', 150), bet('sensex', 'up', 150), bet('sensex', 'down', 300)];
		const dist = buildCrowdDistribution(bets);
		// 1/3 → 33.3, 2/3 → 66.7.
		expect(dist.sensex.map((p) => p.pct)).toEqual([66.7, 33.3]);
	});

	it('skips a bet with a malformed direction instead of crashing', () => {
		const bets = [
			bet('nifty', 'up', 50),
			{ underlying: 'nifty', targetKind: 'sideways' as 'up', deltaPoints: 0 }
		];
		const dist = buildCrowdDistribution(bets);
		expect(dist.nifty).toHaveLength(1);
		expect(dist.nifty[0].count).toBe(1);
	});

	it('drops an index with only malformed bets', () => {
		const dist = buildCrowdDistribution([
			{ underlying: 'nifty', targetKind: 'x' as 'up', deltaPoints: 0 }
		]);
		expect(dist).toEqual({});
	});
});

describe('crowdTotal / crowdLeader', () => {
	it('sums counts and reports 0 for an absent index', () => {
		const dist = buildCrowdDistribution([bet('nifty', 'up', 50), bet('nifty', 'up', 100)]);
		expect(crowdTotal(dist, 'nifty')).toBe(2);
		expect(crowdTotal(dist, 'sensex')).toBe(0);
	});

	it('names the biggest pick and null for no bets', () => {
		const dist = buildCrowdDistribution([
			bet('nifty', 'down', 100),
			bet('nifty', 'up', 50),
			bet('nifty', 'up', 50)
		]);
		expect(crowdLeader(dist.nifty)).toEqual({
			targetKind: 'up',
			deltaPoints: 50,
			count: 2,
			pct: 66.7
		});
		expect(crowdLeader(undefined)).toBeNull();
		expect(crowdLeader([])).toBeNull();
	});
});
