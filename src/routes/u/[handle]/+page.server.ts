/**
 * `/u/<handle>` — the public profile page's server load (PLAN §5 T10).
 *
 * The whole job is the projection plus the 404: `$lib/server/profile` decides
 * what the world may see, and this file decides that an unknown (or impossible)
 * handle is a page-not-found rather than an empty page. The same payload backs
 * `GET /api/u/<handle>`, so T14's leaderboard links and any client-side refresh
 * see identical numbers.
 *
 * `isSelf` is the one field the JSON endpoint deliberately does not return: it is
 * chrome, not profile, and it only decides whether the header offers the viewer
 * their own `/history` next to the board link (T14 nav wiring). It is derived
 * from the hooks' identity, so it cannot be spoofed by a query param.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { HANDLE_PATTERN } from '$lib/server/auth/handles';
import { buildPublicProfile } from '$lib/server/profile';

export const load: PageServerLoad = async ({ params, locals }) => {
	const handle = (params.handle ?? '').trim().toLowerCase();
	if (!HANDLE_PATTERN.test(handle)) throw error(404, 'No such player');

	const profile = await buildPublicProfile(handle);
	if (!profile) throw error(404, `Nobody at the tables is called “${handle}”`);

	return { profile, isSelf: locals.handle !== null && locals.handle === handle };
};

export const prerender = false;
