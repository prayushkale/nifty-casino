/**
 * cas-poller — the ONE server-side scraper loop (PLAN §2).
 *
 * Contract, in the order that matters:
 *
 *  - **One cadence, no audience.** 10 users or 10 lakh users produce the same
 *    4s NSE/BSE hit rate. The loop never looks at connected-client counts.
 *  - **Window gated.** It only acts inside 15:13:30–15:42:00 IST on a trading
 *    day ({@link shouldPollNow}); outside the window it sleeps in 30s chunks so
 *    a server that runs for weeks does not wake a timer every 4 seconds for
 *    nothing.
 *  - **Never dies, never throws.** Upstream failures, DB failures, even a bug
 *    in ingest are logged (tagged `[cas-poller]`) and swallowed. The next poll
 *    is 4s away and a tick is 4s of data.
 *  - **Browsers can never reach here.** No route imports this module's fetch
 *    path; only `hooks.server.ts` starts it. The three `/api/{nse,bse}/*`
 *    routes are debug probes that share the fetchers, not the loop.
 *
 * Persistence goes through the process `GameStore` (never a driver directly):
 * `ticks.insertCasTicks` for the archive, `closes.upsertIndexCloseIfAbsent` for
 * the previous-day anchor the bet ladder (T8) and settlement (T9) read.
 */
import { AUCTION_END_HMS, AUCTION_START_HMS, POLL_MS } from '$lib/config/app';
import { istDateStr } from '$lib/time/ist';
import { istDateForTick } from './cas/cas-series';
import { fetchBseSensexRows } from './cas/bse-api';
import { fetchIndexData } from './cas/nse-api';
import { extractBseCasTick, extractNseCasTicks, type CasTickPayload } from './cas/types';
import { getCasStore, isAuctionWindowActive, type CasStore } from './cas-store';
import { getStore, type GameStore } from './db';
import type { CasTickRow, CloseSource, Underlying } from './db/types';
import { unrefTimer } from './sse';

/** Where a close came from (re-declared here to keep the poller's writes readable). */
const CLOSE_SOURCE_LIVE: CloseSource = 'live_approx';

/** Idle re-check cadence outside the auction window (do NOT hammer timers for 23.5h). */
export const IDLE_RECHECK_MS = 30_000;

/** Why a poll cycle did (or did not) act — the poller's own observability shape. */
export type PollResult = {
	/** Payloads the upstreams produced (0 when both feeds were empty/blocked). */
	polled: number;
	/** Payloads the hot ring buffer retained (new, positive, monotonic). */
	accepted: number;
	/** Rows actually written to `cas_ticks`. */
	persisted: number;
	/** Underlyings whose previous-day anchor was newly written this poll. */
	anchored: Underlying[];
};

/** Per-day anchor bookkeeping (what we wrote + what the DB says is official). */
export type DayAnchorBook = {
	anchored: Set<Underlying>;
	official: Set<Underlying>;
	/** Set once the day's `index_closes` row has been read (one query per day). */
	officialLoaded: boolean;
};

export type PollerDeps = {
	/** Defaults to the process store (`getStore()`). */
	store?: GameStore;
	/** Defaults to the process hot store (`getCasStore()`). */
	hot?: CasStore;
	/** NSE E1. Defaults to the real fetcher. */
	fetchNse?: () => Promise<unknown>;
	/** BSE SENSEX rows. Defaults to the real fetcher. */
	fetchBse?: () => Promise<unknown>;
	/** Defaults to `process.env` — tests and scripts can pin it. */
	env?: Record<string, string | undefined>;
	/** Anchor bookkeeping the loop carries across polls. A standalone call starts fresh. */
	anchors?: Map<string, DayAnchorBook>;
	log?: Pick<Console, 'info' | 'warn'>;
};

// ---------------------------------------------------------------------------
// pure scheduling + mapping helpers (the unit-testable surface)
// ---------------------------------------------------------------------------

/**
 * Should this instant produce an upstream poll?
 * `isAuctionWindowActive` is the PLAN §1 name for the same predicate; the alias
 * keeps the poller's loop self-describing and gives the tests one thing to pin
 * boundaries against.
 */
