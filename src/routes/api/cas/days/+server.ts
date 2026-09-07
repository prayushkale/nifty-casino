import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStore } from '$lib/server/db';

/**
 * GET /api/cas/days — the CAS-history dropdown's option list.
 *
 * After the next trading day opens at 09:15 IST the board stops auto-showing
 * the previous day's CAS movement; logged-in players get a dropdown instead,
 * and this endpoint answers what that dropdown may contain: every IST date
 * that actually holds `cas_ticks` rows, newest first. Public read — the dates
 * of past closing auctions are market data, not player data; the page gates
 * the CONTROL to signed-in visitors. Bounded (never more than
 * {@link MAX_DAYS} entries) so a months-old table cannot turn one request
 * into a table scan.
 */
export const prerender = false;

/** The dropdown is a navigation aid, not a data dump — 30 trading days is a
 * month of replay and comfortably beyond what a player would scroll. */
const MAX_DAYS = 30;

export const GET: RequestHandler = async () => {
	const store = getStore();
	const days = await store.ticks.listCasTradeDates(MAX_DAYS);
	return json({ days }, { headers: { 'cache-control': 'public, max-age=60' } });
};
