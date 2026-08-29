/**
 * Client state for the game page (PLAN §5 T11).
 *
 * Two halves, deliberately separated:
 *
 *  1. PURE HELPERS — phase, countdown, projection, formatting, stake validation.
 *     These are exported for the Vitest table in `./game.test.ts` and take
 *     everything they need as arguments; none of them touches a store, a fetch or
 *     the clock. The phase machine and the payout preview are the two pieces of
 *     client logic a player can actually lose money to, so both are tables.
 *  2. STORES + ACTIONS — one `/api/state` payload as the single source of truth,
 *     a drift-corrected one-second clock, and thin wrappers over the bet routes
 *     that re-read `/api/state` after every mutation.
 *
 * NO OPTIMISTIC WALLET MATH. A stake placed in a browser that the server refused
 * is a lie on screen; a stake the server accepted but the browser guessed wrong is
 * worse. So an action only flips its own button's pending flag, and the numbers
 * (balance, pot, bet list) arrive from the next `/api/state` read — one extra
 * round trip per click, and the server stays the only thing that knows the truth
 * (PLAN §0 "server is source of truth").
 *
 * The `/api/state` *type* is imported type-only from `$lib/server/state`, which is
 * erased before bundling (the same trick `$lib/config/ladder.types.ts` uses for
 * `$lib/server/cas/types`): the contract is written once, on the server, and the
 * browser renders it instead of re-declaring a copy that can drift.
 */
import { get, writable, type Readable, type Writable } from 'svelte/store';
import { BETTING_START_HMS, CUTOFF_HMS, MAX_STAKE, MIN_STAKE } from '$lib/config/app';
import { computeTier, payoutFor, type PayableTier } from '$lib/game/tier';
import type { LadderOption, LadderUnderlying } from '$lib/config/ladder';
import { hmsToSeconds, isWeekend, secOfDayIst, shiftIstDate } from '$lib/time/ist';
import type { StatePayload } from '$lib/server/state';

// ---------------------------------------------------------------------------
// display vocabulary
// ---------------------------------------------------------------------------

/** Full names for the three cards, in the ladder's stable order. */
export const INDEX_LABELS: Readonly<Record<LadderUnderlying, string>> = {
	nifty: 'NIFTY 50',
	banknifty: 'BANKNIFTY',
	sensex: 'SENSEX'
};

/** Compact names for tight spots (the mobile bets strip). */
export const INDEX_SHORT: Readonly<Record<LadderUnderlying, string>> = {
	nifty: 'NIFTY',
	banknifty: 'BKNT',
	sensex: 'SENSEX'
};

// ---------------------------------------------------------------------------
// the phase machine
// ---------------------------------------------------------------------------

/**
 * Where the day is, from the player's chair.
 *
 *   pre             before 15:00 IST      — read-only, "bets open 15:00 IST"
 *   open            15:00:00 → 15:20:00   — the only phase that accepts bets
 *   locked          after the cutoff      — read-only, awaiting the official close
 *   settled         the day is paid out   — read-only, results visible
 *   closed-weekend  Saturday/Sunday IST   — read-only, back next trading day
 */
export type GamePhase = 'pre' | 'open' | 'locked' | 'settled' | 'closed-weekend';

const toMs = (now: number | Date): number => (now instanceof Date ? now.getTime() : now);

/**
 * The phase for a state payload at instant `now`.
 *
 * Precedence is the order the answers can coexist in: `settled` first (a settled
 * day stays settled however late it is), then the weekend (a Saturday morning
 * must say "market closed", not "bets open at 15:00"), then the clock. The
 * boundaries are inclusive exactly where the server's are — 15:00:00.000 opens the
 * window and 15:20:00.000 is STILL open, because the money path accepts a bet
 * while `now <= session.cutoffAt`; a form that locked a tick early would refuse a
 * bet the server would have taken. One millisecond later it is `locked`.
 */
