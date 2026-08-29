/**
 * `/history` — the player's own bet log (PLAN §5 T14).
 *
 * AUTH REQUIRED, and the redirect happens here rather than in the page: an
 * anonymous visitor has no log to show, so `/history` is a login redirect and
 * not an empty screen (the same rule `/auth/confirm` follows). The server load
 * is also what keeps the log off the wire for a signed-out browser entirely.
 *
 * Everything the page renders comes from `$lib/server/history`, which is the one
 * projection both this load and `GET /api/history` serve — "Load more" then asks
 * the API for the page after the one the SSR already delivered and the two can
 * never disagree about what a row looks like.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { buildHistoryTotals, listHistoryPage } from '$lib/server/history';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) redirect(303, '/auth/login');

	const [totals, page] = await Promise.all([
		buildHistoryTotals(locals.userId),
		listHistoryPage(locals.userId)
	]);

	return { totals, page };
};

export const prerender = false;
