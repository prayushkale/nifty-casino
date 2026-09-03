/**
 * Live previous-close fallback (server-only).
 *
 * The ladder's anchors come from `index_closes` (official → live_approx walk),
 * but on a fresh deploy — or between 15:00 (bets open) and the first CAS poll
 * (~15:13:30, when the poller writes its `live_approx` anchor) — the DB has no
 * anchor yet while the NSE/BSE feeds already carry `previousClose`/`Prev_Close`.
 * Without a fallback the cards read "No ladder … previous close has not landed
 * yet" and nobody can bet, even though yesterday's close is one HTTP call away.
 *
 * This module fetches exactly that: the previous day's close per index, live,
 * best-effort, never throwing. Callers merge the result over the DB anchors and
 * regenerate options with `generateLadderOptions` — so the ladder a logged-in
 * player bets on is always anchored on the last closing price we actually have.
 *
 * The values are stable per day (yesterday's close does not move), so a short
 * in-process cache (60s) keeps the 30s settle poll and repeated `/api/state`
 * reads from hammering NSE/BSE while the DB is empty.
 */
import type { LadderUnderlying } from '$lib/config/ladder';
import { casNum } from '$lib/server/cas/types';

export type LivePrevCloses = Record<LadderUnderlying, number | null>;

/** Injectable fetchers so tests never touch the real feeds. */
export type LiveCloseDeps = {
	fetchNseIndexData?: () => Promise<unknown>;
	fetchBseSensexRows?: () => Promise<unknown[]>;
};

function positiveOrNull(raw: unknown): number | null {
	const n = casNum(raw);
	return n !== null && n > 0 ? n : null;
}

async function readNse(
	deps: LiveCloseDeps,
	out: LivePrevCloses,
	needNifty: boolean,
	needBank: boolean
): Promise<void> {
	if (!needNifty && !needBank) return;
	try {
		const fetchIndexData =
			deps.fetchNseIndexData ??
			((await import('$lib/server/cas/nse-api')).fetchIndexData as () => Promise<unknown>);
		const raw: unknown = await fetchIndexData();
		const rows: unknown[] = Array.isArray((raw as Record<string, unknown>)?.data)
			? ((raw as Record<string, unknown>).data as unknown[])
			: [];
		const findPrev = (indexName: string): number | null => {
			const row = rows.find(
				(r) => (r as Record<string, unknown>)?.indexName === indexName
			) as Record<string, unknown> | undefined;
			if (!row) return null;
			return positiveOrNull(row.previousClose);
		};
		if (needNifty && out.nifty === null) {
			const v = findPrev('NIFTY 50');
			if (v !== null) out.nifty = v;
		}
		if (needBank && out.banknifty === null) {
			const v = findPrev('NIFTY BANK');
			if (v !== null) out.banknifty = v;
		}
	} catch {
		// Blocked/auth/timeout upstream just leaves that index null — the caller
		// keeps whatever DB anchor it had (possibly none).
	}
}

async function readBse(deps: LiveCloseDeps, out: LivePrevCloses, needSensex: boolean): Promise<void> {
	if (!needSensex) return;
	try {
		const fetchBseSensexRows =
			deps.fetchBseSensexRows ??
			((await import('$lib/server/cas/bse-api')).fetchBseSensexRows as () => Promise<
				unknown[]
			>);
		const rows = await fetchBseSensexRows();
		const sensexRow = (rows as unknown[]).find(
			(r) => (r as Record<string, unknown>)?.indxnm === 'BSE SENSEX'
		) as Record<string, unknown> | undefined;
		if (sensexRow && out.sensex === null) {
			const v = positiveOrNull(sensexRow.Prev_Close);
			if (v !== null) out.sensex = v;
		}
	} catch {
		// Same best-effort contract as NSE above.
	}
}

// ---------------------------------------------------------------------------
// short cache: yesterday's close does not move, so refetching per request while
// the DB is empty is pure waste (and risks Akamai throttling the game's IP).
// ---------------------------------------------------------------------------

