/**
 * Toasts (PLAN §5 T13): the small confirmations a casino floor gives you.
 *
 * Split the same way every other client module in this app is:
 *
 *  1. A PURE REDUCER — `appendToast` / `dropToast` / `sweepExpired` take a list
 *     and return a list. `./toast.test.ts` pins the cap, the dedupe and the
 *     expiry against plain arrays with no timers and no Svelte.
 *  2. THE STORE — `toast()` pushes, `dismissToast()` pops, one `setTimeout` per
 *     toast re-sweeps. Every id and every "now" is generated here and handed to
 *     the reducer as an argument, which is what keeps the reducer pure.
 *
 * Why a hand-rolled store rather than `svelte/motion` or a component-local array:
 * it is pushed from four different modules (`game.ts` bet actions, `game.ts`
 * state errors, the settlement reveal watcher), so it must be a singleton — and
 * a singleton means its list must be capped and deduped in one place, or a
 * flaky network during the settle poll stacks three identical "could not reach
 * the casino" cards on top of each other.
 *
 * SSR: `toast()` is a no-op off the browser, exactly like `seedState`'s guard.
 * On the server this module is one instance shared by every concurrent request,
 * and a toast pushed during SSR would be a cross-request leak.
 */
import { writable } from 'svelte/store';

export type ToastKind = 'ok' | 'err' | 'info';

export type Toast = {
	/** Monotonic per page load — the `#each` key and the dismiss target. */
	id: number;
	kind: ToastKind;
	message: string;
	/** Epoch ms after which the sweep drops it. */
	expiresAt: number;
};

/** Visible at once. A fourth toast pushes the oldest out — this is a floor, not a log. */
export const MAX_TOASTS = 3;

/** How long a success or an announcement stays. */
export const DEFAULT_TTL_MS = 4200;

/** Failures stay a little longer: they are the ones a player has to read. */
export const ERROR_TTL_MS = 6500;

// ---------------------------------------------------------------------------
// the pure reducer
// ---------------------------------------------------------------------------

export type ToastInput = {
	id: number;
	kind: ToastKind;
	message: string;
	/** Absolute expiry epoch ms. */
	expiresAt: number;
};

/**
 * Append one toast to the front of the list, and enforce both house rules:
 *
 *  • DEDUPE — a message that is already on screen is dropped rather than
 *    stacked. This is what makes it safe for `loadState` to toast every failure
 *    while a 30s settle poll runs against a dead network.
 *  • CAP — at most {@link MAX_TOASTS} visible; the oldest leaves first.
 *
 * Returns the SAME array reference when nothing changed, so a Svelte store can
 * skip the notify entirely.
 */
export function appendToast(state: readonly Toast[], input: ToastInput): Toast[] {
	if (state.some((existing) => existing.message === input.message)) return state as Toast[];
	const next = [input as Toast, ...state].slice(0, MAX_TOASTS);
	return next;
}

/** Remove one toast by id. An unknown id is a no-op, not an error. */
export function dropToast(state: readonly Toast[], id: number): Toast[] {
	const next = state.filter((item) => item.id !== id);
	return next.length === state.length ? (state as Toast[]) : next;
}

/** Drop everything whose expiry has passed. */
export function sweepExpired(state: readonly Toast[], now: number): Toast[] {
	const next = state.filter((item) => item.expiresAt > now);
	return next.length === state.length ? (state as Toast[]) : next;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export const toasts = writable<Toast[]>([]);

let sequence = 0;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

export type ToastOptions = {
	kind?: ToastKind;
	ttlMs?: number;
};

/**
 * Show a toast and return its id (`null` when it was suppressed — off the
 * browser, or identical to a toast already on screen).
 */
export function toast(message: string, options: ToastOptions = {}): number | null {
	if (typeof window === 'undefined') return null;

	const kind = options.kind ?? 'info';
	const ttlMs = options.ttlMs ?? (kind === 'err' ? ERROR_TTL_MS : DEFAULT_TTL_MS);
	sequence += 1;
	const input: ToastInput = {
		id: sequence,
		kind,
		message,
		expiresAt: Date.now() + Math.max(0, ttlMs)
	};

	toasts.update((state) => appendToast(state, input));
	scheduleSweep(ttlMs + 25);
	return input.id;
}

/** Remove a toast now (the click on it). */
export function dismissToast(id: number): void {
	toasts.update((state) => dropToast(state, id));
}

/** Clear the stack — used on logout-style transitions, and by tests. */
export function clearToasts(): void {
	if (sweepTimer !== null) {
		clearTimeout(sweepTimer);
		sweepTimer = null;
	}
	toasts.set([]);
}

/** One timer per push; each re-sweeps the whole list, so no per-toast bookkeeping. */
function scheduleSweep(delayMs: number): void {
	if (sweepTimer !== null) clearTimeout(sweepTimer);
	sweepTimer = setTimeout(() => {
		sweepTimer = null;
		toasts.update((state) => sweepExpired(state, Date.now()));
	}, delayMs);
}
