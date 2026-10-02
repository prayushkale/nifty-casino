/**
 * Local, durable persistence for the desktop build.
 *
 * The desktop app runs on the memory driver with no Postgres and no `.env` — zero setup
 * is the whole point. But a bare {@link MemoryStore} dies with the process, so a player
 * would lose their 1,000 NC signup bonus and their balance every time they quit. This
 * subclass gives that driver a file.
 *
 * How it works, and why it is this cheap:
 *
 * - `MemoryStore` already deep-clones every table into a JSON-native {@link MemorySnapshot}
 *   on each transaction (that is what makes rollback real), and every row type in ./types.ts
 *   is `string | number | null` by design. So persistence is "take the snapshot the class
 *   already knows how to take" — not a second serialization model.
 *
 * Two interception points, because writes arrive by two different routes:
 *
 * 1. **Transactions.** `placeBet` and `settleBets` both funnel through `tx()`, so committing
 *    a transaction marks the store dirty. That covers every money path.
 * 2. **Direct repo calls.** Not everything goes through a transaction — the CAS poller writes
 *    its tick archive with a bare `store.ticks.insertCasTicks(rows)` (cas-poller.ts), and the
 *    poller deliberately does NOT roll that back, because the tick is already in RAM and the
 *    archive is a retry-able copy. Intercepting only `tx()` would therefore drop the entire
 *    tick history. So each repository is wrapped and marks the store dirty on any write.
 *
 *    `WRITE_METHODS` below is an explicit list, and `local-persistence.test.ts` asserts that
 *    every method on every repo is accounted for as either a write or a read — so adding a
 *    write to the interface without adding it here fails the suite instead of silently
 *    losing data.
 *
 * Deliberate limitations, stated rather than papered over:
 *
 * - **Single process, single file.** Two stores on one file would interleave writes. The
 *   Electron main process takes a single-instance lock for exactly this reason.
 * - **Debounced, not transactional.** A crash mid-session can lose the last few hundred
 *   milliseconds of bets. This is play money, and an fsync per bet is not worth the cost.
 *   A graceful quit (closing the window, `SIGTERM`, Task Manager "End task") always
 *   persists: the debounce is forced by both `getStore()`'s `exit` hook and the Electron
 *   main process's graceful shutdown. A hard `SIGKILL`/power cut cannot be intercepted by
 *   anything in the process, so anything written less than ~400ms before it is lost.
 * - **Atomic by rename.** Writes go to a sibling `.tmp` and are renamed over the target, so
 *   a crash can never leave a half-written wallet file — the failure mode is "slightly
 *   stale", never "corrupt".
 * - **Version-stamped, and lenient on mismatch.** A payload we do not recognise starts the
 *   store empty rather than throwing, because a corrupt file must not stop the app booting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore, type MemorySnapshot } from './memory';
import type {
	BetRepo,
	CloseRepo,
	LedgerRepo,
	PotRepo,
	ProfileRepo,
	SessionRepo,
	StatsRepo,
	TickRepo,
	TxStore
} from './interface';

/** Env var that opts the memory driver into file persistence. */
export const DATA_FILE_ENV_VAR = 'NC_DATA_FILE';

/** Bumped whenever {@link MemorySnapshot} changes shape; older payloads start empty. */
export const SNAPSHOT_VERSION = 1;

/** Debounce before a committed write is pushed to disk. */
const FLUSH_DEBOUNCE_MS = 400;

/**
 * How many trading days of raw `cas_ticks` survive in the data file.
 *
 * The memory driver has no partition maintenance, so `ticksByKey` grows without bound — a
 * live session adds a tick every 2s for ~28 minutes, every weekday, forever. Postgres caps
 * this with monthly partitions and a retention drop (scripts/partitions.ts); here the cap is
 * simply "keep the recent past". Charts rebuild from a full `/api/cas/all` snapshot on load,
 * so an old day simply charts cold after a long absence — correct, not broken.
 */
export const TICK_RETENTION_DAYS = 10;

/**
 * Every mutating method on {@link TxStore}, per repository.
 *
 * Kept explicit rather than inferred from a name prefix, because "does this method write?"
 * is a question about intent, not spelling — `ensureSession` writes, `getSessionByDate`
 * reads, and neither name says which.
 *
 * The read half lives in `READ_METHODS`. Together they must describe every method on every
 * repository exactly, which `local-persistence.test.ts` asserts: a write added to the
 * interface and forgotten here would silently stop being persisted, so it fails the suite
 * instead.
 */
export const WRITE_METHODS: Readonly<Record<keyof TxStore, readonly string[]>> = {
	sessions: ['ensureSession', 'setSessionStatus', 'setSessionStatusIf'],
	profiles: ['insertProfile', 'setHandle', 'applyBalanceDelta', 'applyProfileProgress'],
	bets: ['upsertBet', 'deleteBet', 'setBetOutcome'],
	pots: ['ensureDailyPot', 'applyPotDelta'],
	stats: ['applyStatsDelta'],
	ledger: ['appendLedger'],
	ticks: ['insertCasTicks'],
	closes: ['upsertIndexClose', 'upsertIndexCloseIfAbsent', 'upsertIndexLtpAnchor']
};