export function shouldPollNow(now: Date): boolean {
	return isAuctionWindowActive(now);
}

/**
 * Is this poller allowed to run at all? Disabled under Vitest (tests must never
 * touch NSE/BSE or open a 4s timer) and by `CAS_POLLER_DISABLED=1` — the
 * manual kill switch for a blocked feed or a maintenance window.
 */
export function pollerDisabled(env: Record<string, string | undefined> = process.env): boolean {
	if (env.VITEST) return true;
	const flag = env.CAS_POLLER_DISABLED?.trim().toLowerCase();
	return flag === '1' || flag === 'true';
}

/** Map normalized payloads to `cas_ticks` rows. `tradeDate` defaults to each tick's IST date. */
export function ticksToDbRows(
	payloads: readonly CasTickPayload[],
	tradeDate?: string
): CasTickRow[] {
	return payloads.map((p) => ({
		tradeDate: tradeDate ?? istDateForTick(p.ts),
		underlying: p.underlying,
		ts: p.ts,
		value: p.value,
		changePts: p.changePts,
		changePct: p.changePct
	}));
}

/** The anchor decision for one payload, against what we already know about the day. */
export type AnchorDayState = {
	/** Underlyings this process has already written (or found) an anchor for today. */
	anchored: ReadonlySet<Underlying>;
	/** Underlyings whose row for today is already the exchange-official close. */
	official: ReadonlySet<Underlying>;
};

/**
 * Whether this payload should become today's `live_approx` previous-day anchor.
 *
 * Exactly once per (day, underlying), and only for a positive prevClose — the
 * first poll that carries the anchor wins, and a row already holding the
 * official close is never touched. Later polls repeat the same prevClose all
 * day, so "first wins" loses nothing.
 */
export function needsAnchor(state: AnchorDayState, payload: CasTickPayload): boolean {
	if (payload.prevClose === null || !Number.isFinite(payload.prevClose)) return false;
	if (payload.prevClose <= 0) return false;
	if (state.anchored.has(payload.underlying)) return false;
	if (state.official.has(payload.underlying)) return false;
	return true;
}

// ---------------------------------------------------------------------------
// one poll
// ---------------------------------------------------------------------------

/**
 * One cycle: fetch both exchanges, normalize, ingest into the hot buffer, then
 * persist the archive + the prev-close anchor. Every failure path is a
 * `console.warn`; nothing here can throw into the loop.
 */
export async function pollOnce(deps: PollerDeps = {}, now: Date = new Date()): Promise<PollResult> {
	const log = deps.log ?? console;
	const hot = deps.hot ?? getCasStore();
	const store = deps.store ?? getStore();
	const fetchNse = deps.fetchNse ?? fetchIndexData;
	const fetchBse = deps.fetchBse ?? fetchBseSensexRows;
	const ts = now.getTime();

	const payloads: CasTickPayload[] = [];
	const settled = await Promise.allSettled([fetchNse(), fetchBse()]);

	const nse = settled[0];
	if (nse.status === 'fulfilled') {
		payloads.push(...extractNseCasTicks(nse.value, ts));
	} else {
		warnThrottled(log, 'nse', `[cas-poller] NSE E1 failed: ${errorMessage(nse.reason)}`);
	}
	const bse = settled[1];
	if (bse.status === 'fulfilled') {
		const tick = extractBseCasTick(bse.value, ts);
		if (tick) payloads.push(tick);
	} else {
		warnThrottled(log, 'bse', `[cas-poller] BSE SENSEX failed: ${errorMessage(bse.reason)}`);
	}

	if (payloads.length === 0) return { polled: 0, accepted: 0, persisted: 0, anchored: [] };

	const { accepted } = hot.ingest(payloads, now);

	let persisted = 0;
	try {
		const rows = ticksToDbRows(accepted);
		if (rows.length > 0) persisted = await store.ticks.insertCasTicks(rows);
	} catch (err) {
		// The tick is still in RAM and SSE is still live; the archive retries in 4s
		// via the natural key (re-inserting a poll is a no-op).
		log.warn(`[cas-poller] cas_ticks insert failed: ${errorMessage(err)}`);
	}

	const anchored = await anchorPrevCloses(deps, store, accepted, now);
	return { polled: payloads.length, accepted: accepted.length, persisted, anchored };
}

