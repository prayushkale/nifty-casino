/**
 * CAS history — the past-days dropdown for signed-in players (the same-day
 * movement is always persisted in `cas_ticks`; this is the door back INTO it
 * once the next trading day opened at 09:15 IST and the board moved on).
 *
 * Three pieces, mirroring how `$lib/stores/casStream` splits its halves:
 *
 *  1. A PURE parser (`parseHistoryResponse`) that turns a `/api/cas/all`
 *     payload (live or `?date=` replay — same shape) into the slices a chart
 *     needs: ticks + display values per index. Testable in plain node.
 *  2. A thin fetch layer that loads the option list once and, on selection,
 *     fetches that day's archive and publishes it.
 *  3. Two stores the page reads: `casHistory` (which day is selected) and
 *     `historySeries` / `historyLatest` (the selected day's data, `null`
 *     while the live board is showing).
 *
 * Selecting `null` ("Today · live") clears the replay and the page falls
 * back to the live stream — the SSE socket never stopped, so this is a pure
 * view switch with zero reconnection cost.
 */
import { get, writable, type Writable } from 'svelte/store';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import type { CasPoint } from '$lib/game/chart';
import type { CasLiveValue } from '$lib/stores/game';

/** One row of the dropdown: a day with tick data, newest first. */
export type CasHistoryDay = {
	tradeDate: string;
};

export type CasHistoryState = {
	/** IST dates with `cas_ticks` rows, newest first. Empty = nothing to replay. */
	days: string[];
	/** The selected replay day; `null` = the live board. */
	selected: string | null;
	loading: boolean;
	/** True once the option list has been fetched (success or failure) — the
	 * reactive page guard fetches exactly once per session. */
	loaded: boolean;
	error: string | null;
};

export const initialCasHistory: CasHistoryState = {
	days: [],
	selected: null,
	loading: false,
	loaded: false,
	error: null
};

export const casHistory: Writable<CasHistoryState> = writable(initialCasHistory);

/** The selected day's ticks per index; `null` while the live board is showing. */
export const historySeries: Writable<Record<LadderUnderlying, CasPoint[]> | null> = writable(null);

/** The selected day's display values per index; `null` while the live board is showing. */
export const historyLatest: Writable<Partial<Record<LadderUnderlying, CasLiveValue>> | null> =
	writable(null);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A `latest` entry, read tolerantly — junk fields become nulls, never NaNs. */
function toLiveValue(entry: unknown): CasLiveValue | null {
	if (!isRecord(entry)) return null;
	const value = entry.value;
	const ts = entry.ts;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
	const changePts = entry.changePts;
	const changePct = entry.changePct;
	const prevClose = entry.prevClose;
	return {
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

export type HistoryResponse = {
	tradeDate?: string;
	ticks?: Partial<Record<LadderUnderlying, CasPoint[]>>;
	latest?: Partial<Record<LadderUnderlying, unknown>>;
};

/**
 * Pure: one `/api/cas/all` body → the chart slices. Ticks are filtered to
 * usable points (finite ts, positive value) and `latest` to finite entries;
 * an empty/odd body yields empty slices, never an exception.
 */
export function parseHistoryResponse(body: unknown): {
	ticks: Record<LadderUnderlying, CasPoint[]>;
	latest: Partial<Record<LadderUnderlying, CasLiveValue>>;
} {
	const ticks: Record<LadderUnderlying, CasPoint[]> = { nifty: [], banknifty: [], sensex: [] };
	const latest: Partial<Record<LadderUnderlying, CasLiveValue>> = {};
	if (!isRecord(body)) return { ticks, latest };
	if (isRecord(body.ticks)) {
		for (const underlying of LADDER_UNDERLYINGS) {
			const raw = (body.ticks as Record<string, unknown>)[underlying];
			if (!Array.isArray(raw)) continue;
			const points: CasPoint[] = [];
			for (const item of raw) {
				if (!isRecord(item)) continue;
				const ts = item.ts;
				const value = item.value;
				if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
				if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
				points.push({ ts, value });
			}
			points.sort((a, b) => a.ts - b.ts);
			ticks[underlying] = points;
		}
	}
	if (isRecord(body.latest)) {
		for (const underlying of LADDER_UNDERLYINGS) {
			const value = toLiveValue((body.latest as Record<string, unknown>)[underlying]);
			if (value) latest[underlying] = value;
		}
	}
	return { ticks, latest };
}

/** The `fetch` the wire uses — injectable for tests. */
export type CasHistoryOptions = {
	fetchImpl?: typeof fetch;
	daysUrl?: string;
	archiveUrl?: (date: string) => string;
};

const defaults = (): Required<Pick<CasHistoryOptions, 'fetchImpl' | 'daysUrl' | 'archiveUrl'>> => ({
	fetchImpl: (input, init) => fetch(input, init),
	daysUrl: '/api/cas/days',
	archiveUrl: (date) => `/api/cas/all?date=${date}`
});

/** Load the dropdown's option list (best-effort — a failure leaves it empty). */
export async function loadCasHistoryDays(options: CasHistoryOptions = {}): Promise<string[]> {
	const { fetchImpl, daysUrl } = { ...defaults(), ...options };
	try {
		const res = await fetchImpl(daysUrl, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`GET ${daysUrl} → ${res.status}`);
		const body: unknown = await res.json();
		const days =
			isRecord(body) && Array.isArray(body.days)
				? body.days.filter(
						(d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
					)
				: [];
		casHistory.set({ ...get(casHistory), days, loaded: true, error: null });
		return days;
	} catch {
		casHistory.set({ ...get(casHistory), loaded: true, error: 'Could not load CAS history.' });
		return [];
	}
}

/**
 * Switch the charts to a past day's archive (or back to live with `null`).
 * Best-effort: a failed archive fetch keeps the current view and surfaces the
 * error instead of blanking the charts.
 */
export async function selectCasHistoryDay(
	date: string | null,
	options: CasHistoryOptions = {}
): Promise<boolean> {
	const { fetchImpl, archiveUrl } = { ...defaults(), ...options };
	if (date === null) {
		casHistory.set({ ...get(casHistory), selected: null, error: null });
		historySeries.set(null);
		historyLatest.set(null);
		return true;
	}
	casHistory.set({ ...get(casHistory), selected: date, loading: true, error: null });
	try {
		const res = await fetchImpl(archiveUrl(date), { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`GET archive ${date} → ${res.status}`);
		const parsed = parseHistoryResponse(await res.json());
		historySeries.set(parsed.ticks);
		historyLatest.set(parsed.latest);
		casHistory.set({ ...get(casHistory), loading: false });
		return true;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : `Could not load ${date}.`;
		// Revert to the live board — a failed archive must not leave the charts
		// blank with `selected` set but no data behind it.
		casHistory.set({ ...get(casHistory), selected: null, loading: false, error: message });
		historySeries.set(null);
		historyLatest.set(null);
		return false;
	}
}
