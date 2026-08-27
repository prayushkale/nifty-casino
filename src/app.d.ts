// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
	namespace App {
		interface Locals {
			/** The user id (uuid) set by auth hooks in `hooks.server.ts`. */
			userId: string | null;
			/** The unique public handle, from the `profiles` row. */
			handle: string | null;
			/** Which session mechanism answered — see $lib/server/auth/session. */
			authSource: 'supabase' | 'dev' | null;
		}
	}
}

export {};