/**
 * Persist the previous-day anchor for any underlying whose first positive
 * `prevClose` of the day just arrived. This is the row the bet ladder (T8) and
 * settlement (T9) hang off, so it is written as early as the feed allows and
 * never overwrites an official close.
 */
async function anchorPrevCloses(
	deps: PollerDeps,
	store: GameStore,
	payloads: readonly CasTickPayload[],
	now: Date
): Promise<Underlying[]> {
	const log = deps.log ?? console;
	const tradeDate = istDateStr(now);
	const book = deps.anchors?.get(tradeDate) ?? {
		anchored: new Set(),
		official: new Set(),
		officialLoaded: false
	};
	deps.anchors?.set(tradeDate, book);

	if (!book.officialLoaded) {
		try {
			const closes = await store.closes.getIndexCloses(tradeDate);
			for (const close of closes) {
				if (close.source === 'official') book.official.add(close.underlying);
			}
			book.officialLoaded = true;
		} catch (err) {
			// Not fatal: `upsertIndexCloseIfAbsent` is the authoritative guard.
			log.warn(`[cas-poller] index_closes read failed: ${errorMessage(err)}`);
		}
	}

	const written: Underlying[] = [];
	for (const payload of payloads) {
		const prevClose = payload.prevClose;
		// A local guard keeps the write below cast-free: needsAnchor re-checks the
		// day bookkeeping, this re-checks the anchor value itself.
		if (prevClose === null || !(prevClose > 0)) continue;
		if (!needsAnchor({ anchored: book.anchored, official: book.official }, payload)) continue;
		try {
			const inserted = await store.closes.upsertIndexCloseIfAbsent({
				tradeDate,
				underlying: payload.underlying,
				close: prevClose,
				source: CLOSE_SOURCE_LIVE
			});
			// Mark anchored either way: an existing row must not be rewritten all day.
			book.anchored.add(payload.underlying);
			if (inserted) written.push(payload.underlying);
		} catch (err) {
			// Leave the flag clear so the next poll retries the write.
			log.warn(`[cas-poller] prev-close anchor write failed: ${errorMessage(err)}`);
		}
	}
	if (written.length > 0) {
		log.info(
			`[cas-poller] anchored prev close for ${tradeDate}: ${written.join(', ')} (${CLOSE_SOURCE_LIVE})`
		);
	}
	return written;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return typeof err === 'string' ? err : 'unknown error';
}

/**
 * A feed that is blocked does not need 15 warnings a minute. Log the first
 * failure for a key, then stay quiet for a while — long enough to debug from,
 * short enough not to fill a disk at 4s cadence.
 */
const WARN_THROTTLE_MS = 30_000;
const lastWarnAt = new Map<string, number>();