const LIVE_CACHE_TTL_MS = 60_000;

let cachedAt = 0;
let cached: LivePrevCloses = { nifty: null, banknifty: null, sensex: null };

/** Test-only: forget the cached live closes. */
export function invalidateLiveClosesCache(): void {
	cachedAt = 0;
	cached = { nifty: null, banknifty: null, sensex: null };
}

/**
 * Fetch the live previous close for every index in `needs`.
 *
 * Only the requested indices are hit (no NSE call when only SENSEX is missing
 * and vice versa). Never throws — an unreachable upstream resolves to nulls.
 * Pass `deps` in tests to avoid the network entirely.
 */
export async function fetchLivePrevCloses(
	needs: Record<LadderUnderlying, boolean>,
	deps: LiveCloseDeps = {}
): Promise<LivePrevCloses> {
	const useCache = Object.keys(deps).length === 0;
	const fresh = useCache && Date.now() - cachedAt < LIVE_CACHE_TTL_MS;
	const out: LivePrevCloses = { nifty: null, banknifty: null, sensex: null };

	// Serve what the cache already knows; fetch only what is still missing.
	if (fresh) {
		if (!needs.nifty || cached.nifty !== null) out.nifty = needs.nifty ? cached.nifty : null;
		if (!needs.banknifty || cached.banknifty !== null)
			out.banknifty = needs.banknifty ? cached.banknifty : null;
		if (!needs.sensex || cached.sensex !== null) out.sensex = needs.sensex ? cached.sensex : null;
		const stillNeed = {
			nifty: needs.nifty && out.nifty === null,
			banknifty: needs.banknifty && out.banknifty === null,
			sensex: needs.sensex && out.sensex === null
		};
		if (!stillNeed.nifty && !stillNeed.banknifty && !stillNeed.sensex) return out;
		await Promise.allSettled([
			readNse(deps, out, stillNeed.nifty, stillNeed.banknifty),
			readBse(deps, out, stillNeed.sensex)
		]);
		if (useCache) {
			if (out.nifty !== null) cached.nifty = out.nifty;
			if (out.banknifty !== null) cached.banknifty = out.banknifty;
			if (out.sensex !== null) cached.sensex = out.sensex;
			cachedAt = Date.now();
		}
		return out;
	}

	await Promise.allSettled([
		readNse(deps, out, needs.nifty, needs.banknifty),
		readBse(deps, out, needs.sensex)
	]);
	if (useCache) {
		// Merge, never evict: a request that only needed SENSEX must not forget
		// the NIFTY close an earlier request cached.
		if (out.nifty !== null) cached.nifty = out.nifty;
		if (out.banknifty !== null) cached.banknifty = out.banknifty;
		if (out.sensex !== null) cached.sensex = out.sensex;
		cachedAt = Date.now();
	}
	// Only return what was asked for — the cache may know more.
	return {
		nifty: needs.nifty ? out.nifty : null,
		banknifty: needs.banknifty ? out.banknifty : null,
		sensex: needs.sensex ? out.sensex : null
	};
}

/**
 * Fill the holes in a DB anchor set with the live previous closes.
 * Indices that already have a DB anchor are never overwritten and never fetched.
 */
export async function fillAnchorsFromLive(
	anchors: Record<LadderUnderlying, number | null>,
	deps: LiveCloseDeps = {}
): Promise<Record<LadderUnderlying, number | null>> {
	const needs = {
		nifty: anchors.nifty === null,
		banknifty: anchors.banknifty === null,
		sensex: anchors.sensex === null
	};
	if (!needs.nifty && !needs.banknifty && !needs.sensex) return { ...anchors };
	const live = await fetchLivePrevCloses(needs, deps);
	return {
		nifty: anchors.nifty ?? live.nifty,
		banknifty: anchors.banknifty ?? live.banknifty,
		sensex: anchors.sensex ?? live.sensex
	};
}
