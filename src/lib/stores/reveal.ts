/**
 * The settlement reveal (PLAN §5 T13): the moment a bet stops being a promise and
 * becomes a result.
 *
 * ── Where this hook lives, and why ───────────────────────────────────────────
 *
 * The trigger is a SUBSCRIPTION to `gameState` started from the game page's
 * `onMount`, not a call wired into `loadState()` or into the settle poll. Two
 * reasons:
 *
 *  1. `loadState` is called from five places (cold mount, post-bet refresh, the
 *     30s settle poll, the visibility resync, the layout's chrome read) and every
 *     one of them must be able to surface a verdict. Diffing in the store's
 *     subscriber covers all five without each caller remembering to.
 *  2. The reveal is a *transition* (unsettled → settled), and a transition needs
 *     a "before". Keeping that "before" in this module — rather than as a local
 *     in `+page.svelte` — means a client-side navigation away and back cannot
 *     reset it into re-announcing yesterday's results.
 *
 * The page mounts it because the page is the only surface that renders results,
 * and because starting a subscription inside a module import would be a side
 * effect SSR could not opt out of.
 *
 * ── The rules ────────────────────────────────────────────────────────────────
 *
 *  • A bet announces itself ONCE per browser: the ids already settled when this
 *    module starts looking, and everything it has ever announced, live in a Set
 *    mirrored into `sessionStorage`. That is the guard that stops a refresh
 *    during the settle window from firing the confetti again — the first payload
 *    a refreshed page sees already carries the verdict, so the id is marked seen
 *    before any diff can run.
 *  • 🎯 HIT bursts confetti (once, however many legs hit) plus a gold toast.
 *    ➖ FLAT and 💀 MISS get only a toast — a refund and a loss are information,
 *    not a celebration.
 *  • `prefers-reduced-motion: reduce` skips the confetti entirely (and the
 *    library's own `disableForReducedMotion` guards the race in between).
 *
 * The pure half — the diff, the seen-set and the copy — is exported for
 * `./reveal.test.ts`; the browser half (confetti, storage) is injected or
 * guarded, never stubbed globally.
 */
import type { Readable } from 'svelte/store';
import type { StorageLike } from '$lib/stores/casStream';
import type { StateBet, StatePayload } from '$lib/server/state';
import { gameState, formatNC, INDEX_SHORT } from '$lib/stores/game';
import { toast } from '$lib/stores/toast';
import { prefersReducedMotion } from '$lib/game/tween';

/** One bet worth announcing: it is settled now and was not, the last time we looked. */
export type Reveal = {
	id: string;
	underlying: StateBet['underlying'];
	tier: 'hit' | 'flat' | 'miss';
	/** NC credited by the settlement (stake back on a flat, stake × odds on a hit). */
	payout: number;
	stake: number;
};

/** sessionStorage key. Per tab, per browsing session — a new tab may celebrate again. */
export const SS_SEEN_REVEALS_KEY = 'nc_reveals_seen';

/** Bound on the persisted id set. Three bets a day means 200 days of history. */
export const SEEN_REVEALS_CAP = 200;

// ---------------------------------------------------------------------------
// the pure half
// ---------------------------------------------------------------------------

/**
 * Bets that settled between `prev` and `next`.
 *
 * `prev === null` means "this is the first payload I have ever seen", and a first
 * payload can never reveal anything: a page that loads after the settle job has
 * run is looking at *old* news, not a result. That is the whole reason the diff
 * takes the previous list instead of trusting `settlementTier !== null`.
 *
 * Generic over the bet shape so the caller's objects pass through intact — the
 * announce path needs `payout`/`stake`/`underlying`, not just the id.
 */
export function newlySettled<Bet extends { id: string; settlementTier: string | null }>(
	prev: readonly Bet[] | null,
	next: readonly Bet[]
): Bet[] {
	if (prev === null) return [];
	const wasOpen = new Set(prev.filter((bet) => bet.settlementTier === null).map((bet) => bet.id));
	return next.filter((bet) => bet.settlementTier !== null && wasOpen.has(bet.id));
}