/** Methods that only read. Listed so the classification above can be proved complete. */
export const READ_METHODS: Readonly<Record<keyof TxStore, readonly string[]>> = {
	sessions: ['getSessionByDate', 'getSessionById'],
	profiles: [
		'getProfile',
		'getProfileByHandle',
		'listProfilesByHandles',
		'listTopBalances',
		'listTopStreaks',
		// A plain read on this driver — the row lock is what the memory mutex in tx()
		// stands in for (memory.ts documents this).
		'lockForUpdate'
	],
	bets: [
		'getBetById',
		'getBetsForUserOnDate',
		'listRecentSettledBets',
		'listTopWinsForDate',
		'listBetsForUserPage',
		'listBetsForSession'
	],
	pots: ['getDailyPot'],
	stats: ['getUserStats'],
	ledger: ['getLedgerForUser', 'hasPayoutForBet'],
	ticks: ['getCasTicksRange', 'latestCasTradeDate', 'listCasTradeDates'],
	closes: ['getIndexCloses', 'getLatestCloseBefore']
};

type Envelope = {
	v: number;
	savedAt: number;
	store: MemorySnapshot;
};

export type LocalStoreOptions = {
	/** Absolute path to the JSON data file. */
	file: string;
	/** Override the debounce (tests want it at 0). */
	flushDebounceMs?: number;
	/** Injectable clock, so `savedAt` is deterministic under test. */
	now?: () => number;
};

export class LocalMemoryStore extends MemoryStore {
	private readonly file: string;
	private readonly debounceMs: number;
	private readonly clock: () => number;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pending: Promise<void> | null = null;
	private dirty = false;
	/** Memoised per repo so `store.bets` keeps a stable identity across calls. */
	private readonly views = new Map<keyof TxStore, TxStore[keyof TxStore]>();

	constructor(options: LocalStoreOptions) {
		super();
		this.file = options.file;
		this.debounceMs = options.flushDebounceMs ?? FLUSH_DEBOUNCE_MS;
		this.clock = options.now ?? Date.now;

		const restored = readEnvelope(this.file);
		if (restored) this.importSnapshot(restored);
	}

	/**
	 * A committed transaction means the store changed; a throwing one was rolled back by
	 * `super.tx()` before the error reached us, so it schedules nothing.
	 */
	override async tx<T>(fn: (tx: TxStore) => Promise<T>): Promise<T> {
		const result = await super.tx((t) => fn(wrapTxStore(t, this)));
		this.markDirty();
		return result;
	}

	/**
	 * Flush synchronously, from a process-exit hook.
	 *
	 * Deliberately synchronous rather than async, because exit hooks have no time left to
	 * await: `process.on('exit')` only runs while the event loop is still alive, so a
	 * Promise-based write would be discarded and the player would lose whatever the
	 * debounce had not yet flushed.
	 */
	flushSync(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (!this.dirty) return;
		this.dirty = false;
		try {
			writeEnvelope(this.file, this.exportSnapshot(), this.clock());
		} catch (err: unknown) {
			console.error(`[db] could not write ${this.file}:`, err);
		}
	}

	/** Force any pending write out now. Used on shutdown and by tests. */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (!this.dirty) return this.pending ?? Promise.resolve();

