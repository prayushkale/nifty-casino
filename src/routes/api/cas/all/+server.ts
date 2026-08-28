import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildCasSnapshot } from '$lib/server/cas-snapshot';
import { getCasStore } from '$lib/server/cas-store';
import { getStore } from '$lib/server/db';
import { istDateStrToMidnightUtcMs } from '$lib/time/ist';
import { resolveSinceTs } from '$lib/server/sse';

/**
 * GET /api/cas/all?since=<epochMs>[&date=YYYY-MM-DD] — the snapshot + backfill
 * endpoint (PLAN §2). This is what a client calls on load, on refresh and on
 * every SSE reconnect; `/api/stream` then takes over with deltas.
 *
 * Response (also the shape of the SSE `hello` frame, so T12 handles both with
 * one code path):
 *
 *   tradeDate    IST trade date served
 *   serverNow    epoch ms — all countdowns derive from this
 *   bufferedFrom oldest ts the server's RAM ring buffer still holds (null when
 *                nothing is buffered) — a client whose cursor is older knows to
 *                expect the DB backfill in this same response
 *   ticks        { nifty: [{ts,value}…], banknifty: […], sensex: […] }
 *                hot buffer ∪ cas_ticks, ascending, deduped, ≤2000 per index
 *   latest       { <underlying>: { value, changePts, changePct, prevClose, ts, source } }
 *   stale        feed gone quiet >12s while the auction is live (client banner)
 *   truncated    a series was cut at the cap — never a silent cap
 *
 * `since` (or the SSE `Last-Event-ID` semantics: a numeric cursor) limits the
 * response to ticks newer than it; omit it for a full snapshot. `?date=` serves
 * a past day from `cas_ticks` only (replay for the history view). No auth — the
 * data is public market data — and it never touches NSE/BSE: only the server
 * poller and the three debug routes do.
 */
export const prerender = false;

const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: RequestHandler = async ({ url }) => {
	const dateParam = url.searchParams.get('date');
	if (dateParam && !IST_DATE_RE.test(dateParam)) {
		return json(
			{ error: true, code: 'INVALID_DATE', message: `date must be YYYY-MM-DD, got "${dateParam}"` },
			{ status: 400 }
		);
	}
	if (dateParam) {
		// Reject impossible calendar dates up front ('2026-02-30') — the shared IST
		// parser is the single place that knows what a valid IST date is.
		try {
			istDateStrToMidnightUtcMs(dateParam);
		} catch {
			return json(
				{ error: true, code: 'INVALID_DATE', message: `not a real calendar date: "${dateParam}"` },
				{ status: 400 }
			);
		}
	}

	const payload = await buildCasSnapshot({
		hot: getCasStore(),
		store: getStore(),
		date: dateParam,
		since: resolveSinceTs(url.searchParams.get('since'), null)
	});
	return json(payload, { headers: { 'Cache-Control': 'no-store' } });
};
