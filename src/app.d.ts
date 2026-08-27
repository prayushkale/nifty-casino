// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
	namespace App {
		/** The user id (uuid) set by auth hooks in `hooks.server.ts`. */
		interface Locals {
			userId: string | null;
			handle: string | null;
		}
	}
}

export {};
