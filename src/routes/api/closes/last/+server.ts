import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { istDateStr, istDateStrToMidnightUtcMs } from '$lib/time/ist';
import { getLadderForDate } from '$lib/server/ladder';
import { fetchLiveLtp } from '$lib/server/ltp';
import type { LadderUnderlying } from '$lib/config/ladder';
import { getStore } from '$lib/server/db';

const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/closes/last?date=YYYY-MM-DD — last close per index for chart seeding.
 *
 * Every CasChart needs a vertical centre before the CAS ticks arrive. The ladder's
 * `anchors` already carry it, but on a fresh deploy (or when `index_closes` has
 * not yet been seeded for today) those anchors are `null` and every chart is
 * blank until the first 15:20 poll. This endpoint closes that gap:
 *
 *  1. Read the ladder anchors from DB (official → live_approx walk).
 *  2. For any index still `null`, hit the live NSE/BSE feeds directly and pull
 *     the LAST TRADED PRICE (`last` / `ltp`) — the same number the chart's
 *     first point shows — even when `indicativeClose`/`iclsprice` are still
 *     0/'-' outside the CAS window.
 *  3. Never throws: a blocked upstream just means that index stays `null` and the
 *     client keeps whatever it already had.
 *
 * The page calls this once on mount and merges the result over `state.ladder.anchors`
 * so all three charts share the same centre before the first tick replaces the flat
 * synthetic line.
 */
export const prerender = false;

export const GET: RequestHandler = async ({ url }) => {
	const rawDate = url.searchParams.get('date');
	let tradeDate: string;
	if (rawDate) {
		if (!IST_DATE_RE.test(rawDate)) {
			return json(
				{ error: true, code: 'INVALID_DATE', message: `date must be YYYY-MM-DD, got "${rawDate}"` },
				{ status: 400 }
			);
		}
		try {
			istDateStrToMidnightUtcMs(rawDate);
		} catch {
			return json(
				{ error: true, code: 'INVALID_DATE', message: `not a real calendar date: "${rawDate}"` },
				{ status: 400 }
			);
		}
		tradeDate = rawDate;
	} else {
		tradeDate = istDateStr(new Date());
	}

	const store = getStore();
	const ladder = await getLadderForDate(store, tradeDate);
	const closes: Record<LadderUnderlying, number | null> = { ...ladder.anchors };
	const sources: Record<LadderUnderlying, 'db' | 'live' | 'none'> = {
		nifty: closes.nifty !== null ? 'db' : 'none',
		banknifty: closes.banknifty !== null ? 'db' : 'none',
		sensex: closes.sensex !== null ? 'db' : 'none'
	};

	const needs = {
		nifty: closes.nifty === null,
		banknifty: closes.banknifty === null,
		sensex: closes.sensex === null
	};

	if (!needs.nifty && !needs.banknifty && !needs.sensex) {
		return json({ tradeDate, closes, sources }, { headers: { 'cache-control': 'no-store' } });
	}

	// Live fallback — best-effort, never fails the request. Shared with the
	// ladder's own fallback (`$lib/server/ltp`) so the chart centre and the
	// bettable ladder agree on the same last traded price.
	const live = await fetchLiveLtp();
	for (const underlying of ['nifty', 'banknifty', 'sensex'] as const) {
		const quote = live[underlying];
		if (closes[underlying] === null && quote !== null) {
			closes[underlying] = quote.value;
			sources[underlying] = 'live';
		}
	}

	return json({ tradeDate, closes, sources }, { headers: { 'cache-control': 'no-store' } });
};
