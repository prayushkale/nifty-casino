import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { probeNseHealth } from '$lib/server/cas/nse-api';

/**
 * GET /api/nse/health — cheap liveness probe for the watchdog cron (Task 16):
 * warms the Akamai session, then asks E3 `/api/marketStatus`, which shares NSE's
 * front door. `?deep=1` also requires E1 (the critical chart feed) to answer.
 *
 * Response: `{ ok, checkedAt, detail }`. NEVER throws — a blocked feed is
 * `ok: false` with a readable `detail`, so a cron gets a 200 either way and only
 * has to inspect the flag.
 *
 * Latency: worst case ~30s (15s handshake + 8s E3, then one session-reset +
 * retry on a stale Akamai session). Give the cron a generous client timeout;
 * alert on `ok: false`, not on elapsed time alone.
 */
export const prerender = false;

export const GET: RequestHandler = async ({ url }) => {
	const report = await probeNseHealth({ deep: url.searchParams.get('deep') === '1' });
	return json(report);
};
