/**
 * The settlement reveal's pure half (PLAN §5 T13).
 *
 * The browser half — confetti, `sessionStorage`, the toast store — is injected or
 * guarded and never under test here. What is under test is the logic that decides
 * WHETHER a player is told: the unsettled→settled diff, the once-per-browser
 * guard, the copy, and the id-set cap.
 */
import { describe, expect, it } from 'vitest';
import type { StateBet } from '$lib/server/state';
import type { StorageLike } from '$lib/stores/casStream';
import {
	SEEN_REVEALS_CAP,
	SS_SEEN_REVEALS_KEY,
	capSeen,
	filterUnseen,
	newlySettled,
	readSeenReveals,
	revealCopy,
	toReveal,
	writeSeenReveals,
	type Reveal
} from './reveal';

/** A minimal bet row — only what the diff and the copy read. */
let seq = 0;
const bet = (overrides: Partial<StateBet> = {}): StateBet => ({
	id: `bet-${(seq += 1)}`,
	underlying: 'nifty',
	targetKind: 'up',
	deltaPoints: 50,
	odds: 6,
	stake: 100,
	settlementTier: null,
	payout: null,
	createdAt: 0,
	...overrides
});

/** An in-memory stand-in for sessionStorage, so the guard is tested without a browser. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike & { dump(): string } {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		dump: () => map.get(SS_SEEN_REVEALS_KEY) ?? ''
	};
}

describe('newlySettled — the unsettled → settled diff', () => {
	it('announces nothing on the first payload, however many results it carries', () => {
		const settled = [bet({ settlementTier: 'hit', payout: 600 })];
		expect(newlySettled(null, settled)).toEqual([]);
	});

	it('announces a bet that was open and is now decided', () => {
		const open = bet({ id: 'a' });
		const nowSettled = bet({ id: 'a', settlementTier: 'hit', payout: 600 });
		expect(newlySettled([open], [nowSettled])).toEqual([nowSettled]);
	});

	it('stays quiet about a bet that was already decided', () => {
		const settled = bet({ id: 'a', settlementTier: 'miss', payout: 0 });
		expect(newlySettled([settled], [settled])).toEqual([]);
	});

	it('announces every tier the engine can write', () => {
		const before = [bet({ id: 'a' }), bet({ id: 'b' }), bet({ id: 'c' })];
		const after = [
			bet({ id: 'a', settlementTier: 'hit', payout: 600 }),
			bet({ id: 'b', settlementTier: 'flat', payout: 100 }),
			bet({ id: 'c', settlementTier: 'miss', payout: 0 })
		];
		expect(newlySettled(before, after)).toHaveLength(3);
	});

	it('ignores bets that appeared already settled between two payloads', () => {
		// A bet cancelled and re-placed inside one refresh cycle is NEW, not a reveal.
		const before = [bet({ id: 'a' })];
		const after = [bet({ id: 'b', settlementTier: 'hit', payout: 60 })];
		expect(newlySettled(before, after)).toEqual([]);
	});

	it('keeps quiet bets quiet and carries the whole object through', () => {
		const open = bet({ id: 'a', stake: 250, underlying: 'sensex' });
		const stillOpen = bet({ id: 'b' });
		const decided = bet({
			id: 'a',
			stake: 250,
			underlying: 'sensex',
			settlementTier: 'flat',
			payout: 250
		});
		const result = newlySettled([open, stillOpen], [stillOpen, decided]);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(decided);
		expect(result[0].stake).toBe(250);
	});
});

describe('the once-per-browser guard', () => {
	it('filters out ids the browser has already announced', () => {
		const seen = new Set(['a']);
		const transitions = [
			bet({ id: 'a', settlementTier: 'hit' }),
			bet({ id: 'b', settlementTier: 'miss' })
		];
		expect(filterUnseen(transitions, seen).map((item) => item.id)).toEqual(['b']);
	});

	it('reads the persisted set back, tolerating junk', () => {
		expect(readSeenReveals(null)).toEqual(new Set());
		expect(readSeenReveals(fakeStorage())).toEqual(new Set());
		expect(readSeenReveals(fakeStorage({ [SS_SEEN_REVEALS_KEY]: 'not json' }))).toEqual(new Set());
		expect(readSeenReveals(fakeStorage({ [SS_SEEN_REVEALS_KEY]: '{"obj":1}' }))).toEqual(new Set());
		expect(
			readSeenReveals(fakeStorage({ [SS_SEEN_REVEALS_KEY]: JSON.stringify(['a', 7, null, 'b']) }))
		).toEqual(new Set(['a', 'b']));
	});

	it('writes the set and reads back exactly what was written', () => {
		const storage = fakeStorage();
		writeSeenReveals(storage, new Set(['a', 'b']));
		expect(readSeenReveals(storage)).toEqual(new Set(['a', 'b']));
	});

	it('survives a storage that throws (private mode) — the reveal still happens', () => {
		const hostile: StorageLike = {
			getItem: () => null,
			setItem: () => {
				throw new Error('quota');
			}
		};
		expect(() => writeSeenReveals(hostile, new Set(['a']))).not.toThrow();
	});

	it('caps the persisted set so a year of play cannot bloat sessionStorage', () => {
		const ids = Array.from({ length: SEEN_REVEALS_CAP + 50 }, (_, i) => `id-${i}`);
		const capped = capSeen(new Set(ids));
		expect(capped).toHaveLength(SEEN_REVEALS_CAP);
		// The OLDEST fall off, so a long-lived id that somehow returns still fires.
		expect(capped[0]).toBe(`id-${ids.length - SEEN_REVEALS_CAP}`);
		expect(capped.at(-1)).toBe(`id-${ids.length - 1}`);
	});
});

describe('revealCopy — the three verdicts', () => {
	const reveal = (over: Partial<Reveal>): Reveal => ({
		id: 'x',
		underlying: 'nifty',
		tier: 'hit',
		payout: 600,
		stake: 100,
		...over
	});

	it('celebrates a hit in gold, quoting the NC credited', () => {
		expect(revealCopy(reveal({ tier: 'hit' }))).toEqual({
			kind: 'ok',
			message: 'NIFTY 🎯 HIT +600 NC'
		});
	});

	it('reports a flat as a refund, not a win', () => {
		expect(revealCopy(reveal({ tier: 'flat', payout: 100 }))).toEqual({
			kind: 'info',
			message: 'NIFTY ➖ Flat — 100 NC refunded'
		});
	});

	it('reports a miss as a total loss', () => {
		expect(revealCopy(reveal({ tier: 'miss', payout: 0 }))).toEqual({
			kind: 'err',
			message: 'NIFTY 💀 Miss — 100 NC gone'
		});
	});

	it('uses the short index label, so a toast stays one line on a phone', () => {
		expect(revealCopy(reveal({ underlying: 'banknifty' })).message.startsWith('BKNT')).toBe(true);
	});
});

describe('toReveal', () => {
	it('projects the fields the announce path needs', () => {
		const row = bet({ settlementTier: 'hit', payout: 600, stake: 100 });
		expect(toReveal(row)).toEqual({
			id: row.id,
			underlying: 'nifty',
			tier: 'hit',
			payout: 600,
			stake: 100
		});
	});

	it('reads a missing payout as 0 and an unknown tier as a miss', () => {
		const row = bet({ settlementTier: null, payout: null });
		expect(toReveal(row).payout).toBe(0);
		expect(toReveal(row).tier).toBe('miss');
	});
});
