/**
 * The client side of the last-traded-price feed (`GET /api/ltp`).
 *
 * The refresh contract is the one the product asks for, and it is deliberately
 * NOT a live stream:
 *
 *   • a page that loads before 15:00 IST fetches the LTP ONCE and the number
 *     sits still — there is nothing to chase in the morning,
 *   • from 15:00 to 15:15:01 the LTP re-reads every 30s,
 *   • at 15:15:01 ONE final load lands — the spot market has stopped, the price
 *     is frozen, the server has persisted it as the day's betting anchor
 *     (`final: true` in the response) — and the feed stops for the day,
 *   • a page that loads after 15:15:01 reads the frozen anchor back and never
 *     schedules anything.
 *
 * After 15:20 the charts move again — but on CAS ticks from `/api/stream`, never
 * on this feed. Everything timing-related derives from the drift-corrected clock
 * (`driftOffsetMs`), so a phone with a wrong clock still obeys the server's IST
 * schedule; the pure helpers below are exported for the Vitest table.
 */
import { get, writable } from 'svelte/store';
import { LTP_ANCHOR_HMS, LTP_REFRESH_MS, LTP_REFRESH_START_HMS } from '$lib/config/app';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { hmsToSeconds, secOfDayIst } from '$lib/time/ist';
import { driftOffsetMs } from './game';

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

/** One index's LTP as the cards render it — the same fields as a CAS `latest`. */
export type LtpValue = {
	value: number;
	changePts: number;
	changePct: number;
	prevClose: number | null;
	ts: number;
};

export type LtpQuotes = Record<LadderUnderlying, LtpValue | null>;

/** Body of GET /api/ltp, read tolerantly. */
export type LtpResponse = {
	tradeDate?: string;
	serverNow?: number;
	/** True once the 15:15:01 anchor is due — the feed's stop signal. */
	final?: boolean;
	quotes?: Partial<Record<LadderUnderlying, LtpValue>>;
};

export const emptyLtpQuotes = (): LtpQuotes => ({
	nifty: null,
	banknifty: null,
	sensex: null
});

/** The live display state: quotes per index + whether the anchor is frozen. */
export const ltpQuotes = writable<LtpQuotes>(emptyLtpQuotes());
export const ltpFinal = writable(false);

// ---------------------------------------------------------------------------
// pure scheduling helpers
// ---------------------------------------------------------------------------

/** Which refresh regime `nowMs` (drift-corrected) is in. */
export type LtpPhase = 'early' | 'refresh' | 'final';

/**
 *   early   before 15:00      — one load, no refresh
 *   refresh 15:00 → 15:15:01  — every 30s
 *   final   15:15:01+         — one load, then the day is frozen
 */
export function ltpPhaseAt(
	nowMs: number,
	refreshStart: { h: number; m: number; s: number } = LTP_REFRESH_START_HMS,
	anchorAt: { h: number; m: number; s: number } = LTP_ANCHOR_HMS
): LtpPhase {
	const sec = secOfDayIst(new Date(nowMs));
	if (sec < hmsToSeconds(refreshStart)) return 'early';
	if (sec < hmsToSeconds(anchorAt)) return 'refresh';
	return 'final';
}

/**
 * Milliseconds from `nowMs` until the NEXT occurrence of an IST {h,m,s} wall
 * time today, or null when that instant has already passed today.
 */
export function msUntilHms(nowMs: number, t: { h: number; m: number; s: number }): number | null {
	const OFFSET_MS = 330 * 60_000;
	const targetSecOfDay = hmsToSeconds(t);
	const shifted = new Date(nowMs + OFFSET_MS);
	const nowSecOfDay =
		shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
	// Truncate to whole seconds: the anchor instant is wall-clock precise, and a
	// fraction of a second would fire the timeout 0.4s early or late harmlessly.
	const nowWholeSec = Math.floor(nowSecOfDay);
	if (targetSecOfDay <= nowWholeSec) return null;
	return (targetSecOfDay - nowWholeSec) * 1000 - shifted.getUTCMilliseconds();
}

