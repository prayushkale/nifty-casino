import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { istDateStr, istDateStrToMidnightUtcMs } from '$lib/time/ist';
import { getLadderForDate } from '$lib/server/ladder';
import type { LadderUnderlying } from '$lib/config/ladder';
import { getStore } from '$lib/server/db';
import { casNum } from '$lib/server/cas/types';

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
 *     `previousClose` / `Prev_Close` — the previous day's official close — even
 *     when `indicativeClose`/`iclsprice` are still 0/'-' outside the CAS window.
 *     The CAS extractors would return `null` out-of-window, so this route reads
 *     the raw fields itself.
 *  3. Never throws: a blocked upstream just means that index stays `null` and the
 *     client keeps whatever it already had.
 *
 * The page calls this once on mount and merges the result over `state.ladder.anchors`
 * so all three charts share the same centre before the first tick replaces the flat
 * synthetic line.
 */
export const prerender = false;

function positiveOrNull(raw: unknown): number | null {
	const n = casNum(raw);
	return n !== null && n > 0 ? n : null;
}

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

	const needNse = closes.nifty === null || closes.banknifty === null;
	const needBse = closes.sensex === null;

	if (!needNse && !needBse) {
		return json({ tradeDate, closes, sources }, { headers: { 'cache-control': 'no-store' } });
	}

	// Live fallback — best-effort, never fails the request
	const tasks: Promise<void>[] = [];

	if (needNse) {
		tasks.push(
			(async () => {
				try {
					const { fetchIndexData } = await import('$lib/server/cas/nse-api');
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
					if (closes.nifty === null) {
						const v = findPrev('NIFTY 50');
						if (v !== null) {
							closes.nifty = v;
							sources.nifty = 'live';
						}
					}
					if (closes.banknifty === null) {
						const v = findPrev('NIFTY BANK');
						if (v !== null) {
							closes.banknifty = v;
							sources.banknifty = 'live';
						}
					}
				} catch {
					// swallow — blocked/auth/timeout keeps the chart on its synthetic anchor or blank
				}
			})()
		);
	}

	if (needBse) {
		tasks.push(
			(async () => {
				try {
					const { fetchBseSensexRows } = await import('$lib/server/cas/bse-api');
					const rows = await fetchBseSensexRows();
					const sensexRow = (rows as unknown[]).find(
						(r) => (r as Record<string, unknown>)?.indxnm === 'BSE SENSEX'
					) as Record<string, unknown> | undefined;
					if (sensexRow && closes.sensex === null) {
						const v = positiveOrNull(sensexRow.Prev_Close);
						if (v !== null) {
							closes.sensex = v;
							sources.sensex = 'live';
						}
					}
				} catch {
					// swallow
				}
			})()
		);
	}

	await Promise.allSettled(tasks);

	return json({ tradeDate, closes, sources }, { headers: { 'cache-control': 'no-store' } });
};
