/**
 * The settlement scheduler (PLAN §5 T9) — the clock around the engine, and the
 * reason a day can never be settled on a guess.
 *
 * Window: weekdays, 15:43:00–17:00:00 IST. 15:43 because the auction's nominal
 * end is 15:42 and the capture refuses anything earlier; 17:00 because SEBI's
 * auction extensions are measured in minutes, not hours, and a day that still has
 * no official close two hours later has a feed problem, not a timing one.
 *
 * The loop, every SETTLE_RETRY_MS inside the window:
 *
 *   capture the official closes  → all three present? → settle the session
 *                                → some missing?      → wait, try again
 *
 * Nothing is ever invented: a missing SENSEX close leaves SENSEX bets (and only
 * them) unsettled, the session goes back to `open`, and at 17:00 the loop gives up
 * with a loud `[settle]` error. An unsettled day is visible and fixable; a
 * wrongly-settled one is not.
 *
 * Everything the loop decides is in {@link planSettleCycle} and
 * {@link nextDelayMs}, both pure — the table of "what happens at 15:42, 15:43,
 * 16:59, 17:01, on a Saturday, on a day with no session" is unit-tested without a
 * timer. Mirrors ./cas-poller: `globalThis` guard so dev HMR cannot start a second
 * loop, `VITEST`/`SETTLE_DISABLED` kill switches, unref'd timers, and a log tag
 * (`[settle]`) that greps cleanly.
 */
import {
	SETTLE_END_HMS,
	SETTLE_IDLE_RECHECK_MS,
	SETTLE_RETRY_MS,
	SETTLE_START_HMS
} from '$lib/config/app';
import {
	hmsToSeconds,
	isWeekend,
	istDateStr,
	istDateStrToMidnightUtcMs,
	istHmsToUtcMs,
	secOfDayIst
} from '$lib/time/ist';
import { getStore, type GameStore } from '$lib/server/db';
import type { SessionStatus } from '$lib/server/db/types';
import { unrefTimer } from '$lib/server/sse';
import {
	auctionEndMsFor,
	captureIsComplete,
	captureOfficialCloses,
	realOfficialCloseFetchers,
	type CaptureReport,
	type OfficialCloseFetchers
} from './capture';
import { settleSession, type SettleReport } from './engine';

/** What the loop decides to do with one instant. Pure — see {@link planSettleCycle}. */
export type SettleCyclePlan =
	| { action: 'idle'; reason: 'WEEKEND' | 'BEFORE_WINDOW' | 'AFTER_WINDOW' }
	/** In the window, but there is nothing to do: no session row, or already done. */
	| { action: 'skip'; reason: 'NO_SESSION' | 'ALREADY_SETTLED' }
	| { action: 'run'; reason: string };

/**
 * The decision for one instant, given the day's session row (or its absence).
 * Pure: no store, no clock, no I/O — pass the session you already read.
 */
export function planSettleCycle(
	now: Date,
	session: { status: SessionStatus } | null | undefined
): SettleCyclePlan {
	if (isWeekend(istDateStr(now))) return { action: 'idle', reason: 'WEEKEND' };

	const sec = secOfDayIst(now);
	if (sec < hmsToSeconds(SETTLE_START_HMS)) return { action: 'idle', reason: 'BEFORE_WINDOW' };
	// 17:00:00 itself is still in the window; the window closes at 17:00:01.
	if (sec > hmsToSeconds(SETTLE_END_HMS)) return { action: 'idle', reason: 'AFTER_WINDOW' };

	if (!session) return { action: 'skip', reason: 'NO_SESSION' };
	// Settled days are never re-touched: settleSession is idempotent, but not
	// reading it at all is cheaper and keeps the settled state untouched.
	if (session.status === 'settled') return { action: 'skip', reason: 'ALREADY_SETTLED' };
	return { action: 'run', reason: `SESSION_${session.status.toUpperCase()}` };
}

/**
 * How long the loop should sleep before its next look, from the plan it just got.
 * Pure. Inside the window the retry cadence is SETTLE_RETRY_MS; outside it the
 * loop idles on a coarser timer (and never wakes a timer every second for 22 hours).
 */
export function nextDelayMs(now: Date, plan: SettleCyclePlan): number {
	if (plan.action === 'idle' && plan.reason === 'BEFORE_WINDOW') {
		const tradeDate = istDateStr(now);
		const startMs = istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), SETTLE_START_HMS);
		return Math.max(0, Math.min(startMs - now.getTime(), SETTLE_IDLE_RECHECK_MS));
	}
	if (plan.action === 'idle') return SETTLE_IDLE_RECHECK_MS;
	return SETTLE_RETRY_MS;
}

