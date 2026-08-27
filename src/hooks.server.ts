/**
 * Server hooks — identity resolution for every request (PLAN T6).
 *
 * Kept to three lines on purpose: all the decisions live in
 * `$lib/server/auth/session`, which is unit-testable without SvelteKit. After
 * this runs, every route and load function reads `locals.userId` /
 * `locals.handle` / `locals.authSource` and never touches a cookie or Supabase.
 */
import type { Handle } from '@sveltejs/kit';
import { resolveIdentity } from '$lib/server/auth/session';

export const handle: Handle = async ({ event, resolve }) => {
	const identity = await resolveIdentity(event);
	event.locals.userId = identity.userId;
	event.locals.handle = identity.handle;
	event.locals.authSource = identity.source;
	return resolve(event);
};