export function bettingPhase(
	state: Pick<StatePayload, 'tradeDate' | 'session'>,
	now: number | Date
): GamePhase {
	if (state.session.settled) return 'settled';
	if (isWeekend(state.tradeDate)) return 'closed-weekend';

	const sec = secOfDayIst(new Date(toMs(now)));
	const startSec = hmsToSeconds(BETTING_START_HMS);
	const cutoffSec = hmsToSeconds(CUTOFF_HMS);
	if (sec < startSec) return 'pre';
	if (sec <= cutoffSec) return 'open';
	return 'locked';
}

// ---------------------------------------------------------------------------
// countdown
// ---------------------------------------------------------------------------

export type Countdown = { h: number; m: number; s: number };

/**
 * Time left until `cutoffAtMs`, in whole hours/minutes/seconds, or `null` once
 * the cutoff has passed (or is unknown) — a countdown that reads 00:00:00 and
 * then keeps going is worse than one that disappears.
 */
export function countdownToCutoff(now: number | Date, cutoffAtMs: number | null): Countdown | null {
	if (cutoffAtMs === null) return null;
	const remainingMs = cutoffAtMs - toMs(now);
	if (remainingMs <= 0) return null;

	const totalSec = Math.floor(remainingMs / 1000);
	return {
		h: Math.floor(totalSec / 3600),
		m: Math.floor((totalSec % 3600) / 60),
		s: totalSec % 60
	};
}