/** Dependencies overridable per call — tests inject a store, a clock and fake fetchers. */
export type SettleDeps = {
	/** Defaults to the process store (`getStore()`). */
	store?: GameStore;
	/** Defaults to the real NSE/BSE clients. */
	fetchers?: OfficialCloseFetchers;
	/** Defaults to `console`. */
	log?: Pick<Console, 'info' | 'warn' | 'error'>;
	/** Overrides the chunk size handed to the engine (tests force small chunks). */
	chunkSize?: number;
	/** Defaults to `process.env` — tests and scripts can pin it. */
	env?: Record<string, string | undefined>;
};

export type SettleCycleReport = {
	plan: SettleCyclePlan;
	/** Present when the cycle got as far as fetching closes. */
	capture?: CaptureReport;
	/** Present when the cycle got as far as the engine. */
	settle?: SettleReport;
	/** True when the day is not finished and the loop should come back and try again. */
	retry: boolean;
};

/**
 * One cycle: read the day's session, decide, and (only when the plan says so)
 * capture the closes and settle. Never throws — a failed upstream or store call is
 * a warning and a `retry`, because the next wake-up is SETTLE_RETRY_MS away.
 */
export async function runSettleCycle(
	deps: SettleDeps = {},
	now: Date = new Date()
): Promise<SettleCycleReport> {
	const log = deps.log ?? console;
	const store = deps.store ?? getStore();
	const tradeDate = istDateStr(now);

	const session = await store.sessions.getSessionByDate(tradeDate);
	const plan = planSettleCycle(now, session);
	if (plan.action !== 'run') return { plan, retry: false };

	const capture = await captureOfficialCloses(
		store,
		now,
		deps.fetchers ?? realOfficialCloseFetchers
	);
	if (!captureIsComplete(capture)) {
		warnThrottled(
			log,
			tradeDate,
			`[settle] ${tradeDate}: official closes not ready (${capture.missing.join(', ') || 'upstream failed'}) — retrying in ${SETTLE_RETRY_MS / 1000}s`
		);
		return { plan, capture, retry: true };
	}

	try {
		const settle = await settleSession(store, tradeDate, {
			log,
			chunkSize: deps.chunkSize,
			// `now` is the authority for this cycle, so settled_at comes from it too —
			// a pinned clock in a dry-run produces a reproducible day.
			nowMs: now.getTime()
		});
		return {
			plan,
			capture,
			settle,
			retry: settle.status === 'incomplete' || settle.status === 'busy'
		};
	} catch (err: unknown) {
		log.error(`[settle] ${tradeDate}: settlement run failed: ${errorMessage(err)}`);
		return { plan, capture, retry: true };
	}
}

// ---------------------------------------------------------------------------
// the manual escape hatch
// ---------------------------------------------------------------------------

export type SettleNowOptions = SettleDeps & {
	/** Set false to skip the capture attempt (the closes are already in place). */
	capture?: boolean;
	/** Defaults to now — pinned by tests and dry-runs. */
	now?: Date;
};

/**
 * Manual settlement, bypassing the 15:43–17:00 window — the RUNBOOK's lever for a
 * stuck day, and what the T17 dry-run script calls. It does NOT bypass the
 * honesty rules:
 *
 *  • it captures only when `tradeDate` IS today's IST date and the auction has
 *    finished; a past date settles against the official closes already in
 *    `index_closes`, and is never back-filled with today's feed;
 *  • it still refuses to invent a close. Missing closes come back as an
 *    `incomplete` report with the session left open.
 */
