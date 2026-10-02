/**
 * `getStore()` — the single entry point feature code uses for persistence.
 *
 * Driver selection (deliberately boring):
 *
 *   DATABASE_URL set  → PostgresStore   (production, and any local integration test)
 *   NC_DATA_FILE set  → LocalMemoryStore(memory driver, durable to a JSON file — desktop)
 *   neither set       → MemoryStore     (tests, `npm run dev`, dry-run scripts)
 *
 * So a fresh clone runs the whole game with zero configuration, the packaged desktop build
 * keeps its player's wallet across restarts with zero configuration, and pointing either at
 * a real Postgres is a one-line env change — no code path forks anywhere else. Supabase
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
import { createLocalStore, DATA_FILE_ENV_VAR, LocalMemoryStore } from './local-persistence';
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
	LocalMemoryStore,
	SNAPSHOT_VERSION,
	TICK_RETENTION_DAYS,
	createLocalStore,
	trimTicks
} from './local-persistence';
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
	const dataFile = process.env[DATA_FILE_ENV_VAR]?.trim();

	let next: GameStore;
	let source: string;
	if (url) {
		next = new PostgresStore(url);
		source = `[db] driver=postgres ${maskDatabaseUrl(url)}`;
	} else if (dataFile) {
		// The desktop build: memory driver, but the RAM survives a restart because the
		// whole store round-trips through a JSON file. Postgres still wins when both are
		// set, so a packaged build pointed at a real database behaves like production.
		next = createLocalStore(dataFile);
		source = `[db] driver=memory+file (durable — ${dataFile})`;
	} else {
		next = new MemoryStore();
		source = `[db] driver=memory (ephemeral — set ${DATABASE_URL_ENV_VAR} to persist to Postgres)`;
	}

	store = next;
	// Once per process — this is the only log that says which driver is live.
	console.info(source);

	// adapter-node installs its own SIGTERM/SIGINT handler and calls `store.close()` on the
	// graceful path, but an abrupt exit (Task Manager, `kill -9`, a crash) never reaches it.
	// This hook is the backstop: it runs on `exit`, where only synchronous work survives.
	// Registered once per process, and only for a file-backed store — there is nothing to
	// persist otherwise.
	if (next instanceof LocalMemoryStore) {
		process.once('exit', () => next.flushSync());
	}
	return next;
}

/** Drop the cached singleton so the next `getStore()` re-selects a driver. Test-only. */
export function resetStoreForTests(): void {
	// Flush a file-backed store before dropping it, or a test (or a driver swap) would
	// silently discard writes that only ever existed in RAM.
	if (store instanceof LocalMemoryStore) void store.flush();
	store = null;
}
