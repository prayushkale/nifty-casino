/**
 * `getStore()` — the single entry point feature code uses for persistence.
 *
 * Driver selection (deliberately boring):
 *
 *   DATABASE_URL set  → PostgresStore   (production, and any local integration test)
 *   DATABASE_URL unset→ MemoryStore     (tests, `npm run dev`, dry-run scripts)
 *
 * So a fresh clone runs the whole game with zero configuration, and pointing it at a
 * real Postgres is a one-line env change — no code path forks anywhere else. Supabase
 * is not consulted here: auth (../supabaseAdmin, ../supabaseBrowser) has its own env
 * vars and its own fallback, because game math must work without it and auth must not.
 *
 * `process.env` rather than `$env/dynamic/private` on purpose: the dry-run and load
 * scripts (PLAN T17) run under plain tsx, where the SvelteKit virtual modules do not
 * exist. Both read the same value in dev and under adapter-node.
 *
 * The singleton is process-wide (one pool per app instance). `resetStoreForTests`
 * drops it — tests only.
 */
import { MemoryStore } from './memory';
import { PostgresStore, maskDatabaseUrl } from './postgres';
import type { GameStore } from './interface';

export type { GameStore, TxStore } from './interface';
export {
	AlreadySettledError,
	BetExistsError,
	CutoffPassedError,
	DbError,
	DuplicatePayoutError,
	InsufficientFundsError,
	NotFoundError,
	SessionClosedError
} from './interface';
export { MemoryStore } from './memory';
export {
	PostgresStore,
	buildPoolOptions,
	maskDatabaseUrl,
	resolvePrepareFlag,
	resolveSsl
} from './postgres';
export * from './types';

export const DATABASE_URL_ENV_VAR = 'DATABASE_URL';

let store: GameStore | null = null;

export function getStore(): GameStore {
	if (store) return store;
	const url = process.env[DATABASE_URL_ENV_VAR]?.trim();

	// A local binding keeps the narrowing simple and the log next to the choice.
	const next: GameStore = url ? new PostgresStore(url) : new MemoryStore();
	store = next;
	// Once per process — this is the only log that says which driver is live.
	console.info(
		url
			? `[db] driver=postgres ${maskDatabaseUrl(url)}`
			: `[db] driver=memory (ephemeral — set ${DATABASE_URL_ENV_VAR} to persist to Postgres)`
	);
	return next;
}

/** Drop the cached singleton so the next `getStore()` re-selects a driver. Test-only. */
export function resetStoreForTests(): void {
	store = null;
}