/** Parse one `/api/ltp` body defensively — junk fields become nulls, never NaNs. */
export function parseLtpResponse(body: unknown): { final: boolean; quotes: LtpQuotes } | null {
	if (typeof body !== 'object' || body === null) return null;
	const raw = body as LtpResponse;
	const out = emptyLtpQuotes();
	const quotes = raw.quotes;
	if (typeof quotes === 'object' && quotes !== null) {
		for (const underlying of LADDER_UNDERLYINGS) {
			const entry = (quotes as Record<string, unknown>)[underlying] as
				| Record<string, unknown>
				| undefined;
			if (!entry) continue;
			const value = entry.value;
			const ts = entry.ts;
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
			if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
			const changePts = entry.changePts;
			const changePct = entry.changePct;
			const prevClose = entry.prevClose;
			out[underlying] = {
				value,
				changePts: typeof changePts === 'number' && Number.isFinite(changePts) ? changePts : 0,
				changePct: typeof changePct === 'number' && Number.isFinite(changePct) ? changePct : 0,
				prevClose:
					typeof prevClose === 'number' && Number.isFinite(prevClose) && prevClose > 0
						? prevClose
						: null,
				ts
			};
		}
	}
	return { final: raw.final === true, quotes: out };
}

// ---------------------------------------------------------------------------
// the wire — one feed per page, mirrors startCasStream's singleton shape
// ---------------------------------------------------------------------------

export type LtpFeedOptions = {
	fetchImpl?: typeof fetch;
	/** Drift-corrected "now"; overridable only for tests. */
	now?: () => number;
	/** Refresh cadence (default {@link LTP_REFRESH_MS}). */
	intervalMs?: number;
	/** URL; overridable only for tests. */
	url?: string;
};

let running: (() => void) | null = null;

/**
 * Start the LTP feed and return the stop function. A second call while one is
 * running reuses it, exactly like `startCasStream` — a page and a component
 * cannot open two.
 */
export function startLtpFeed(options: LtpFeedOptions = {}): () => void {
	if (running) return running;

	const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const intervalMs = options.intervalMs ?? LTP_REFRESH_MS;
	const now = options.now ?? (() => Date.now() + get(driftOffsetMs));

	let stopped = false;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const oneShots: ReturnType<typeof setTimeout>[] = [];

	const clearTimers = (): void => {
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		while (oneShots.length > 0) {
			const timer = oneShots.pop();
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	const applyBody = (body: unknown): boolean => {
		const parsed = parseLtpResponse(body);
		if (parsed === null) return false;
		ltpQuotes.set(parsed.quotes);
		if (parsed.final) ltpFinal.set(true);
		return parsed.final;
	};

	/** One read. Resolves to "the anchor is frozen — stop the feed". */
	const fetchOnce = async (): Promise<boolean> => {
		if (stopped) return true;
		try {
			const res = await fetchImpl(options.url ?? '/api/ltp', {
				headers: { accept: 'application/json' }
			});
			if (!res.ok) return false;
			return applyBody(await res.json());
		} catch {
			return false; // the schedule retries; one blip must not kill the day
		}
	};

	const stop = (): void => {
		stopped = true;
		clearTimers();
		if (running === stop) running = null;
		// Stores keep whatever they froze at — nothing to reset: a stopped feed's
		// last display value IS the 15:15 anchor the day runs on.
	};

	/** One fetch, then stop the whole feed when it declares the anchor frozen. */
	const fetchUntilFinal = (): void => {
		void fetchOnce().then((final) => {
			if (final) stop();
		});
	};

	// 1. The load fetch — before 15:00 this is the ONLY one the day gets.
	fetchUntilFinal();

	// 2. The 30s poller, gated by the phase so it sleeps before 15:00 and after
	//    the anchor froze (it still retries a missed final load — see the gate).
	pollTimer = setInterval(() => {
		if (stopped) return;
		const phase = ltpPhaseAt(now());
		if (phase === 'early') return;
		if (phase === 'final') {
			// Only reached when the 15:15:01 one-shot failed (network, server blip):
			// keep retrying until a response says `final: true`.
			if (!get(ltpFinal)) fetchUntilFinal();
			return;
		}
		fetchUntilFinal();
	}, intervalMs);

	// 3. Phase-boundary one-shots, so the regime changes land exactly on time
	//    rather than on the next 30s grid line.
	const at = now();
	if (ltpPhaseAt(at) === 'early') {
		const delay = msUntilHms(at, LTP_REFRESH_START_HMS);
		if (delay !== null) oneShots.push(setTimeout(fetchUntilFinal, delay));
	}
	const finalDelay = msUntilHms(at, LTP_ANCHOR_HMS);
	if (finalDelay !== null && finalDelay > 0) {
		// The one final load at exactly 15:15:01. After it the feed is done.
		oneShots.push(setTimeout(fetchUntilFinal, finalDelay));
	}

	running = stop;
	return stop;
}