/** Read the seen-id set, tolerating a missing storage and any junk inside it. */
export function readSeenReveals(storage: StorageLike | null): Set<string> {
	if (!storage) return new Set();
	try {
		const raw = storage.getItem(SS_SEEN_REVEALS_KEY);
		if (!raw) return new Set();
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((id): id is string => typeof id === 'string'));
	} catch {
		return new Set();
	}
}

/** Persist the seen set. Failures are swallowed: the worst case is one repeat burst. */
export function writeSeenReveals(storage: StorageLike | null, seen: ReadonlySet<string>): void {
	if (!storage) return;
	try {
		storage.setItem(SS_SEEN_REVEALS_KEY, JSON.stringify(capSeen(seen)));
	} catch {
		/* private mode, quota, whatever — the reveal still happened */
	}
}

/** The newest {@link SEEN_REVEALS_CAP} ids, as a JSON-ready array. */
export function capSeen(seen: ReadonlySet<string>): string[] {
	const all = [...seen];
	return all.length > SEEN_REVEALS_CAP ? all.slice(all.length - SEEN_REVEALS_CAP) : all;
}

/** Split a batch of transitions into the ones this browser has never announced. */
export function filterUnseen<Bet extends { id: string }>(
	bets: readonly Bet[],
	seen: ReadonlySet<string>
): Bet[] {
	return bets.filter((bet) => !seen.has(bet.id));
}

/** Project a raw bet onto the small shape the announce path needs. */
export function toReveal(bet: StateBet): Reveal {
	return {
		id: bet.id,
		underlying: bet.underlying,
		tier:
			bet.settlementTier === 'hit' || bet.settlementTier === 'flat' ? bet.settlementTier : 'miss',
		payout: bet.payout ?? 0,
		stake: bet.stake
	};
}

/** The sentence each verdict gets, reusing the strip's emoji vocabulary. */
export function revealCopy(reveal: Reveal): { kind: 'ok' | 'err' | 'info'; message: string } {
	const index = INDEX_SHORT[reveal.underlying];
	if (reveal.tier === 'hit') {
		return { kind: 'ok', message: `${index} 🎯 HIT +${formatNC(reveal.payout)} NC` };
	}
	if (reveal.tier === 'flat') {
		return { kind: 'info', message: `${index} ➖ Flat — ${formatNC(reveal.stake)} NC refunded` };
	}
	return { kind: 'err', message: `${index} 💀 Miss — ${formatNC(reveal.stake)} NC gone` };
}

// ---------------------------------------------------------------------------
// the confetti burst
// ---------------------------------------------------------------------------

/** Casino gold, with the up-green and one white spark so it reads on the felt. */
export const CONFETTI_COLORS = ['#f5c451', '#ffe08a', '#a8842f', '#34d399', '#ffffff'] as const;

/**
 * The gold burst. ~1.2s (`ticks` are frames at ~60fps), a second lighter puff a
 * beat later so a big hit feels like more than one firework.
 *
 * `canvas-confetti` is imported dynamically: it is a browser-only module, this
 * keeps it out of the SSR bundle, and a failure to load must never break a
 * settlement announcement.
 */
