/**
 * cas-store — the in-process hot buffer + fan-out bus (PLAN §2).
 *
 * This is the middle of the data flow: the poller (4s) pushes normalized
 * `CasTickPayload`s in, the SSE endpoint (`/api/stream`) and the snapshot
 * endpoint (`/api/cas/all`) read out. Deliberately NO I/O of any kind — no
 * fetch, no database — so it is pure state machinery that can be unit-tested
 * without a clock, a network or a store. The poller orchestrates persistence;
 * this module only ever holds the hot tail in RAM.
 *
 * Shape of the state, per IST trade date (a tick belongs to the IST day its
 * `ts` falls on, so a poll that straddles IST midnight writes two days):
 *
 *   days: Map<tradeDate, {
 *     ticks:    Map<Underlying, CasTick[]>   ring buffer, capped at RING_BUFFER_CAP
 *     latest:   Map<Underlying, CasLatest>   freshest display payload (change/pct/anchor)
 *     prevClose: Map<Underlying, number>     the previous-day close the feed carried
 *     lastTs:   number | null                newest accepted ts — the SSE event id
 *   }>
 *
 * Fan-out is a plain synchronous listener list: `ingest` emits one event per
 * IST day it touched, in the same tick, with no queue and no backpressure. An
 * SSE connection that cannot keep up is the SSE layer's problem (it writes into
 * a bounded frame queue), never this one's — one slow client must not slow the
 * poller.
 */
import { AUCTION_END_HMS, AUCTION_START_HMS, CAS_STALE_MS } from '$lib/config/app';
import { isBetweenHMS, istDateStr, istTodayIsTradingDay } from '$lib/time/ist';
import { appendCasTicks, istDateForTick, type CasTick } from './cas/cas-series';
import type { CasSource, CasTickPayload, Underlying } from './cas/types';

/** The indices the game trades, in stable display order (mirrors the cas_ticks CHECK). */
export const CAS_UNDERLYINGS = [
	'nifty',
	'banknifty',
	'sensex'
] as const satisfies readonly Underlying[];

/**
 * Where a display payload came from. `'archive'` marks the fallback case: a
 * value rebuilt from `cas_ticks` (server restart, or a past-day replay) rather
 * than read off a live poll.
 */
export type CasLatestSource = CasSource | 'archive';

/** What the client needs to render one index card (value + move + anchor). */
export type CasLatest = {
	value: number;
	changePts: number;
	changePct: number;
	/** Previous day's official close as the feed carried it (null when it did not). */
	prevClose: number | null;
	/** epoch ms of the poll this display payload came from. */
	ts: number;
	source: CasLatestSource;
};

/** The full-state payload — also the body of the SSE `hello` frame and of GET /api/cas/all. */
export type CasSnapshot = {
	tradeDate: string;
	/** epoch ms — clients derive all countdowns from this, never their own clock. */
	serverNow: number;
	/**
	 * Oldest ts still in the hot buffer (null when nothing is buffered). A client
	 * asking for a `since` older than this has a gap RAM cannot fill — the signal
	 * to backfill from `cas_ticks`.
	 */
	bufferedFrom: number | null;
	ticks: Record<Underlying, CasTick[]>;
	latest: Partial<Record<Underlying, CasLatest>>;
	/** True when the feed has gone quiet while the auction is live (client banner). */
	stale: boolean;
};

/** One fan-out event. `id` doubles as the SSE frame id (the Last-Event-ID cursor). */
export type StreamEventType = 'ticks' | 'heartbeat' | 'hello';
export type StreamEvent = { id: string; type: StreamEventType; payload: unknown };
export type StreamListener = (event: StreamEvent) => void;

/** Body of a `ticks` event: what is new, plus the display state it refreshed. */
export type CasDeltaPayload = {
	tradeDate: string;
	/** Only underlyings that actually got new ticks this poll. */
	ticks: Partial<Record<Underlying, CasTick[]>>;
	/** Every underlying this poll carried a payload for — freshest display state. */
	latest: Partial<Record<Underlying, CasLatest>>;
	bufferedFrom: number | null;
};

export type IngestResult = {
	/** The payloads the ring buffer actually retained (new, positive, monotonic). */
	accepted: CasTickPayload[];
	/** One `ticks` event per IST day this batch touched, already fanned out. */
	events: StreamEvent[];
};

// ---------------------------------------------------------------------------
// event factories + pure helpers
// ---------------------------------------------------------------------------

/** The heartbeat event. `id` is deliberately NOT a tick ts: a heartbeat must never move a client's Last-Event-ID cursor. */
export function heartbeatEvent(now: number = Date.now()): StreamEvent {
	return { id: `hb-${now}`, type: 'heartbeat', payload: { ts: now } };
}