/** '04:31' | '1:04:31' — hours dropped when zero, so the pill stays short on mobile. */
export function formatCountdown(c: Countdown): string {
	const mm = String(c.m).padStart(2, '0');
	const ss = String(c.s).padStart(2, '0');
	return c.h > 0 ? `${c.h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const DAY_NAMES: readonly string[] = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
];

/**
 * The next day the market opens, as a weekday name — what the weekend banner and
 * the countdown pill promise ("market closed — back Monday 15:00"). Skips
 * weekends only: a mid-week holiday is the data layer's business, not something a
 * calendar walk can know.
 */
export function nextTradingDayName(dateStr: string): string {
	for (let ahead = 1; ahead <= 7; ahead += 1) {
		const candidate = shiftIstDate(dateStr, ahead);
		if (isWeekend(candidate)) continue;
		const weekday = new Date(`${candidate}T00:00:00Z`).getUTCDay();
		return DAY_NAMES[weekday] ?? 'the next trading day';
	}
	return 'the next trading day';
}

// ---------------------------------------------------------------------------
// the if-closed-now projection
// ---------------------------------------------------------------------------

export type Projection = { tier: PayableTier; payout: number };

/**
 * What `option` would pay if the index closed at `latestValue` right now.
 *
 * THE SAME ARITHMETIC THE SETTLEMENT ENGINE RUNS (`$lib/game/tier`), fed a
 * hypothetical close instead of the official one — the server settles with the
 * official close, this previews with the live indicative, and nothing else
 * differs. `stake` is quoted separately so the same helper serves both the bet
 * strip (the real stake) and the chip tooltip (1 NC, i.e. the bare multiplier).
 *
 * `null` means "no honest answer yet": no usable anchor, no live value, or an
 * `abstain` verdict — rendered as an em dash, never as a zero.
 */
export function projectedPayout(
	option: Pick<LadderOption, 'underlying' | 'targetKind' | 'deltaPoints' | 'odds'>,
	anchors: Readonly<Record<LadderUnderlying, number | null>>,
	latestValue: number | null | undefined,
	stake = 1
): Projection | null {
	if (!Number.isFinite(stake) || stake <= 0) return null;
	if (latestValue === null || latestValue === undefined || !Number.isFinite(latestValue)) {
		return null;
	}
	const anchor = anchors[option.underlying];
	if (anchor === null || anchor === undefined) return null;

	const tier = computeTier(option, anchor, latestValue);
	if (tier === 'abstain') return null;
	return { tier, payout: payoutFor(tier, stake, option.odds) };
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/**
 * Whole NC chips with Indian digit grouping: 1,000 · 4,82,150 · −2,500.
 *
 * Hand-rolled rather than `Intl.NumberFormat('en-IN')` because the pot ticker
 * renders thousands of times a session and the grouping must not depend on the
 * runtime's ICU build. Fractional input is rounded to the nearest chip — NC is
 * an integer currency everywhere else in the app.
 */
export function formatNC(n: number): string {
	if (!Number.isFinite(n)) return '0';
	const sign = n < 0 ? '-' : '';
	const digits = String(Math.round(Math.abs(n)));
	if (digits.length <= 3) return `${sign}${digits}`;

	// Last three digits stay together; everything before them groups in twos.
	const parts: string[] = [digits.slice(-3)];
	let rest = digits.slice(0, -3);
	while (rest.length > 2) {
		parts.unshift(rest.slice(-2));
		rest = rest.slice(0, -2);
	}
	if (rest.length > 0) parts.unshift(rest);
	return `${sign}${parts.join(',')}`;
}

// ---------------------------------------------------------------------------
// stake validation — the client's copy of the server's rules
// ---------------------------------------------------------------------------

/**
 * Why `stake` cannot be placed yet, or `null` when it can.
 *
 * Same rules the service enforces (whole number, MIN..MAX, within the wallet) so
 * a stake the form accepts is a stake the server accepts. It is advisory only:
 * `INSUFFICIENT_BALANCE` can still come back from the server, because the wallet
 * may have moved since it was read.
 *
 * Accepts the raw string from the numeric keypad input — it tolerates the en-IN
 * grouping a player may type or paste ('1,000') and rejects anything else.
 */
export function stakeValidationError(
	stake: number | string | null | undefined,
	balance: number | null
): string | null {
	const raw = typeof stake === 'string' ? stake.trim().replace(/,/g, '') : stake;

	if (raw === '' || raw === null || raw === undefined) return 'Enter a stake to play.';
	const value = typeof raw === 'number' ? raw : Number(raw);
	if (Number.isNaN(value)) return 'Stake must be a number of NC.';
	if (!Number.isInteger(value)) return 'Stake must be a whole number of NC.';
	if (value <= 0) return 'Stake must be more than zero.';
	if (value < MIN_STAKE) return `Minimum stake is ${MIN_STAKE} NC.`;
	if (value > MAX_STAKE) return `Maximum stake is ${formatNC(MAX_STAKE)} NC.`;
	if (balance !== null && value > balance) return `Only ${formatNC(balance)} NC in your wallet.`;
	return null;
}

// ---------------------------------------------------------------------------
// stores — one /api/state payload, one drifted clock
// ---------------------------------------------------------------------------

/** The live screen state. `null` until the first successful read of `/api/state`. */
export const gameState: Writable<StatePayload | null> = writable(null);

/** Set when a state read failed, cleared by the next good one. */
export const stateError: Writable<string | null> = writable(null);

/** True while a state read is in flight (the skeletons in T13 key off this). */
export const stateLoading: Writable<boolean> = writable(false);

/**
 * `serverNow − clientNow`, measured on the most recent server response. The
 * countdown is computed as `Date.now() + driftOffsetMs`, so a phone with a 40s
 * wrong clock still sees the same cutoff everyone else does (PLAN §6 R3).
 */
export const driftOffsetMs: Writable<number> = writable(0);

const nowIstInternal = writable<number>(Date.now());

/** Drift-corrected epoch ms, ticking once a second once {@link startClock} ran. */
export const nowIst: Readable<number> = { subscribe: nowIstInternal.subscribe };

let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockRefs = 0;

function tickClock(): void {
	nowIstInternal.set(Date.now() + get(driftOffsetMs));
}

/**
 * Start the one-second clock and return the stop function. Idempotent and
 * ref-counted: a page, the layout chrome and the countdown pill can all start it
 * and one interval serves them all. Never called during SSR — only from `onMount`.
 */
export function startClock(): () => void {
	clockRefs += 1;
	if (clockTimer === null) {
		tickClock();
		clockTimer = setInterval(tickClock, 1000);
	}
	return () => {
		clockRefs = Math.max(0, clockRefs - 1);
		if (clockRefs === 0 && clockTimer !== null) {
			clearInterval(clockTimer);
			clockTimer = null;
		}
	};
}

/**
 * Install a payload the server already handed us (the page's `load`), so the
 * first paint has data and no client fetch is needed at all.
 *
 * CALLERS MUST GUARD THIS TO THE BROWSER. On the server this module is one
 * instance shared by every concurrent request, so seeding during SSR would show
 * player A's wallet to player B; the server renders straight from its own `load`
 * payload instead. `browser` from `$app/environment` is the guard every caller
 * uses.
 *
 * A fresher `serverNow` always wins: after a bet the store holds a newer payload
 * than the SSR data behind it, and navigating back to `/` must not roll the
 * screen backwards. A different `tradeDate` is a new day and is taken regardless.
 */
export function seedState(payload: StatePayload): void {
	const current = get(gameState);
	if (
		current !== null &&
		current.tradeDate === payload.tradeDate &&
		payload.serverNow <= current.serverNow
	) {
		return;
	}
	applyState(payload);
}

function applyState(payload: StatePayload): void {
	gameState.set(payload);
	driftOffsetMs.set(payload.serverNow - Date.now());
	tickClock();
	stateError.set(null);
}

/**
 * Re-measure the clock offset from a bare `serverNow` epoch ms — no payload.
 *
 * The live CAS feed refreshes this every time a `hello`/snapshot lands, because a
 * player can sit on the game page for an hour and a phone that drifts (or a tab
 * the OS throttled) must not shift the cutoff or the staleness maths. T12's only
 * addition to this module: everything else about the clock stays here.
 */
export function syncServerClock(serverNowMs: number): void {
	if (!Number.isFinite(serverNowMs)) return;
	driftOffsetMs.set(serverNowMs - Date.now());
	tickClock();
}

/**
 * `GET /api/state` — the one-request screen rebuild. Every mutation ends with
 * this, and so does a cold page that was not seeded from `load`.
 */
export async function loadState(): Promise<StatePayload | null> {
	stateLoading.set(true);
	try {
		const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
		const payload = (await res.json()) as StatePayload;
		applyState(payload);
		return payload;
	} catch (err: unknown) {
		stateError.set(err instanceof Error ? err.message : 'Could not load the table.');
		return null;
	} finally {
		stateLoading.set(false);
	}
}

// ---------------------------------------------------------------------------
// live CAS values (the 8s REST poll — T12 replaces it with SSE)
// ---------------------------------------------------------------------------

/** The slice of `/api/cas/all`'s `latest` an index card renders. */
export type CasLiveValue = {
	value: number;
	changePts: number;
	changePct: number;
	prevClose: number | null;
	ts: number;
};

export type CasLatestByIndex = Record<LadderUnderlying, CasLiveValue | null>;

const EMPTY_LATEST: CasLatestByIndex = { nifty: null, banknifty: null, sensex: null };

export const casLatest: Writable<CasLatestByIndex> = writable({ ...EMPTY_LATEST });

/** True while the auction could be moving — the page polls only inside it. */
export function isLivePhase(phase: GamePhase): boolean {
	return phase === 'open' || phase === 'locked';
}

/**
 * One read of `/api/cas/all`. Returns the display values it carried, or `null` on
 * a failed/odd response — the cards keep whatever they had and the next poll
 * heals it, so a single 500 never blanks the board.
 */
export async function fetchCasLatest(): Promise<CasLatestByIndex | null> {
	try {
		const res = await fetch('/api/cas/all', { headers: { accept: 'application/json' } });
		if (!res.ok) return null;
		const body = (await res.json()) as {
			latest?: Partial<Record<LadderUnderlying, CasLiveValue>>;
		};
		const latest = body.latest ?? {};
		const next: CasLatestByIndex = { ...EMPTY_LATEST };
		for (const underlying of Object.keys(next) as LadderUnderlying[]) {
			const value = latest[underlying];
			if (value && Number.isFinite(value.value)) next[underlying] = value;
		}
		casLatest.set(next);
		return next;
	} catch {
		return null;
	}
}

/**
 * Poll `/api/cas/all` every `intervalMs` and return the stop function. The
 * caller decides when to stop: the page stops the poll when the phase leaves the
 * live window, which is what keeps a tab sitting on the game page overnight from
 * ticking all night.
 *
 * T12 NOTE: this is no longer the game page's primary feed — `$lib/stores/casStream`
 * subscribes to `/api/stream` and only falls back to this when `EventSource` has
 * failed twice inside 30s (a proxy eating `text/event-stream`). It stays here,
 * rather than moving into the stream module, so the polling cadence keeps exactly
 * one home and the stream module stays testable without it.
 */
export function startCasPolling(
	intervalMs = 8000,
	shouldPoll: () => boolean = () => true
): () => void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;
	const run = (): void => {
		if (shouldPoll()) void fetchCasLatest();
	};
	timer = setInterval(run, intervalMs);
	run();
	return () => {
		if (stopped) return;
		stopped = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
}

// ---------------------------------------------------------------------------
// bet actions — thin wrappers, server is the source of truth
// ---------------------------------------------------------------------------

export type BetInput = {
	underlying: LadderUnderlying;
	targetKind: 'up' | 'down';
	deltaPoints: number;
	stake: number;
};

export type ActionResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Every bet-route error code → the sentence a player actually needs. One table,
 * shared by the card's inline error and the confirm modal, so a server refusal
 * never reaches the screen as `CUTOFF_PASSED`.
 */
const BET_ERROR_COPY: Readonly<Record<string, string>> = {
	UNAUTHENTICATED: 'Log in to place a bet.',
	INVALID_UNDERLYING: 'Pick one of NIFTY, BANKNIFTY or SENSEX.',
	INVALID_TARGET_KIND: 'That direction is not on the board.',
	INVALID_STAKE: `Stake must be a whole number from ${MIN_STAKE} to ${formatNC(MAX_STAKE)} NC.`,
	INVALID_TARGET: 'That target is no longer on the ladder.',
	MARKET_CLOSED: 'Markets are closed — back on the next trading day.',
	WINDOW_NOT_OPEN: 'Betting opens at 15:00 IST.',
	CUTOFF_PASSED: 'The 15:20 cutoff has passed — bets are locked.',
	SESSION_CLOSED: 'This session is no longer accepting bets.',
	BET_EXISTS: 'You already have a bet on this index today — edit it instead.',
	INSUFFICIENT_BALANCE: 'Not enough NC in your wallet for that stake.',
	BET_NOT_FOUND: 'That bet is gone — it may already have been cancelled.',
	BET_SETTLED: 'That bet is already settled.',
	BET_FAILED: 'The table hiccuped — try again.',
	NETWORK: 'Could not reach the casino — check your connection.'
};

/** Friendly copy for an error code, with a safe fallback for an unknown one. */
export function betErrorMessage(code: string | undefined | null): string {
	if (!code) return BET_ERROR_COPY.BET_FAILED;
	return BET_ERROR_COPY[code] ?? 'The table refused that — try again.';
}

/** POST/PATCH/DELETE a bet, then re-read the state the server now holds. */
async function betRequest(url: string, init: RequestInit): Promise<ActionResult> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { 'content-type': 'application/json', accept: 'application/json' }
		});
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		if (!res.ok) {
			const code = body.error ?? 'BET_FAILED';
			return { ok: false, code, message: betErrorMessage(code) };
		}
		await loadState();
		return { ok: true };
	} catch {
		return { ok: false, code: 'NETWORK', message: betErrorMessage('NETWORK') };
	}
}

/** POST /api/bets — place one leg. */
export function placeBet(input: BetInput): Promise<ActionResult> {
	return betRequest('/api/bets', { method: 'POST', body: JSON.stringify(input) });
}

/** PATCH /api/bets/[id] — move target and/or stake; an omitted field is unchanged. */
export function editBet(
	betId: string,
	patch: Partial<Pick<BetInput, 'targetKind' | 'deltaPoints' | 'stake'>>
): Promise<ActionResult> {
	return betRequest(`/api/bets/${betId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** DELETE /api/bets/[id] — cancel before the cutoff and get the stake back. */
export function cancelBet(betId: string): Promise<ActionResult> {
	return betRequest(`/api/bets/${betId}`, { method: 'DELETE' });
}