export async function burstConfetti(hits = 1): Promise<void> {
	if (typeof window === 'undefined') return;
	if (prefersReducedMotion()) return;

	type ConfettiFn = (options?: ConfettiOptions) => Promise<undefined> | null;
	type ConfettiOptions = {
		particleCount?: number;
		spread?: number;
		startVelocity?: number;
		gravity?: number;
		scalar?: number;
		ticks?: number;
		origin?: { x?: number; y?: number };
		angle?: number;
		zIndex?: number;
		colors?: string[];
		disableForReducedMotion?: boolean;
	};

	// `canvas-confetti` ships `export =` types, so the dynamic import is read
	// through its CJS-interop shape (`{ default: confetti }`) — exactly what Vite
	// hands back in the browser.
	let confetti: ConfettiFn | null = null;
	try {
		const mod = (await import('canvas-confetti')) as unknown as { default?: ConfettiFn };
		confetti = typeof mod?.default === 'function' ? mod.default : null;
	} catch {
		return; // no burst is strictly better than an error toast about a firework
	}
	if (confetti === null) return;

	const scale = Math.min(3, Math.max(1, hits));
	const base: ConfettiOptions = {
		origin: { y: 0.72 },
		// 72 frames ≈ 1.2s at 60fps: long enough to read as a celebration.
		ticks: 72,
		zIndex: 60,
		disableForReducedMotion: true,
		colors: [...CONFETTI_COLORS]
	};

	confetti({
		...base,
		particleCount: 60 + 30 * scale,
		spread: 65 + 15 * scale,
		startVelocity: 40 + 4 * scale,
		gravity: 0.9
	});

	window.setTimeout(() => {
		confetti?.({
			...base,
			particleCount: 18 + 6 * scale,
			spread: 110,
			startVelocity: 26,
			scalar: 0.8,
			colors: [...CONFETTI_COLORS].slice(0, 3)
		});
	}, 180);
}

// ---------------------------------------------------------------------------
// the watcher
// ---------------------------------------------------------------------------

export type RevealWatcherOptions = {
	/** Defaults to `sessionStorage`; pass `null` to run without the guard (tests). */
	storage?: StorageLike | null;
	/** The announce path. Defaults to toasts + confetti; tests inject a collector. */
	fire?: (reveals: Reveal[]) => void;
	/** The payload source. Defaults to `gameState`. */
	source?: Readable<StatePayload | null>;
};

/**
 * Watch `/api/state` payloads for bets crossing unsettled → settled, and announce
 * each one once. Returns the stop function.
 *
 * Starting it marks everything ALREADY settled as seen, so a reload, a late join
 * or a next-morning return never replays old results — only a bet that settles
 * while this tab is watching gets the confetti.
 */
export function startRevealWatcher(options: RevealWatcherOptions = {}): () => void {
	const source = options.source ?? gameState;
	const storage =
		options.storage !== undefined
			? options.storage
			: typeof globalThis.sessionStorage !== 'undefined'
				? globalThis.sessionStorage
				: null;

	const fire =
		options.fire ??
		((reveals: Reveal[]) => {
			const hits = reveals.filter((reveal) => reveal.tier === 'hit').length;
			for (const reveal of reveals) {
				const copy = revealCopy(reveal);
				toast(copy.message, { kind: copy.kind });
			}
			if (hits > 0) void burstConfetti(hits);
		});

	const seen = readSeenReveals(storage);
	/** The `myBets` list as the last payload carried it — the diff's "before". */
	let previous: StateBet[] | null = null;

	const remember = (bets: readonly StateBet[]): void => {
		previous = [...bets];
	};

	const unsubscribe = source.subscribe((payload) => {
		const bets: StateBet[] = payload?.myBets ?? [];

		// First look: everything already decided is history. Recorded so a later
		// payload that still carries it (they all do, once settled) stays quiet.
		if (previous === null) {
			remember(bets);
			const alreadyDecided = bets.filter((bet) => bet.settlementTier !== null);
			for (const bet of alreadyDecided) seen.add(bet.id);
			if (alreadyDecided.length > 0) writeSeenReveals(storage, seen);
			return;
		}

		const transitions = filterUnseen(newlySettled(previous, bets), seen);
		remember(bets);
		if (transitions.length === 0) return;

		for (const bet of transitions) seen.add(bet.id);
		writeSeenReveals(storage, seen);
		fire(transitions.map(toReveal));
	});

	return () => {
		unsubscribe();
	};
}