/** The cursor a client should reconnect with — the newest ts in a snapshot, or '0'. */
export function snapshotEventId(snapshot: Pick<CasSnapshot, 'ticks' | 'latest'>): string {
	let newest = 0;
	for (const underlying of CAS_UNDERLYINGS) {
		const series = snapshot.ticks[underlying];
		if (series.length > 0) newest = Math.max(newest, series[series.length - 1].ts);
		const latest = snapshot.latest[underlying];
		if (latest) newest = Math.max(newest, latest.ts);
	}
	return String(newest);
}

/**
 * Whether the CAS auction is live at `now`: a trading day inside
 * 15:13:30–15:42:00 IST (inclusive on both ends — PLAN §1 window gating).
 * This is the ONLY gate on the server poller, and the reason the hot buffer
 * stays empty 23.5 hours a day.
 */
export function isAuctionWindowActive(now: Date): boolean {
	return istTodayIsTradingDay(now) && isBetweenHMS(now, AUCTION_START_HMS, AUCTION_END_HMS);
}

/** Three missed 4s polls while the auction is live = the feed has gone stale. */
export function isCasStale(newestTs: number | null, now: Date): boolean {
	if (newestTs === null) return false; // nothing yet is "waiting", not "stale"
	if (!isAuctionWindowActive(now)) return false;
	return now.getTime() - newestTs > CAS_STALE_MS;
}

function toLatest(payload: CasTickPayload): CasLatest {
	return {
		value: payload.value,
		changePts: payload.changePts,
		changePct: payload.changePct,
		prevClose: payload.prevClose,
		ts: payload.ts,
		source: payload.source
	};
}

