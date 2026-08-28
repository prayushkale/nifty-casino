/**
 * Server hooks — identity resolution for every request (PLAN T6), plus the
 * server-side scraper (PLAN T4).
 *
 * The identity half stays three lines: all the decisions live in
 * `$lib/server/auth/session`, which is unit-testable without SvelteKit. After
 * this runs, every route and load function reads `locals.userId` /
 * `locals.handle` / `locals.authSource` and never touches a cookie or Supabase.
 *
 * The poller starts at import time, not on the first request, so the feed is
 * warm before anyone opens the site. `startCasPoller()` only sets a timer and
 * returns — it is fire-and-forget, awaits nothing, and never throws, so it can
 * never slow or break request handling. Its `globalThis` guard makes the
 * dev-HMR re-execution of this module a no-op instead of a second scraper; the
 * `VITEST` guard keeps it out of the test run entirely.
 */
import type { Handle } from '@sveltejs/kit';
import { startCasPoller } from '$lib/server/cas-poller';
import { resolveIdentity } from '$lib/server/auth/session';

void startCasPoller();

export const handle: Handle = async ({ event, resolve }) => {
	const identity = await resolveIdentity(event);
	event.locals.userId = identity.userId;
	event.locals.handle = identity.handle;
	event.locals.authSource = identity.source;
	return resolve(event);
};
