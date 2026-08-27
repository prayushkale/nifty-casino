import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchIndexDataWithMeta, fetchMarketStatus, NseAPIError } from '$lib/server/cas/nse-api';
import {
	extractNseCasTicks,
	extractNseMarketStatusNiftyTick,
	type CasTickPayload
} from '$lib/server/cas/types';

/**
 * GET /api/nse/cas — the server-side NSE CAS poll (E1 index data + E3
 * market-status cross-check). This is what the 4s poller calls; it is also
 * handy as a debug probe. It NEVER returns raw upstream JSON — only normalized
 * `CasTickPayload[]`, plus whether the call needed a session reset.
 *
 * Response: `{ ticks, session: 'ok' | 'reset', ts }`
 *   - `ticks`        normalized NIFTY 50 + NIFTY BANK indicative closes (only
 *                    those currently publishing — an empty array is normal
 *                    outside the CAS window)
 *   - `session`      'reset' when the fetch survived only after dropping the
 *                    cached Akamai session and retrying once
 *
 * Errors: `{ error: true, code, message }` — 502 for any upstream failure
 * (blocked / auth / timeout / network / parse), 500 for the unexpected.
 */
export const prerender = false;

export const GET: RequestHandler = async () => {
	const ts = Date.now();
	try {
		// Per-endpoint tolerance (allSettled, as upstream): a blocked E3 never
		// kills E1 — the chart feed is the critical one.
		const settled = await Promise.allSettled([fetchIndexDataWithMeta(), fetchMarketStatus()]);
		const e1 = settled[0];
		if (e1.status === 'rejected') throw e1.reason;

		const ticks: CasTickPayload[] = extractNseCasTicks(e1.value.data, ts);

		// E3 cross-check: `indicativenifty50` often publishes before E1's
		// `indicativeClose`, so it fills the NIFTY gap rather than stalling the chart.
		if (settled[1].status === 'fulfilled' && !ticks.some((t) => t.underlying === 'nifty')) {
			const fromE3 = extractNseMarketStatusNiftyTick(settled[1].value, ts);
			if (fromE3) ticks.unshift(fromE3);
		}

		return json({ ticks, session: e1.value.sessionReset ? 'reset' : 'ok', ts });
	} catch (err) {
		if (err instanceof NseAPIError) {
			return json({ error: true, code: err.code, message: err.message }, { status: 502 });
		}
		return json(
			{
				error: true,
				code: 'NETWORK',
				message: err instanceof Error ? err.message : 'Unknown NSE failure'
			},
			{ status: 500 }
		);
	}
};
