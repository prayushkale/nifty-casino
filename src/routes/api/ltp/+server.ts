import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { istDateStr } from '$lib/time/ist';
import { getStore } from '$lib/server/db';
import { ensureLtpAnchors, fetchLiveLtp, isLtpAnchorDue, type LtpQuotes } from '$lib/server/ltp';

/**
 * GET /api/ltp — the last traded price per index, on the client's refresh clock.
 *
 * The client's schedule (see `$lib/stores/ltp`):
 *
 *   • page load            → ONE fetch; the number sits still on screen.
 *   • 15:00 → 15:15:01 IST → refetch every 30s (`final: false`).
 *   • 15:15:01 IST         → ONE final load (`final: true`): the spot market has
 *                            stopped, and this price is persisted as the day's
 *                            betting anchor (`index_closes.source='ltp_anchor'`).
 *   • after that           → static. The client never refetches, and a fresh page
 *                            load reads the same frozen anchor back.
 *
 * The cash (CAS) session starts at 15:20 and reaches the charts through
 * `/api/cas/all` + `/api/stream` — this endpoint is only ever the pre-auction
 * number and the 15:15 anchor.
 *
 * Quote shape mirrors `/api/cas/all`'s `latest` entries so the index cards can
 * render either interchangeably: `{ value, changePts, changePct, prevClose, ts }`.
 */
export const prerender = false;

export const GET: RequestHandler = async () => {
	const now = new Date();
	const tradeDate = istDateStr(now);
	const final = isLtpAnchorDue(now);

	let quotes: LtpQuotes;
	if (final) {
		// The anchor is due: make sure it is persisted (first caller wins), then read
		// the authoritative LEVELS back. Display fields (move vs prev close) come from
		// the live quote, whose `last` is the same frozen price after 15:15. One feed
		// fetch serves both halves — `ensureLtpAnchors` reuses it, no double hit.
		const live = await fetchLiveLtp();
		const anchored = await ensureLtpAnchors(getStore(), tradeDate, now, () =>
			Promise.resolve(live)
		);
		quotes = { ...anchored };
		for (const underlying of LADDER_UNDERLYINGS) {
			const liveQuote = live[underlying];
			if (liveQuote === null) continue;
			const anchor = anchored[underlying];
			quotes[underlying] =
				anchor === null
					? liveQuote
					: { ...liveQuote, value: anchor.value, ts: anchor.ts || liveQuote.ts };
		}
	} else {
		quotes = await fetchLiveLtp();
	}

	const out: Partial<Record<LadderUnderlying, unknown>> = {};
	for (const underlying of LADDER_UNDERLYINGS) {
		const quote = quotes[underlying];
		if (quote === null) continue;
		out[underlying] = {
			value: quote.value,
			changePts: quote.changePts,
			changePct: quote.changePct,
			prevClose: quote.prevClose,
			ts: quote.ts
		};
	}

	return json(
		{ tradeDate, serverNow: now.getTime(), final, quotes: out },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
