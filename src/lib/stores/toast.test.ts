/**
 * The toast reducer, as tables (PLAN §5 T13).
 *
 * Only the pure half is under test here — the store wrapper adds a clock and a
 * `setTimeout`, neither of which belongs in a unit test. The rules that matter
 * are the two the reducer enforces: a duplicate message never stacks (the settle
 * poll toasts the same failure every 30s on a dead network), and no more than
 * three cards are ever visible.
 */
import { describe, expect, it } from 'vitest';
import { MAX_TOASTS, appendToast, dropToast, sweepExpired, type Toast } from './toast';

/** A factory so each case starts from a known, unique-id list. */
let seq = 0;
const make = (message: string, kind: Toast['kind'] = 'info', expiresAt = 10_000): Toast => ({
	id: (seq += 1),
	kind,
	message,
	expiresAt
});

/** The reducer's input shape, taken from a toast — expiry defaults to its own. */
const inputOf = (toast: Toast, expiresAt: number = toast.expiresAt) => ({
	id: toast.id,
	kind: toast.kind,
	message: toast.message,
	expiresAt
});

describe('appendToast', () => {
	it('prepends the new toast, so the newest is what the eye lands on first', () => {
		const first = make('one');
		const second = make('two');
		const state = appendToast([first], inputOf(second));
		expect(state.map((item) => item.message)).toEqual(['two', 'one']);
	});

	it('drops a message that is already on screen, whatever its kind', () => {
		const existing = make('Bet placed — good luck.', 'ok');
		const duplicate = make('Bet placed — good luck.', 'err');
		const state = appendToast([existing], inputOf(duplicate));
		expect(state).toHaveLength(1);
		expect(state[0].id).toBe(existing.id);
	});

	it('returns the same reference when it dedupes, so the store can skip a notify', () => {
		const state = [make('same')];
		expect(appendToast(state, inputOf(make('same')))).toBe(state);
	});

	it('caps the stack at three, evicting the oldest first', () => {
		let state: Toast[] = [];
		for (const message of ['a', 'b', 'c', 'd', 'e']) {
			state = appendToast(state, inputOf(make(message)));
		}
		expect(state).toHaveLength(MAX_TOASTS);
		expect(state.map((item) => item.message)).toEqual(['e', 'd', 'c']);
	});

	it('keeps exactly three when pushing onto a full stack', () => {
		// Newest-first, as the reducer itself leaves the list.
		const full = [make('new'), make('middle'), make('old')];
		const next = appendToast(full, inputOf(make('newest')));
		expect(next).toHaveLength(3);
		expect(next.at(-1)?.message).toBe('middle');
		expect(next.some((item) => item.message === 'old')).toBe(false);
	});
});

describe('dropToast', () => {
	it('removes exactly the id asked for', () => {
		const a = make('a');
		const b = make('b');
		const state = appendToast(appendToast([], inputOf(a)), inputOf(b));
		const next = dropToast(state, a.id);
		expect(next.map((item) => item.id)).toEqual([b.id]);
	});

	it('is a no-op for an unknown id, and returns the same reference', () => {
		const state = [make('a')];
		expect(dropToast(state, 99_999)).toBe(state);
	});
});

describe('sweepExpired', () => {
	it('drops only what has expired, keeping toasts that still have time', () => {
		const live = make('live', 'ok', 10_000);
		const dead = make('dead', 'err', 9_000);
		const state = appendToast(appendToast([], inputOf(live)), inputOf(dead));
		const next = sweepExpired(state, 9_500);
		expect(next.map((item) => item.message)).toEqual(['live']);
	});

	it('drops a toast at the exact instant it expires', () => {
		const edge = make('edge', 'info', 10_000);
		expect(sweepExpired([edge], 9_999)).toHaveLength(1);
		expect(sweepExpired([edge], 10_000)).toHaveLength(0);
	});

	it('returns the same reference when nothing expired', () => {
		const state = [make('a', 'info', 10_000)];
		expect(sweepExpired(state, 5_000)).toBe(state);
	});

	it('is stable against an empty list', () => {
		expect(sweepExpired([], Date.now())).toEqual([]);
	});
});
