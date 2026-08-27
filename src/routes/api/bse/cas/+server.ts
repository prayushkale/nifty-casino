import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchBseSensexRows } from '$lib/server/cas/bse-api';
import { NseAPIError } from '$lib/server/cas/nse-api';
import { extractBseCasTick, type CasTickPayload } from '$lib/server/cas/types';

/**
 * GET /api/bse/cas — the server-side BSE SENSEX CAS poll
 * (`/RealTimeBseIndiaAPI/api/GetSensexDatanew/w`). NEVER returns raw upstream
 * JSON — only the normalized SENSEX `CasTickPayload` (empty array outside the
 * CAS window, when BSE publishes "-").
 *
 * Response: `{ ticks, ts }` — same tick shape as /api/nse/cas so the poller
 * consumes both identically.
 *
 * Errors: `{ error: true, code, message }` — 502 for any upstream failure,
 * 500 for the unexpected.
 */
export const prerender = false;

export const GET: RequestHandler = async () => {
	const ts = Date.now();
	try {
		const rows = await fetchBseSensexRows();
		const tick = extractBseCasTick(rows, ts);
		const ticks: CasTickPayload[] = tick ? [tick] : [];
		return json({ ticks, ts });
	} catch (err) {
		if (err instanceof NseAPIError) {
			return json({ error: true, code: err.code, message: err.message }, { status: 502 });
		}
		return json(
			{
				error: true,
				code: 'NETWORK',
				message: err instanceof Error ? err.message : 'Unknown BSE failure'
			},
			{ status: 500 }
		);
	}
};
