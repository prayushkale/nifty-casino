/**
 * GET /api/history — the signed-in player's own bet log, one page at a time.
 * The endpoint "Load more" on `/history` calls; the page's first page comes from
 * its server load, so this route only ever serves pages 2, 3, …
 *
 *   200 { bets: HistoryBet[], nextCursor: { before, beforeId } | null, hasMore }
 *   401 { error: 'UNAUTHENTICATED' }
 *   400 { error: 'INVALID_CURSOR' }
 *
 * CURSOR: `?before=<ISO instant>&beforeId=<bet id>`, both copied from the
 * previous response's `nextCursor`. `before` alone is enough to bound the page,
 * but two bets placed in the same millisecond would straddle a page boundary and
 * one of them would be skipped on the next page — `beforeId` breaks that tie
 * (the keyset walk in `$lib/server/db`), which is why it travels with the
 * timestamp instead of the client re-deriving anything.
 *
 * No `?limit=`: the page size is a product constant (`HISTORY_PAGE_SIZE`), not a
 * knob a client gets to turn — the same reason the leaderboard reads are capped
 * in the driver rather than in the request.
 *
 * `private, no-store`: the answer is per-user, so neither a CDN nor this
 * browser's cache may keep it (the same header `/api/state` sends).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listHistoryPage } from '$lib/server/history';

/** An ISO instant, parsed strictly — a cursor that cannot be read is a 400, not a full table. */
function parseBefore(raw: string | null): number | null | undefined {
	if (raw === null) return undefined;
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? ms : null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.userId) return json({ error: 'UNAUTHENTICATED' }, { status: 401 });

	const before = parseBefore(url.searchParams.get('before'));
	if (before === null) return json({ error: 'INVALID_CURSOR' }, { status: 400 });

	const beforeId = url.searchParams.get('beforeId');
	const page = await listHistoryPage(locals.userId, {
		beforeCreatedAt: before,
		beforeId: beforeId === null || beforeId.trim() === '' ? undefined : beforeId
	});

	return json(page, { headers: { 'cache-control': 'private, no-store' } });
};

export const prerender = false;