		// Serialise writes: a burst of bets must not interleave rename()s.
		const run = (this.pending ?? Promise.resolve()).then(() => {
			this.dirty = false;
			writeEnvelope(this.file, this.exportSnapshot(), this.clock());
		});
		this.pending = run.catch(() => {});
		return run;
	}

	// -- repositories, wrapped so direct writes persist too ---------------------------
	//
	// Only the public getters are overridden. `tx()` wraps its own TxStore above, because
	// MemoryStore's internal `asTxStore()` hands out the raw repo objects.

	override get sessions(): SessionRepo {
		return this.wrapped('sessions', this.sessionRepo);
	}
	override get profiles(): ProfileRepo {
		return this.wrapped('profiles', this.profileRepo);
	}
	override get bets(): BetRepo {
		return this.wrapped('bets', this.betRepo);
	}
	override get pots(): PotRepo {
		return this.wrapped('pots', this.potRepo);
	}
	override get stats(): StatsRepo {
		return this.wrapped('stats', this.statsRepo);
	}
	override get ledger(): LedgerRepo {
		return this.wrapped('ledger', this.ledgerRepo);
	}
	override get ticks(): TickRepo {
		return this.wrapped('ticks', this.tickRepo);
	}
	override get closes(): CloseRepo {
		return this.wrapped('closes', this.closeRepo);
	}

	/**
	 * Return a view of `repo` whose write methods mark this store dirty, memoised so
	 * `store.bets` keeps a stable identity across calls. Reads pass straight through, so
	 * `/api/state` polling never touches the disk.
	 *
	 * Internal rather than private: the module-level `wrapTxStore` needs it for the
	 * transaction-scoped store, which is the same set of views.
	 */
	wrapped<K extends keyof TxStore>(name: K, repo: TxStore[K]): TxStore[K] {
		const existing = this.views.get(name);
		if (existing) return existing as TxStore[K];

		const writes = new Set<string>(WRITE_METHODS[name]);
		const view = Object.create(repo) as Record<string, unknown>;
		for (const method of Object.keys(repo)) {
			const fn = (repo as unknown as Record<string, unknown>)[method];
			if (typeof fn !== 'function' || !writes.has(method)) continue;
			view[method] = (...args: unknown[]) => {
				// Call through to the original with the real repo as `this` — Object.create
				// gives the view a prototype, not an own copy, of the arrow-function repos.
				const result = (fn as (...a: unknown[]) => unknown).apply(repo, args);
				// Mark dirty only once the write resolves; a rejected write changed nothing.
				return Promise.resolve(result).then((value) => {
					this.markDirty();
					return value;
				});
			};
		}

		this.views.set(name, view as TxStore[keyof TxStore]);
		return view as TxStore[K];
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.flushTimer) return; // an already-armed timer will pick this write up
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush().catch((err: unknown) => {
				console.error(`[db] could not write ${this.file}:`, err);
			});
		}, this.debounceMs);
		// Never hold the process open just to persist a bet.
		this.flushTimer.unref?.();
	}
}

/**
 * Wrap every repository in a transaction-scoped {@link TxStore}.
 *
 * `MemoryStore.tx()` hands its callback the raw repo objects via `asTxStore()`, and code
 * inside a transaction legitimately calls those directly (`t.bets.upsertBet(...)`). Those
 * writes still need to mark the store dirty, so the TxStore handed to the callback is
 * itself a set of wrapped views — the same ones the public getters return.
 */
function wrapTxStore(tx: TxStore, store: LocalMemoryStore): TxStore {
	return {
		sessions: store.wrapped('sessions', tx.sessions),
		profiles: store.wrapped('profiles', tx.profiles),
		bets: store.wrapped('bets', tx.bets),
		pots: store.wrapped('pots', tx.pots),
		stats: store.wrapped('stats', tx.stats),
		ledger: store.wrapped('ledger', tx.ledger),
		ticks: store.wrapped('ticks', tx.ticks),
		closes: store.wrapped('closes', tx.closes)
	};
}

/** Trim per-day tick lists down to the most recent {@link TICK_RETENTION_DAYS} days. */
export function trimTicks(snapshot: MemorySnapshot, keepDays = TICK_RETENTION_DAYS): void {
	if (snapshot.ticks.length <= keepDays) return;
	const sorted = [...snapshot.ticks].sort((a, b) => a[0].localeCompare(b[0]));
	snapshot.ticks = sorted.slice(-keepDays);
}

function writeEnvelope(file: string, store: MemorySnapshot, savedAt: number): void {
	trimTicks(store);
	const payload: Envelope = { v: SNAPSHOT_VERSION, savedAt, store };
	const json = JSON.stringify(payload);

	mkdirSync(dirname(file), { recursive: true });
	// Write-then-rename: the target is either the old file or the new one, never a splice
	// of the two. The temp sits beside the target so the rename stays on one filesystem.
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, json);
	renameSync(tmp, file);
}

/** Returns the stored snapshot, or null when absent, unreadable or from a future version. */
function readEnvelope(file: string): MemorySnapshot | null {
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return null; // no file yet — the normal first-run case
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn(`[db] ${file} is not valid JSON — starting with an empty store`);
		return null;
	}

	if (!isEnvelope(parsed)) {
		console.warn(`[db] ${file} is not a recognised store file — starting with an empty store`);
		return null;
	}
	if (parsed.v > SNAPSHOT_VERSION) {
		console.warn(
			`[db] ${file} was written by a newer build (v${parsed.v} > v${SNAPSHOT_VERSION}) — starting with an empty store`
		);
		return null;
	}
	return parsed.store;
}

function isEnvelope(value: unknown): value is Envelope {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<Envelope>;
	return (
		typeof candidate.v === 'number' && typeof candidate.savedAt === 'number' && !!candidate.store
	);
}

/**
 * Build a memory store backed by a file.
 *
 * Used by `getStore()` only when `NC_DATA_FILE` is set and `DATABASE_URL` is not.
 */
export function createLocalStore(
	file: string,
	options: Omit<LocalStoreOptions, 'file'> = {}
): LocalMemoryStore {
	return new LocalMemoryStore({ ...options, file });
}
