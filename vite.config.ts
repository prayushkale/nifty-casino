import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
	// SvelteKit surfaces `.env` only through its `$env/*` virtual modules;
	// nothing there writes into `process.env`. But the game store reads
	// `process.env.DATABASE_URL` directly (deliberately — the tsx scripts in
	// scripts/ share the same code and cannot import SvelteKit virtual modules),
	// so under a plain `npm run dev` the store would silently fall back to the
	// empty MemoryStore while auth (which reads `$env/dynamic/private`) works —
	// producing 404s like "Nobody at the tables is called …" for rows that exist.
	// Import the `.env` bag into `process.env` here, at config time, so both
	// halves of the app see the same configuration. Shell exports still win:
	// only keys that are not already set are assigned.
	//
	// Vitest must keep its no-DB default: the integration suites are gated on
	// `describe.skipIf(!DATABASE_URL)` and are meant to run only when a developer
	// explicitly exports DATABASE_URL, never via `npm run test`.
	if (process.env.VITEST !== 'true' && mode !== 'test') {
		for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
			if (process.env[key] === undefined) process.env[key] = value;
		}
	}

	return {
		plugins: [sveltekit()],
		test: {
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			globals: true,
			environment: 'node'
		}
	};
});