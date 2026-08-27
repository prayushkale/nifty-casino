import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isDevAuthEnabled } from '$lib/server/auth/devAuth';

/**
 * GET /api/auth/me — the header chrome's single source of truth.
 *
 * `{ authenticated, handle, source, devAuth }`, where `source` says which
 * session mechanism answered ('supabase' | 'dev' | null) and `devAuth` tells
 * the UI whether the unconfigured fallback is what is live — the dev panel on
 * /auth/login is the only thing that branches on it.
 *
 * `no-store`: the answer is per-user, so no CDN or browser cache may keep it.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return json(
		{
			authenticated: locals.userId !== null,
			handle: locals.handle,
			source: locals.userId ? locals.authSource : null,
			devAuth: isDevAuthEnabled()
		},
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};

export const prerender = false;