function warnThrottled(log: Pick<Console, 'warn'>, key: string, message: string): void {
	const nowMs = Date.now();
	const previous = lastWarnAt.get(key) ?? 0;
	if (nowMs - previous < WARN_THROTTLE_MS) return;
	lastWarnAt.set(key, nowMs);
	log.warn(message);
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

type PollerHandle = {
	deps: PollerDeps;
	/** Anchor bookkeeping keyed by IST trade date. */
	anchors: Map<string, DayAnchorBook>;
	timer: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
	/** Last window state we logged, so transitions are logged once. */
	wasInWindow: boolean | null;
	startedAt: number;
};

const POLLER_KEY = '__niftycasino_cas_poller__';

function globalRef(): typeof globalThis & Record<string, unknown> {
	return globalThis as typeof globalThis & Record<string, unknown>;
}

/** Whether this process already has a loop running (test/observability hook). */
export function isCasPollerRunning(): boolean {
	return globalRef()[POLLER_KEY] !== undefined;
}

/**
 * Start the loop, once per process. The `globalThis` guard is what makes dev-HMR
 * module re-execution and repeated hook imports safe: the second call is a
 * no-op, never a second scraper hammering NSE.
 *
 * Returns whether a loop is now running. Never throws.
 */
export function startCasPoller(deps: PollerDeps = {}): boolean {
	const log = deps.log ?? console;
	const ref = globalRef();

	if (ref[POLLER_KEY]) return false; // already running — HMR double-exec guard
	if (pollerDisabled(deps.env ?? process.env)) {
		log.info(
			'[cas-poller] disabled (VITEST' +
				((deps.env ?? process.env).CAS_POLLER_DISABLED ? ' / CAS_POLLER_DISABLED' : '') +
				') — no upstream polling in this process'
		);
		return false;
	}

	const handle: PollerHandle = {
		deps,
		anchors: new Map(),
		timer: null,
		stopped: false,
		wasInWindow: null,
		startedAt: Date.now()
	};
	ref[POLLER_KEY] = handle;

	log.info(
		`[cas-poller] started — every ${POLL_MS}ms inside ${formatHms(AUCTION_START_HMS)}–${formatHms(
			AUCTION_END_HMS
		)} IST on trading days, re-checking every ${IDLE_RECHECK_MS / 1000}s outside it`
	);
	// First cycle immediately: a server (re)started mid-window must not sit out
	// 30 seconds before its first poll. runCycle picks the real cadence from there.
	schedule(handle, 0);
	return true;
}

/** Stop the loop and forget it. Safe to call when nothing is running (tests). */
export function stopCasPoller(): void {
	const ref = globalRef();
	const handle = ref[POLLER_KEY] as PollerHandle | undefined;
	if (!handle) return;
	handle.stopped = true;
	if (handle.timer) clearTimeout(handle.timer);
	delete ref[POLLER_KEY];
	(handle.deps.log ?? console).info('[cas-poller] stopped');
}

/** Chain timeouts rather than `setInterval`: a slow poll can never overlap itself. */
function schedule(handle: PollerHandle, delayMs: number): void {
	if (handle.stopped) return;
	const timer = setTimeout(() => {
		void runCycle(handle);
	}, delayMs);
	handle.timer = timer;
	// unref: an idle poller must never keep a process (or a test run) alive.
	unrefTimer(timer);
}

async function runCycle(handle: PollerHandle): Promise<void> {
	if (handle.stopped) return;
	const now = new Date();
	const inWindow = shouldPollNow(now);

	if (inWindow !== handle.wasInWindow) {
		handle.wasInWindow = inWindow;
		if (inWindow) {
			(handle.deps.log ?? console).info(
				`[cas-poller] window open (${istDateStr(now)}) — polling NSE E1 + BSE SENSEX every ${POLL_MS}ms`
			);
		} else {
			(handle.deps.log ?? console).info(
				`[cas-poller] window closed — waiting for ${formatHms(AUCTION_START_HMS)}–${formatHms(
					AUCTION_END_HMS
				)} IST on the next trading day`
			);
		}
	}

	let nextDelay = POLL_MS;
	if (inWindow) {
		try {
			const result = await pollOnce(handle.deps, now);
			pruneAnchorBooks(handle, istDateStr(now));
			if (result.polled > 0) {
				(handle.deps.log ?? console).info(
					`[cas-poller] polled ${result.polled} payload(s), kept ${result.accepted}, persisted ${result.persisted}`
				);
			}
		} catch (err) {
			// pollOnce is infallible by contract; this is the belt to those braces.
			warnThrottled(
				handle.deps.log ?? console,
				'cycle',
				`[cas-poller] cycle failed: ${errorMessage(err)}`
			);
		}
	} else {
		nextDelay = IDLE_RECHECK_MS;
	}

	if (handle.stopped) return;
	schedule(handle, nextDelay);
}

/** Keep the per-day anchor bookkeeping bounded (today + yesterday is plenty). */
function pruneAnchorBooks(handle: PollerHandle, today: string): void {
	for (const tradeDate of [...handle.anchors.keys()].sort()) {
		if (tradeDate >= today) continue;
		handle.anchors.delete(tradeDate);
	}
}

function formatHms({ h, m, s }: { h: number; m: number; s: number }): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