/** Newest ts across a per-underlying series map, or null when there is nothing. */
function newestTsOf(series: Record<Underlying, CasTick[]>): number | null {
	let newest: number | null = null;
	for (const underlying of CAS_UNDERLYINGS) {
		const ticks = series[underlying];
		if (ticks.length === 0) continue;
		const ts = ticks[ticks.length - 1].ts;
		if (newest === null || ts > newest) newest = ts;
	}
	return newest;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

type DayState = {
	tradeDate: string;
	ticks: Map<Underlying, CasTick[]>;
	latest: Map<Underlying, CasLatest>;
	prevClose: Map<Underlying, number>;
	lastTs: number | null;
};

/** IST days retained in RAM. Yesterday's tail survives midnight; older days are DB-only. */
const RETAINED_DAYS = 2;

export class CasStore {
	private readonly days = new Map<string, DayState>();
	private readonly listeners = new Set<StreamListener>();

	/**
	 * Route a poll's payloads into their IST-day buffers and fan the result out.
	 * Synchronous and infallible: a malformed payload is dropped by
	 * `appendCasTicks`, a throwing listener is dropped from the fan-out, and
	 * nothing here can reject — the poller's loop must never die on ingest.
	 */
	ingest(ticks: readonly CasTickPayload[], now: Date = new Date()): IngestResult {
		const accepted: CasTickPayload[] = [];
		const events: StreamEvent[] = [];
		if (ticks.length === 0) return { accepted, events };

		const byDay = new Map<string, CasTickPayload[]>();
		for (const tick of ticks) {
			const bucket = byDay.get(istDateForTick(tick.ts));
			if (bucket) bucket.push(tick);
			else byDay.set(istDateForTick(tick.ts), [tick]);
		}

		for (const [tradeDate, group] of byDay) {
			const day = this.dayFor(tradeDate);
			const deltaTicks: Partial<Record<Underlying, CasTick[]>> = {};
			const deltaLatest: Partial<Record<Underlying, CasLatest>> = {};
			let newestAccepted = 0;

			for (const underlying of CAS_UNDERLYINGS) {
				const incoming = group.filter((t) => t.underlying === underlying);
				if (incoming.length === 0) continue;

				const existing = day.ticks.get(underlying) ?? [];
				const previousNewest = existing.length > 0 ? existing[existing.length - 1].ts : -Infinity;
				const next = appendCasTicks(
					existing,
					incoming.map((t) => ({ ts: t.ts, value: t.value }))
				);
				day.ticks.set(underlying, next);

				// Exactly the ticks appendCasTicks retained (ts > previous newest).
				const retained = new Set(next.filter((t) => t.ts > previousNewest).map((t) => t.ts));
				const fresh = incoming.filter((t) => retained.has(t.ts));
				if (fresh.length > 0) {
					accepted.push(...fresh);
					// The delta is the retained tail: if this batch was big enough to push
					// ticks out of the ring buffer, what was trimmed is gone from RAM too.
					const from = Math.max(0, next.length - fresh.length);
					deltaTicks[underlying] = next.slice(from);
					newestAccepted = Math.max(newestAccepted, ...fresh.map((t) => t.ts));
				}

				// Display state tracks the freshest payload even when its tick was a
				// duplicate poll — change/pct are worth refreshing, the ts is not new.
				const freshest = incoming.reduce((a, b) => (b.ts > a.ts ? b : a), incoming[0]);
				const latest = toLatest(freshest);
				day.latest.set(underlying, latest);
				deltaLatest[underlying] = latest;
				if (freshest.prevClose !== null && freshest.prevClose > 0) {
					day.prevClose.set(underlying, freshest.prevClose);
				}
			}

			if (newestAccepted > 0) {
				day.lastTs = Math.max(day.lastTs ?? 0, newestAccepted);
				events.push({
					id: String(day.lastTs),
					type: 'ticks',
					payload: {
						tradeDate,
						ticks: deltaTicks,
						latest: deltaLatest,
						bufferedFrom: bufferedFromOf(day)
					} satisfies CasDeltaPayload
				});
			}
		}

		this.prune(now);
		for (const event of events) this.emit(event);
		return { accepted, events };
	}

	/**
	 * Full state for `now`'s IST date, or only the ticks newer than `sinceTs`
	 * (the delta a reconnecting client asks for). Display state (`latest`) is
	 * always the full freshest value — it is one object per index, not a series.
	 */
	snapshot(sinceTs?: number, now: Date = new Date()): CasSnapshot {
		const tradeDate = istDateStr(now);
		const day = this.days.get(tradeDate);
		const ticks: Record<Underlying, CasTick[]> = { nifty: [], banknifty: [], sensex: [] };
		const latest: Partial<Record<Underlying, CasLatest>> = {};
		let bufferedFrom: number | null = null;

		if (day) {
			for (const underlying of CAS_UNDERLYINGS) {
				const series = day.ticks.get(underlying) ?? [];
				ticks[underlying] =
					sinceTs === undefined ? [...series] : series.filter((t) => t.ts > sinceTs);
				const entry = day.latest.get(underlying);
				if (entry) latest[underlying] = { ...entry };
			}
			bufferedFrom = bufferedFromOf(day);
		}

		return {
			tradeDate,
			serverNow: now.getTime(),
			bufferedFrom,
			ticks,
			latest,
			stale: isCasStale(newestTsOf(ticks), now)
		};
	}

	/** Register a fan-out listener; the returned handle removes it. */
	subscribe(listener: StreamListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Observability/test hook: how many live SSE-style listeners are attached. */
	listenerCount(): number {
		return this.listeners.size;
	}

	/** Previous-day close the feed carried for an underlying today (the display anchor). */
	prevCloseFor(tradeDate: string, underlying: Underlying): number | null {
		return this.days.get(tradeDate)?.prevClose.get(underlying) ?? null;
	}

	private dayFor(tradeDate: string): DayState {
		let day = this.days.get(tradeDate);
		if (!day) {
			day = {
				tradeDate,
				ticks: new Map(),
				latest: new Map(),
				prevClose: new Map(),
				lastTs: null
			};
			this.days.set(tradeDate, day);
		}
		return day;
	}

	/** Keep RAM bounded: only the newest {@link RETAINED_DAYS} IST days survive. */
	private prune(now: Date): void {
		if (this.days.size <= RETAINED_DAYS) return;
		const cutoff = istDateStr(now);
		for (const tradeDate of [...this.days.keys()].sort()) {
			if (this.days.size <= RETAINED_DAYS) break;
			if (tradeDate >= cutoff) continue; // never drop today (or a future-dated stray)
			this.days.delete(tradeDate);
		}
	}

	private emit(event: StreamEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (err) {
				// A listener that throws is broken — drop it rather than log-spam the
				// poller every 4 seconds. Well-behaved SSE connections unsubscribe.
				this.listeners.delete(listener);
				console.warn('[cas-store] dropped a throwing stream listener', err);
			}
		}
	}
}

/** Oldest ts still buffered for a day (null when empty) — the client's backfill signal. */
function bufferedFromOf(day: DayState): number | null {
	let oldest: number | null = null;
	for (const underlying of CAS_UNDERLYINGS) {
		const series = day.ticks.get(underlying);
		if (!series || series.length === 0) continue;
		const ts = series[0].ts;
		if (oldest === null || ts < oldest) oldest = ts;
	}
	return oldest;
}

// ---------------------------------------------------------------------------
// process-wide singleton (survives dev-HMR module re-execution)
// ---------------------------------------------------------------------------

const CAS_STORE_KEY = '__niftycasino_cas_store__';

/** The process's hot store. One per server, never per request. */
export function getCasStore(): CasStore {
	const ref = globalThis as typeof globalThis & Record<string, unknown>;
	if (!(ref[CAS_STORE_KEY] instanceof CasStore)) ref[CAS_STORE_KEY] = new CasStore();
	return ref[CAS_STORE_KEY] as CasStore;
}

/** Drop the singleton so the next `getCasStore()` builds a fresh one. Test-only. */
export function resetCasStoreForTests(): void {
	const ref = globalThis as typeof globalThis & Record<string, unknown>;
	delete ref[CAS_STORE_KEY];
}