export async function settleNow(
	store: GameStore,
	tradeDate: string,
	options: SettleNowOptions = {}
): Promise<{ capture?: CaptureReport; settle: SettleReport }> {
	const log = options.log ?? console;
	const now = options.now ?? new Date();

	let capture: CaptureReport | undefined;
	const mayCapture =
		options.capture !== false &&
		tradeDate === istDateStr(now) &&
		now.getTime() >= auctionEndMsFor(tradeDate);
	if (mayCapture) {
		capture = await captureOfficialCloses(
			store,
			now,
			options.fetchers ?? realOfficialCloseFetchers
		);
	} else if (options.capture !== false) {
		log.info(
			`[settle] ${tradeDate}: not capturing (only today's IST date may be captured, after 15:42) — settling against index_closes as it stands`
		);
	}

	const settle = await settleSession(store, tradeDate, {
		log,
		chunkSize: options.chunkSize,
		nowMs: now.getTime()
	});
	return { capture, settle };
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

type SettleHandle = {
	deps: SettleDeps;
	timer: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
	/** The day we last decided the window had closed on (so the error logs once). */
	gaveUpFor: string | null;
};

const SCHEDULER_KEY = '__niftycasino_settle_scheduler__';

function globalRef(): typeof globalThis & Record<string, unknown> {
	return globalThis as typeof globalThis & Record<string, unknown>;
}

/** Whether this process already has a settlement loop (test/observability hook). */
export function isSettleSchedulerRunning(): boolean {
	return globalRef()[SCHEDULER_KEY] !== undefined;
}

/**
 * Is this scheduler allowed to run at all? Disabled under Vitest (a test run must
 * never move money or open a 60s timer) and by `SETTLE_DISABLED=1` — the manual
 * kill switch for a maintenance window.
 */
export function settleDisabled(env: Record<string, string | undefined> = process.env): boolean {
	if (env.VITEST) return true;
	const flag = env.SETTLE_DISABLED?.trim().toLowerCase();
	return flag === '1' || flag === 'true';
}

/**
 * Start the loop, once per process (the `globalThis` guard makes dev-HMR
 * re-execution and repeated hook imports a no-op). Never throws. Returns whether
 * a loop is now running.
 */
export function startSettleScheduler(deps: SettleDeps = {}): boolean {
	const log = deps.log ?? console;
	const ref = globalRef();

	if (ref[SCHEDULER_KEY]) return false;
	if (settleDisabled(deps.env ?? process.env)) {
		log.info(
			'[settle] disabled (VITEST' +
				((deps.env ?? process.env).SETTLE_DISABLED ? ' / SETTLE_DISABLED' : '') +
				') — no settlement in this process'
		);
		return false;
	}

	const handle: SettleHandle = { deps, timer: null, stopped: false, gaveUpFor: null };
	ref[SCHEDULER_KEY] = handle;

	log.info(
		`[settle] scheduler started — weekdays ${formatHms(SETTLE_START_HMS)}–${formatHms(
			SETTLE_END_HMS
		)} IST, re-checking every ${SETTLE_RETRY_MS / 1000}s while closes are missing`
	);
	// A server (re)started mid-window must not sit out 30 seconds before its first
	// look at the day.
	schedule(handle, 0);
	return true;
}

/** Stop the loop and forget it. Safe to call when nothing is running (tests). */
export function stopSettleScheduler(): void {
	const ref = globalRef();
	const handle = ref[SCHEDULER_KEY] as SettleHandle | undefined;
	if (!handle) return;
	handle.stopped = true;
	if (handle.timer) clearTimeout(handle.timer);
	delete ref[SCHEDULER_KEY];
	(handle.deps.log ?? console).info('[settle] scheduler stopped');
}

/** Chain timeouts rather than `setInterval`: a slow cycle can never overlap itself. */
function schedule(handle: SettleHandle, delayMs: number): void {
	if (handle.stopped) return;
	const timer = setTimeout(() => {
		void runCycle(handle);
	}, delayMs);
	handle.timer = timer;
	// unref: an idle scheduler must never keep a process (or a test run) alive.
	unrefTimer(timer);
}

async function runCycle(handle: SettleHandle): Promise<void> {
	if (handle.stopped) return;
	const log = handle.deps.log ?? console;
	const now = new Date();

	let report: SettleCycleReport;
	try {
		report = await runSettleCycle(handle.deps, now);
	} catch (err: unknown) {
		// runSettleCycle is infallible by contract; this is the belt to those braces.
		log.error(`[settle] cycle failed: ${errorMessage(err)}`);
		report = { plan: { action: 'run', reason: 'FALLTHROUGH' }, retry: true };
	}

	// The 17:00 hand-off: say it out loud once, then stop trying for today. The
	// session is left exactly as it is — open, and never settled on a guess.
	const tradeDate = istDateStr(now);
	if (
		report.plan.action === 'idle' &&
		report.plan.reason === 'AFTER_WINDOW' &&
		handle.gaveUpFor !== tradeDate
	) {
		handle.gaveUpFor = tradeDate;
		const store = handle.deps.store ?? getStore();
		try {
			const session = await store.sessions.getSessionByDate(tradeDate);
			if (session && session.status !== 'settled') {
				log.error(
					`[settle] GIVING UP on ${tradeDate}: window closed at ${formatHms(
						SETTLE_END_HMS
					)} IST with the session still '${session.status}'. ` +
						'No official close was available in time, so nothing was settled — ' +
						'check the NSE/BSE feed, then run settleNow(store, tradeDate) by hand.'
				);
			}
		} catch (err: unknown) {
			log.error(
				`[settle] ${tradeDate}: could not read the session after the window: ${errorMessage(err)}`
			);
		}
	}

	if (handle.stopped) return;
	schedule(handle, nextDelayMs(now, report.plan));
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === 'string' ? err : 'unknown error';
}

/** A blocked feed does not need a warning a minute for two hours. */
const WARN_THROTTLE_MS = 5 * 60_000;
const lastWarnAt = new Map<string, number>();

function warnThrottled(log: Pick<Console, 'warn'>, key: string, message: string): void {
	const nowMs = Date.now();
	const previous = lastWarnAt.get(key) ?? 0;
	if (nowMs - previous < WARN_THROTTLE_MS) return;
	lastWarnAt.set(key, nowMs);
	log.warn(message);
}

function formatHms({ h, m, s }: { h: number; m: number; s: number }): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
