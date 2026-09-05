/**
 * scripts/dry-run-day.ts — a whole fake trading day, end to end, on the ACTIVE store.
 * This is the money-path proof behind docs/RUNBOOK.md → "Manual settle" and the
 * "Settlement credits consistent" line of the pre-launch checklist (PLAN §8).
 *
 *   npx tsx scripts/dry-run-day.ts --users 25
 *   npx tsx scripts/dry-run-day.ts --users 3 --seed 7      # twice → identical output
 *   npx tsx scripts/dry-run-day.ts --users 2000            # settlement-burst drill (R7)
 *   npx tsx scripts/dry-run-day.ts --date 2026-08-27 --yes # a free past day, real Postgres
 *
 * THE DAY, IN ORDER — the same shape a real one takes, minus the feed:
 *
 *   1. session      ensureSession(date, 15:20:00 IST of that date)
 *   2. wallets      N users provisioned row-for-row like `handle_new_user()`:
 *                   profile(1,000 NC) + signup_bonus ledger row + zeroed user_stats
 *   3. anchors      index_closes for the PREVIOUS trading day, source 'official' —
 *                   the rows both the ladder and the settlement engine hang off
 *   4. bets         1–3 per user through the DRIVER money path (`store.placeBet`),
 *                   each judged at an in-window `nowMs` so the cutoff gate is real
 *   5. closes       today's FAKE official closes, one scenario per index, chosen to
 *                   land one index in the dead zone (flat), one past every rung
 *                   (miss) and one on a rung (hit)
 *   6. settle       `settleNow(store, date, { capture: false })` — the production
 *                   path, capture off because the closes are already on disk
 *   7. the arc      start → staked → hit/flat/miss → credited → final, per user
 *   8. re-settle    a second `settleNow` plus a raw chunk replay, both asserted to
 *                   be a numeric no-op (the §8 "re-settle is a no-op" item)
 *
 * THE INVARIANTS (any failure exits 1):
 *
 *   I1  Σ(ledger) == balance AND Σ(ledger) − the +1,000 signup row == balance − 1,000
 *       (the form PLAN §8 words it in) — for every wallet in the day, not a sample
 *   I2  replaying a user's ledger in id order reproduces the final balance, never
 *       dips below zero, and every row's balance_after matches the running total
 *   I3  every bet is settled exactly once, with payout == payoutFor(tier, stake, odds)
 *   I4  every bet's verdict equals computeTier(bet, anchor, close) — the engine's
 *       wiring checked against the same pure rulebook the browser previews with
 *   I5  the pots ARE the bets: total_bets, total_staked, total_paid_out, players_count
 *   I6  every bet's odds equal today's ladder odds (nothing invented at placement)
 *   I7  the re-settle touches nothing (I7a a second settleNow, I7b the same chunk
 *       handed straight back to the driver's money path)
 *
 * STORE SELECTION: `getStore()` — the memory driver unless DATABASE_URL is set. A
 * memory run is free and ephemeral, so it is the default and needs no flag. A real
 * Postgres is written for real, so it REQUIRES `--yes`, prints what it will write
 * first, and refuses a date that already has a session or official closes — a drill
 * must never trample a day that actually happened. Handles are namespaced by
 * `--date` + `--seed`, so two drills can never claim each other's wallets.
 *
 * Exit codes: 0 = INVARIANTS OK. 1 = refused, or an invariant failed — a CI/cron
 * caller should treat that as a red light, not a warning.
 */
import { CUTOFF_HMS, SETTLE_CHUNK, SETTLE_START_HMS, SIGNUP_BONUS } from '$lib/config/app';
import {
	LADDER_CONFIG,
	LADDER_UNDERLYINGS,
	type LadderOption,
	type LadderUnderlying
} from '$lib/config/ladder';
import { computeTier, hitAccuracy, payoutFor, type PayableTier } from '$lib/game/tier';
import { DbError, getStore, resetStoreForTests, type GameStore } from '$lib/server/db';
import type { Bet, DailyPot, IndexClose, LedgerEntry, Profile } from '$lib/server/db/types';
import { getLadderForDate, invalidateLadderCache, resolveLadderOption } from '$lib/server/ladder';
import { prevTradingDay } from '$lib/server/settle/engine';
import { settleNow } from '$lib/server/settle/scheduler';
import { isWeekend, istDateStr, istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

type Args = {
	users: number;
	tradeDate: string;
	seed: number;
	yes: boolean;
	verbose: boolean;
	chunkSize: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SEED = 20260829;
const DEFAULT_USERS = 25;
const MAX_USERS = 50_000;

/** Stake pool and how often each size shows up — a wallet, not a whale. */
const STAKE_POOL: readonly { stake: number; weight: number }[] = [
	{ stake: 10, weight: 3 },
	{ stake: 25, weight: 3 },
	{ stake: 50, weight: 3 },
	{ stake: 100, weight: 3 },
	{ stake: 200, weight: 2 },
	{ stake: 500, weight: 1 }
];

function usage(): string {
	return [
		'Usage: npx tsx scripts/dry-run-day.ts [--users N] [--date YYYY-MM-DD] [--seed S] [--yes]',
		'',
		'  --users N           Virtual players to provision (default ' +
			DEFAULT_USERS +
			', max ' +
			MAX_USERS +
			').',
		'  --date YYYY-MM-DD   IST trade date to simulate (default: today). A weekend date is',
		'                      allowed — the engine needs closes, not a live market.',
		'  --seed S            RNG seed (default ' +
			DEFAULT_SEED +
			'). The same seed produces the same day.',
		'  --chunk-size N      Bets per settlement transaction (default ' +
			SETTLE_CHUNK +
			'). Set it low to',
		'                      watch one day split across several chunks (PLAN §6 R7).',
		'  --verbose           One line per bet on top of the per-user arc. Implied at ≤5 users.',
		'  --yes               Required when DATABASE_URL is set: this writes real rows.',
		'',
		'Store: DATABASE_URL set → Postgres (real writes, needs --yes); unset → memory',
		'(ephemeral — the default, and the safe drill). See docs/RUNBOOK.md → "Manual settle".'
	].join('\n');
}

/** A usage message is not a stack trace — carried out of band, printed without one. */
class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		users: DEFAULT_USERS,
		tradeDate: istDateStr(),
		seed: DEFAULT_SEED,
		yes: false,
		verbose: false,
		chunkSize: SETTLE_CHUNK
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (name: string): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
			i += 1;
			return next;
		};
		const int = (name: string, raw: string): number => {
			const parsed = Number(raw);
			if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer (got "${raw}")`);
			return parsed;
		};
		if (arg === '--users') args.users = int(arg, value(arg));
		else if (arg === '--date') args.tradeDate = value(arg);
		else if (arg === '--seed') args.seed = int(arg, value(arg));
		else if (arg === '--chunk-size') args.chunkSize = int(arg, value(arg));
		else if (arg === '--yes') args.yes = true;
		else if (arg === '--verbose') args.verbose = true;
		else if (arg === '--help' || arg === '-h') throw new UsageError(usage());
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (!isRealCalendarDate(args.tradeDate)) {
		throw new Error(`--date must be a real YYYY-MM-DD calendar date (got "${args.tradeDate}")`);
	}
	if (args.users < 1 || args.users > MAX_USERS) {
		throw new Error(`--users must be an integer in 1..${MAX_USERS} (got ${args.users})`);
	}
	if (args.seed < 0) throw new Error(`--seed must be a non-negative integer (got ${args.seed})`);
	if (args.chunkSize < 1)
		throw new Error(`--chunk-size must be a positive integer (got ${args.chunkSize})`);
	return args;
}

/** 15:20:00 IST of `tradeDate`, in epoch ms — what `daily_sessions.cutoff_at` holds. */
function cutoffMsFor(tradeDate: string): number {
	return istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), CUTOFF_HMS);
}

/**
 * 15:30:00 IST of `tradeDate` — the instant this fake day is settled at.
 */
function settleMsFor(tradeDate: string): number {
	return istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), SETTLE_START_HMS);
}

/**
 * Shape AND reality check: `istDateStrToMidnightUtcMs` throws on a date like
 * 2026-02-30, and a thrown date-parse error reads worse than a refusal.
 */
function isRealCalendarDate(dateStr: string): boolean {
	if (!DATE_RE.test(dateStr)) return false;
	try {
		istDateStrToMidnightUtcMs(dateStr);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

/** mulberry32 — 32-bit, tiny, fully reproducible (the same generator simulate-ev.ts uses). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A wallet handle namespaced by date + seed, so two drills against one real Postgres
 * can never claim each other's names — and a re-run of the SAME command is caught by
 * the session guard long before it reaches a duplicate handle.
 */
function handleFor(tradeDate: string, seed: number, n: number): string {
	const mmdd = tradeDate.slice(5, 7) + tradeDate.slice(8, 10);
	let handle = `d${mmdd}s${seed % 1_000_000}u${String(n).padStart(4, '0')}`;
	if (handle.length > 20) handle = `d${mmdd}s${seed % 1000}u${String(n).padStart(4, '0')}`;
	return handle.slice(0, 20);
}

// ---------------------------------------------------------------------------
// the fake day's market data
// ---------------------------------------------------------------------------

/** Plausible launch anchors (PLAN §0.1), jittered ±1% by the seed so runs differ. */
const PLAUSIBLE_ANCHORS: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

/** What one index's fake close is meant to prove about the rulebook. */
type Scenario = PayableTier; // 'hit' | 'flat' | 'miss'
const SCENARIOS: readonly Scenario[] = ['hit', 'flat', 'miss'];

/** The close one index lands on, as an offset from ITS anchor, in points. */
type ClosePlan = { scenario: Scenario; delta: number };

/**
 * One scenario per index, seed-rotated, so every run exercises all three tiers and
 * different seeds move different indices:
 *
 *   hit  — ON a rung (inside the tolerance band): bets that called that rung in that
 *          direction hit, every other bet on the index misses;
 *   flat — strictly inside the dead zone: every bet on the index refunds 1×;
 *   miss — past the widest rung by 2–4 tolerances: nothing on the index can hit.
 *
 * Every Δ is a plausible day's move (well inside SEBI's ±3% CAS band), so the drill
 * reads like a real day rather than a stress test.
 */
function plannedCloses(rng: () => number): Record<LadderUnderlying, ClosePlan> {
	const offset = Math.floor(rng() * SCENARIOS.length);
	return {
		nifty: planIndex(SCENARIOS[offset % SCENARIOS.length] as Scenario, 'nifty', rng),
		banknifty: planIndex(SCENARIOS[(offset + 1) % SCENARIOS.length] as Scenario, 'banknifty', rng),
		sensex: planIndex(SCENARIOS[(offset + 2) % SCENARIOS.length] as Scenario, 'sensex', rng)
	};
}

function planIndex(scenario: Scenario, underlying: LadderUnderlying, rng: () => number): ClosePlan {
	const { steps, tolerancePts } = LADDER_CONFIG[underlying];
	const sign = rng() < 0.5 ? 1 : -1;

	if (scenario === 'flat') {
		// |Δ| < half the smallest step — computeTier checks the dead zone BEFORE
		// direction, so every bet on this index refunds whatever it called.
		return { scenario, delta: round2(sign * rng() * (steps[0] / 2 - 1)) };
	}
	if (scenario === 'miss') {
		// Past the widest rung by 2–4 tolerance bands: no bet is inside its band and |Δ|
		// is far outside the dead zone, so the verdict is a full loss everywhere.
		const widest = steps[steps.length - 1];
		return { scenario, delta: round2(sign * (widest + (2 + rng() * 2) * tolerancePts)) };
	}
	// hit: on a rung, inside the band, in whichever direction the RNG picks. The
	// jitter stays at 0.9× the tolerance so the rung is never on the inclusive edge.
	const step = steps[Math.floor(rng() * steps.length)];
	return { scenario, delta: round2(sign * (step + (rng() * 2 - 1) * tolerancePts * 0.9)) };
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

const TAG = '[dry-run-day]';

function padEndStr(value: string, width: number): string {
	return value.length >= width ? value : value + ' '.repeat(width - value.length);
}
function padStartStr(value: string, width: number): string {
	return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}
function num(value: number, width: number): string {
	return padStartStr(String(value), width);
}
function signed(value: number, width: number): string {
	return padStartStr((value >= 0 ? '+' : '') + value.toFixed(2), width);
}

const TIER_TAG: Record<Scenario, string> = { hit: 'HIT ', flat: 'FLAT', miss: 'MISS' };

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

type Wallet = { userId: string; handle: string };

/** Everything read back off the store after settlement — the arc and the invariants' input. */
type UserRow = {
	handle: string;
	profile: Profile;
	ledger: LedgerEntry[];
	staked: number;
	credited: number;
	tiers: Record<Scenario, number>;
	ledgerSum: number;
};

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err: unknown) {
		const isUsage = err instanceof UsageError;
		console.error(`${TAG} ${(err as Error).message}`);
		if (!isUsage) console.error(`\n${usage()}`);
		// `--help` is a success, not a failure.
		return isUsage ? 0 : 1;
	}

	const { tradeDate, users: userCount, seed, chunkSize } = args;
	const verbose = args.verbose || userCount <= 5;
	const cutoffAtMs = cutoffMsFor(tradeDate);
	const settleAtMs = settleMsFor(tradeDate);
	const prevDay = prevTradingDay(tradeDate);
	const isRealStore = Boolean(process.env['DATABASE_URL']?.trim());

	console.info(
		`${TAG} date=${tradeDate}${isWeekend(tradeDate) ? ' (WEEKEND)' : ''}` +
			` prevTradingDay=${prevDay ?? 'NONE'}` +
			` cutoff=${new Date(cutoffAtMs).toISOString()}` +
			` settleAt=${new Date(settleAtMs).toISOString()}` +
			` users=${userCount} seed=${seed} chunk=${chunkSize}` +
			` driver=${isRealStore ? 'postgres' : 'memory'}${args.yes ? ' --yes' : ''}`
	);
	if (prevDay === null) {
		console.error(
			`${TAG} no previous trading day inside the lookback window — no anchor, no ladder, no bets.`
		);
		return 1;
	}

	// -- the real-store gate, BEFORE the store is opened, so a refusal is a refusal
	// and never a half-run that dies on a connection -----------------------------
	if (isRealStore) {
		console.warn(
			`${TAG} DATABASE_URL is set: this drill WRITES REAL ROWS — ${userCount} profile(s),` +
				` ${userCount} signup ledger row(s), ${userCount} user_stats row(s), 1 daily_sessions row,` +
				` ${LADDER_UNDERLYINGS.length} index_closes for ${prevDay} (the ladder anchors) + ` +
				`${LADDER_UNDERLYINGS.length} FAKE official closes for ${tradeDate}, then the bets, pots,` +
				' payouts and XP those bets produce.'
		);
		if (!args.yes) {
			console.error(
				`${TAG} REFUSED: DATABASE_URL is set and --yes was not passed. Re-run with --yes to write for` +
					' real, or unset DATABASE_URL to drill against the ephemeral memory store.'
			);
			return 1;
		}
	}

	const store = getStore();

	// -- pre-flight: never trample a day that already exists ----------------------
	const existingSession = await store.sessions.getSessionByDate(tradeDate);
	if (existingSession && existingSession.status !== 'open') {
		console.error(
			`${TAG} REFUSED: ${tradeDate} already has a ${existingSession.status} session. A drill needs a` +
				' free date — pick another --date. (Memory-driver runs never see this: they start empty.)'
		);
		return 1;
	}
	const existingBets = existingSession
		? await store.bets.listBetsForSession(existingSession.id)
		: [];
	if (existingBets.length > 0) {
		console.error(
			`${TAG} REFUSED: ${tradeDate} already holds ${existingBets.length} bet(s). Settling over them` +
				' would pay wallets that are not part of this drill — pick another --date.'
		);
		return 1;
	}
	const existingCloses = await store.closes.getIndexCloses(tradeDate);
	if (existingCloses.length > 0) {
		console.error(
			`${TAG} REFUSED: ${tradeDate} already has index_closes (${existingCloses
				.map((row) => `${row.underlying}:${row.close}/${row.source}`)
				.join(
					', '
				)}). This script writes FAKE official closes and would overwrite them — pick another --date.`
		);
		return 1;
	}
	const anchorRows = await store.closes.getIndexCloses(prevDay);
	if (anchorRows.some((row) => row.source === 'official')) {
		console.error(
			`${TAG} REFUSED: ${prevDay} already has an official close — that is REAL settlement data, and` +
				' this drill would overwrite the anchor every ladder and payout hangs off. Pick a free --date.'
		);
		return 1;
	}

	// 1–2. Session + wallets ------------------------------------------------------
	// The memory driver clones every table on every transaction, so a big drill pays
	// O(bets) per placement. That is the driver, not the engine — say so once.
	if (!isRealStore && userCount > 500) {
		console.info(
			`${TAG} note: the memory driver snapshots every table per transaction, so ${userCount} wallet(s)` +
				' will take a while. A settlement-burst number belongs on Postgres (--yes + DATABASE_URL).'
		);
	}
	const session = await store.sessions.ensureSession(tradeDate, cutoffAtMs);
	const rng = mulberry32(seed);
	const wallets: Wallet[] = [];

	for (let n = 1; n <= userCount; n += 1) {
		const userId = crypto.randomUUID();
		const handle = handleFor(tradeDate, seed, n);
		try {
			// Row-for-row the same unit of work `handle_new_user()` (migration 0002) and
			// `ensureDevProfile` run: profile + signup ledger row + zeroed stats, ONE tx.
			await store.tx(async (t) => {
				// Re-checked inside the tx, as the signup flow does, so two concurrent
				// drills cannot both claim a name; the unique index is the final word.
				if ((await t.profiles.getProfileByHandle(handle)) !== null) {
					throw new DbError(`handle "${handle}" is taken`, 'DUPLICATE_HANDLE');
				}
				await t.profiles.insertProfile({
					userId,
					handle,
					email: `${handle}@dry-run.invalid`,
					balance: SIGNUP_BONUS
				});
				await t.ledger.appendLedger({
					userId,
					kind: 'signup_bonus',
					amount: SIGNUP_BONUS,
					refBetId: null,
					balanceAfter: SIGNUP_BONUS
				});
				await t.stats.applyStatsDelta(userId, {}); // creates the zeroed stats row
				return userId;
			});
		} catch (err: unknown) {
			if (err instanceof DbError && err.code === 'DUPLICATE_HANDLE') {
				console.error(
					`${TAG} REFUSED: handle "${handle}" already exists in this store — a previous drill left` +
						' wallets behind. Use a different --seed or --date.'
				);
				return 1;
			}
			throw err;
		}
		wallets.push({ userId, handle });
	}
	console.info(
		`${TAG} session id=${session.id} status=${session.status}; ${wallets.length} wallet(s) provisioned at ${SIGNUP_BONUS} NC`
	);

	// 3. Anchors — the previous trading day's official closes --------------------
	const anchors: Record<LadderUnderlying, number> = {
		nifty: round2(PLAUSIBLE_ANCHORS.nifty * (1 + (rng() * 2 - 1) * 0.01)),
		banknifty: round2(PLAUSIBLE_ANCHORS.banknifty * (1 + (rng() * 2 - 1) * 0.01)),
		sensex: round2(PLAUSIBLE_ANCHORS.sensex * (1 + (rng() * 2 - 1) * 0.01))
	};
	for (const underlying of LADDER_UNDERLYINGS) {
		await store.closes.upsertIndexClose({
			tradeDate: prevDay,
			underlying,
			close: anchors[underlying],
			source: 'official'
		});
	}
	// The anchors changed behind the ladder's back — exactly what T9 clears the cache for.
	invalidateLadderCache();

	// 4. Bets — through the DRIVER money path, judged inside the window ----------
	const ladder = await getLadderForDate(store, tradeDate);
	const options = ladder.options;
	if (options.length === 0) {
		console.error(
			`${TAG} the ladder came back empty — no anchor was usable. Aborting before any bet.`
		);
		return 1;
	}

	const plans = plannedCloses(rng);
	const hitIndex = LADDER_UNDERLYINGS.find(
		(underlying) => plans[underlying].scenario === 'hit'
	) as LadderUnderlying;
	const hitPlan = plans[hitIndex];
	// The rung the hit close actually lands on: right direction, inside the band.
	const winningRungs = options.filter(
		(option) =>
			option.underlying === hitIndex &&
			Math.sign(option.target - anchors[hitIndex]) === Math.sign(hitPlan.delta) &&
			Math.abs(Math.abs(hitPlan.delta) - option.deltaPoints) <= LADDER_CONFIG[hitIndex].tolerancePts
	);

	const placedIds = new Set<string>();
	const placedUserIds = new Set<string>();
	/** The verdict computeTier promised for each bet id, from the closes we wrote. */
	const expectedTierById = new Map<string, Scenario>();
	const refusals: string[] = [];

	for (const wallet of wallets) {
		// 1–3 legs: 30% a one-leg player, 40% two, 30% three.
		const roll = rng();
		const legs = roll < 0.3 ? 1 : roll < 0.7 ? 2 : 3;
		let budget = SIGNUP_BONUS;
		const usedUnderlyings = new Set<LadderUnderlying>();

		for (let i = 0; i < legs; i += 1) {
			// One active bet per index per day (PLAN §0) — the sampler respects it up
			// front rather than bouncing off the BET_EXISTS error the driver would raise.
			// The winning-rung shortcut is filtered by the same rule.
			const pool = options.filter((option) => !usedUnderlyings.has(option.underlying));
			if (pool.length === 0) break;
			const openRungs = winningRungs.filter((rung) => !usedUnderlyings.has(rung.underlying));
			const option = pickOption(pool, hitIndex, openRungs, rng);
			const stake = pickStake(rng, budget);
			if (stake === null) break; // the wallet cannot cover the minimum — stop, as the UI would

			// Odds resolved by the SERVICE from today's ladder, never invented here: the
			// same call `POST /api/bets` makes before it hands the driver any money.
			const resolved = await resolveLadderOption(
				tradeDate,
				option.underlying,
				option.targetKind,
				option.deltaPoints,
				store
			);
			if (!resolved) {
				refusals.push(
					`${wallet.handle}: ${option.underlying} ${option.targetKind}+${option.deltaPoints} is not on the ladder`
				);
				continue;
			}
			// 15:15:01–15:19:59 IST of the fake day, so the cutoff gate is judged for
			// real inside the (now 5-minute) participation window.
			const nowMs = cutoffAtMs - Math.floor(1_000 + rng() * 4 * 60_000);

			try {
				const bet = await store.placeBet({
					userId: wallet.userId,
					tradeDate,
					underlying: option.underlying,
					targetKind: option.targetKind,
					deltaPoints: option.deltaPoints,
					odds: resolved.odds,
					stake,
					cutoffAtMs,
					nowMs
				});
				placedIds.add(bet.id);
				placedUserIds.add(wallet.userId);
				expectedTierById.set(
					bet.id,
					tierFor(
						option.underlying,
						option.targetKind,
						option.deltaPoints,
						anchors[option.underlying],
						anchors[option.underlying] + plans[option.underlying].delta
					)
				);
				budget -= stake;
				usedUnderlyings.add(option.underlying);
			} catch (err: unknown) {
				refusals.push(
					`${wallet.handle}: placeBet refused ${option.underlying} ${option.targetKind}+${option.deltaPoints} — ${(err as Error).message}`
				);
			}
		}
	}
	console.info(
		`${TAG} placed ${placedIds.size} bet(s) across ${placedUserIds.size} player(s)` +
			(refusals.length > 0 ? `; ${refusals.length} refused: ${refusals[0]}` : '')
	);
	if (placedIds.size === 0) {
		console.error(`${TAG} no bets landed — nothing to settle.`);
		return 1;
	}

	// 5. Today's fake official closes --------------------------------------------
	const closes: IndexClose[] = LADDER_UNDERLYINGS.map((underlying) => ({
		tradeDate,
		underlying,
		close: round2(anchors[underlying] + plans[underlying].delta),
		source: 'official' as const
	}));
	for (const close of closes) await store.closes.upsertIndexClose(close);

	console.info(`${TAG} anchors (${prevDay}) → fake official closes (${tradeDate})`);
	for (const underlying of LADDER_UNDERLYINGS) {
		const plan = plans[underlying];
		const rung =
			underlying === hitIndex && winningRungs.length > 0
				? `  winning rung ${winningRungs[0].targetKind}+${winningRungs[0].deltaPoints}`
				: '';
		console.info(
			`${TAG}   ${padEndStr(underlying, 10)} anchor ${padStartStr(anchors[underlying].toFixed(2), 10)}` +
				`  scenario=${padEndStr(plan.scenario, 4)}  close ${padStartStr(closeStr(closes, underlying), 10)}` +
				`  Δ ${signed(plan.delta, 8)}${rung}`
		);
	}

	// 6. Settlement — the production path, capture off ---------------------------
	const { settle } = await settleNow(store, tradeDate, {
		capture: false,
		now: new Date(settleAtMs),
		chunkSize
	});
	console.info(
		`${TAG} settle: status=${settle.status} settled=${settle.settled} skipped=${settle.skipped}` +
			` tiers=${JSON.stringify(settle.tiers)} paidOut=${settle.paidOut} xp=${settle.xpAwarded}` +
			` chunks=${settle.chunks}`
	);
	if (settle.status !== 'settled') {
		console.error(
			`${TAG} the day did not settle (status=${settle.status}${settle.reason ? `: ${settle.reason}` : ''}).` +
				' All three closes are on disk, so this is a bug, not a missing feed.'
		);
		return 1;
	}

	// 7. The balance arc ---------------------------------------------------------
	// Re-read off the store: the rows `placeBet` handed back predate the settlement,
	// so their outcome columns are still null here.
	const bets = await store.bets.listBetsForSession(session.id);
	const betsByUser = new Map<string, Bet[]>();
	for (const bet of bets) {
		const bucket = betsByUser.get(bet.userId) ?? [];
		bucket.push(bet);
		betsByUser.set(bet.userId, bucket);
	}

	const rows: UserRow[] = [];
	for (const wallet of wallets) {
		const profile = await store.profiles.getProfile(wallet.userId);
		if (!profile) {
			console.error(`${TAG} profile for ${wallet.handle} vanished — aborting the arc`);
			return 1;
		}
		const mine = betsByUser.get(wallet.userId) ?? [];
		const tiers: Record<Scenario, number> = { hit: 0, flat: 0, miss: 0 };
		let staked = 0;
		let credited = 0;
		for (const bet of mine) {
			tiers[bet.settlementTier as Scenario] += 1;
			staked += bet.stake;
			credited += bet.payout ?? 0;
		}
		const ledger = await store.ledger.getLedgerForUser(wallet.userId, 200);
		rows.push({
			handle: wallet.handle,
			profile,
			ledger,
			staked,
			credited,
			tiers,
			ledgerSum: ledger.reduce((sum, entry) => sum + entry.amount, 0)
		});
	}

	const handleWidth = Math.max(6, ...rows.map((row) => row.handle.length));
	/**
	 * I1, the §8 gate, in both equivalent forms:
	 *
	 *   Σ(all ledger rows)        == balance                — the ledger is the WHOLE history
	 *   Σ(rows minus the +1,000)  == balance − 1,000        — the form PLAN §8 words it in
	 *
	 * The second is what the RUNBOOK's checklist SQL checks; the signup row is the
	 * +1,000 between them, so a drill that only checked one could pass a wallet whose
	 * ledger had quietly lost its bonus row.
	 */
	const arc = rows.map((row) => {
		const signupRows = row.ledger
			.filter((entry) => entry.kind === 'signup_bonus')
			.reduce((sum, entry) => sum + entry.amount, 0);
		const netOfSignup = row.ledgerSum - signupRows;
		return {
			row,
			signupRows,
			netOfSignup,
			okAll: row.ledgerSum === row.profile.balance,
			okNet: netOfSignup === row.profile.balance - SIGNUP_BONUS
		};
	});

	console.info(`\n${TAG} BALANCE ARC — ${rows.length} player(s) from a ${SIGNUP_BONUS} NC signup`);
	console.info(
		`  ${padEndStr('handle', handleWidth)} ${padStartStr('start', 6)} ${padStartStr('staked', 7)}` +
			` ${padStartStr('hit', 4)} ${padStartStr('flat', 4)} ${padStartStr('miss', 4)}` +
			` ${padStartStr('credited', 8)} ${padStartStr('final', 7)} ${padStartStr('net', 7)}  I1`
	);
	const totals = { start: 0, staked: 0, credited: 0, final: 0 };
	const tierTotals: Record<Scenario, number> = { hit: 0, flat: 0, miss: 0 };
	const failures: string[] = [];

	for (const { row, netOfSignup, okAll, okNet } of arc) {
		totals.start += SIGNUP_BONUS;
		totals.staked += row.staked;
		totals.credited += row.credited;
		totals.final += row.profile.balance;
		tierTotals.hit += row.tiers.hit;
		tierTotals.flat += row.tiers.flat;
		tierTotals.miss += row.tiers.miss;
		if (!okAll) {
			failures.push(
				`I1 ${row.handle}: Σ(all ledger rows) ${row.ledgerSum} ≠ balance ${row.profile.balance}`
			);
		}
		if (!okNet) {
			failures.push(
				`I1 ${row.handle}: Σ(ledger minus the signup row) ${netOfSignup} ≠ balance ${row.profile.balance} − ${SIGNUP_BONUS}`
			);
		}
		console.info(
			`  ${padEndStr(row.handle, handleWidth)} ${num(SIGNUP_BONUS, 6)} ${num(row.staked, 7)}` +
				` ${num(row.tiers.hit, 4)} ${num(row.tiers.flat, 4)} ${num(row.tiers.miss, 4)}` +
				` ${num(row.credited, 8)} ${num(row.profile.balance, 7)} ${num(netOfSignup, 7)}` +
				`  ${okAll && okNet ? '✓' : '✗'}`
		);

		if (!verbose) continue;
		for (const bet of betsByUser.get(row.profile.userId) ?? []) {
			const delta = plans[bet.underlying as LadderUnderlying].delta;
			console.info(
				`      ${padEndStr(bet.underlying, 10)} ${padEndStr(bet.targetKind, 5)}` +
					` ${padStartStr((bet.targetKind === 'up' ? '+' : '−') + String(bet.deltaPoints), 5)}` +
					`  odds ${padStartStr(bet.odds.toFixed(1), 5)}  stake ${num(bet.stake, 6)} →` +
					` ${TIER_TAG[bet.settlementTier as Scenario]} pays ${num(bet.payout ?? 0, 6)}  (Δ ${signed(delta, 8)})`
			);
		}
	}
	console.info(
		`  ${padEndStr('TOTAL', handleWidth)} ${num(totals.start, 6)} ${num(totals.staked, 7)}` +
			` ${num(tierTotals.hit, 4)} ${num(tierTotals.flat, 4)} ${num(tierTotals.miss, 4)}` +
			` ${num(totals.credited, 8)} ${num(totals.final, 7)}`
	);

	const pot: DailyPot | null = await store.pots.getDailyPot(tradeDate);
	console.info(
		`${TAG} pot ${tradeDate}: bets=${pot?.totalBets} staked=${pot?.totalStaked}` +
			` paidOut=${pot?.totalPaidOut} players=${pot?.playersCount}`
	);
	console.info(
		`${TAG} house on this engineered day: staked ${totals.staked} − credited ${totals.credited} = ` +
			`${totals.staked - totals.credited} NC${totals.staked === 0 ? '' : ` (${(((totals.staked - totals.credited) / totals.staked) * 100).toFixed(1)}%)`}` +
			' — the closes are fitted to the rungs, so this is NOT the house edge (that is scripts/simulate-ev.ts)'
	);

	// -- the invariants ----------------------------------------------------------

	// I2 — the ledger replays to the wallet from zero, never negative, and every
	// row's balance_after is the balance it actually produced.
	for (const { row } of arc) {
		let running = 0;
		const ascending = [...row.ledger].sort((a, b) => a.id - b.id);
		for (const entry of ascending) {
			running += entry.amount;
			if (entry.balanceAfter !== running) {
				failures.push(
					`I2 ${row.handle}: ledger id=${entry.id} balance_after=${entry.balanceAfter}, the replay says ${running}`
				);
			}
			if (entry.balanceAfter < 0) {
				failures.push(`I2 ${row.handle}: ledger id=${entry.id} took the wallet below zero`);
			}
		}
		if (running !== row.profile.balance) {
			failures.push(
				`I2 ${row.handle}: the replay ends at ${running}, the wallet holds ${row.profile.balance}`
			);
		}
	}

	// I3 + I4 — every bet settled once, priced by payoutFor, verdicted by computeTier.
	for (const bet of bets) {
		if (!placedIds.has(bet.id)) {
			failures.push(`I3 bet ${bet.id} is on the session but was not placed by this run`);
			continue;
		}
		const tier = bet.settlementTier as Scenario | null;
		if (bet.settledAt === null || tier === null) {
			failures.push(`I3 bet ${bet.id} was left unsettled`);
			continue;
		}
		const u2 = bet.underlying as LadderUnderlying;
		const acc2 =
			tier === 'hit'
				? hitAccuracy(
						{ underlying: u2, targetKind: bet.targetKind, deltaPoints: bet.deltaPoints },
						anchors[u2],
						anchors[u2] + plans[u2].delta
					)
				: 1;
		const expectedPayout = payoutFor(tier, bet.stake, bet.odds, acc2);
		if (bet.payout !== expectedPayout) {
			failures.push(
				`I3 bet ${bet.id}: payout ${bet.payout} ≠ payoutFor(${tier}, ${bet.stake}, ${bet.odds}) = ${expectedPayout}`
			);
		}
		const expectedTier = expectedTierById.get(bet.id);
		if (expectedTier !== undefined && tier !== expectedTier) {
			failures.push(
				`I4 bet ${bet.id} (${bet.underlying} ${bet.targetKind}+${bet.deltaPoints}): the engine said ` +
					`${tier}, computeTier says ${expectedTier} (Δ ${plans[bet.underlying as LadderUnderlying].delta})`
			);
		}
	}

	// I5 — the pots are the bets, never an aggregate over them.
	if (!pot) {
		failures.push('I5 the daily_pots row is missing');
	} else {
		const staked = bets.reduce((sum, bet) => sum + bet.stake, 0);
		const paid = bets.reduce((sum, bet) => sum + (bet.payout ?? 0), 0);
		const players = new Set(bets.map((bet) => bet.userId)).size;
		if (pot.totalBets !== bets.length)
			failures.push(`I5 total_bets ${pot.totalBets} ≠ ${bets.length} bet(s)`);
		if (pot.totalStaked !== staked) failures.push(`I5 total_staked ${pot.totalStaked} ≠ ${staked}`);
		if (pot.totalPaidOut !== paid) failures.push(`I5 total_paid_out ${pot.totalPaidOut} ≠ ${paid}`);
		if (pot.playersCount !== players)
			failures.push(`I5 players_count ${pot.playersCount} ≠ ${players}`);
	}

	// I6 — the odds are the ladder's, on every row.
	for (const bet of bets) {
		const option = options.find(
			(candidate) =>
				candidate.underlying === bet.underlying &&
				candidate.targetKind === bet.targetKind &&
				candidate.deltaPoints === bet.deltaPoints
		);
		if (!option) failures.push(`I6 bet ${bet.id} is not on today's ladder`);
		else if (option.odds !== bet.odds)
			failures.push(`I6 bet ${bet.id} odds ${bet.odds} ≠ ladder ${option.odds}`);
	}

	// Scenario coverage — the closes were chosen to prove all three tiers exist.
	const coverage = LADDER_UNDERLYINGS.map((underlying) => {
		const scenario = plans[underlying].scenario;
		const onIndex = bets.filter((bet) => bet.underlying === underlying);
		return {
			underlying,
			scenario,
			bets: onIndex.length,
			verdicts: onIndex.filter((bet) => bet.settlementTier === scenario).length
		};
	});
	console.info(
		`${TAG} scenario coverage: ` +
			coverage
				.map(
					({ underlying, scenario, bets: onIndex, verdicts }) =>
						`${underlying}=${scenario} ${verdicts}/${onIndex}`
				)
				.join('  ')
	);
	for (const { underlying, scenario, bets: onIndex, verdicts } of coverage) {
		if (onIndex === 0) continue; // nobody bet that index — nothing to assert
		if (scenario === 'hit' ? verdicts === 0 : verdicts !== onIndex) {
			failures.push(
				`I4 ${underlying} (${scenario}): ${verdicts}/${onIndex} settled bet(s) came out ${scenario}`
			);
		}
	}

	// 8. Re-settle — a numeric no-op, twice --------------------------------------
	const before = await snapshotOf(
		store,
		tradeDate,
		rows.map(({ profile }) => profile),
		bets,
		session.id
	);
	const second = await settleNow(store, tradeDate, {
		capture: false,
		now: new Date(settleAtMs),
		chunkSize
	});
	const after = await snapshotOf(
		store,
		tradeDate,
		rows.map(({ profile }) => profile),
		bets,
		session.id
	);
	const replay = second.settle;
	const noop =
		replay.status === 'already-settled' &&
		replay.settled === 0 &&
		replay.skipped === 0 &&
		replay.paidOut === 0 &&
		replay.xpAwarded === 0 &&
		replay.chunks === 0;
	if (!noop) {
		failures.push(
			`I7a the re-settle was not a clean no-op: status=${replay.status} settled=${replay.settled}` +
				` skipped=${replay.skipped} paidOut=${replay.paidOut} chunks=${replay.chunks}`
		);
	}
	if (before !== after) failures.push('I7a the re-settle changed a row');
	console.info(
		`${TAG} re-settle: status=${replay.status} settled=${replay.settled} paidOut=${replay.paidOut} — ` +
			`${before === after ? 'snapshot identical' : 'SNAPSHOT CHANGED'}`
	);

	// I7b — the deeper probe: hand the DRIVER the same chunk again. A settled bet
	// cannot be paid twice even when the money path is re-run verbatim. (The outcome
	// shape is the driver's own `SettleOutcomeInput`, inferred — not re-declared here.)
	const outcomes = bets
		.filter((bet) => bet.settledAt !== null && bet.payout !== null)
		.map((bet) => ({
			betId: bet.id,
			userId: bet.userId,
			stake: bet.stake,
			odds: bet.odds,
			tier: bet.settlementTier as Scenario,
			payout: bet.payout as number
		}));
	const chunkReplay = await store.settleBets({
		sessionId: session.id,
		tradeDate,
		outcomes,
		settledAtMs: settleAtMs
	});
	const afterReplay = await snapshotOf(
		store,
		tradeDate,
		rows.map(({ profile }) => profile),
		bets,
		session.id
	);
	if (chunkReplay.settled !== 0 || chunkReplay.skipped !== outcomes.length) {
		failures.push(
			`I7b the chunk replay moved money: settled=${chunkReplay.settled} skipped=${chunkReplay.skipped} of ${outcomes.length}`
		);
	}
	if (afterReplay !== after) failures.push('I7b the chunk replay changed a row');
	console.info(
		`${TAG} chunk replay: ${outcomes.length} settled outcome(s) re-run → settled=${chunkReplay.settled}` +
			` skipped=${chunkReplay.skipped} — ${afterReplay === after ? 'snapshot identical' : 'SNAPSHOT CHANGED'}`
	);

	// -- verdict -----------------------------------------------------------------
	console.info('');
	if (failures.length > 0) {
		for (const failure of failures) console.error(`${TAG} INVARIANT FAILED: ${failure}`);
		console.error(`${TAG} INVARIANTS FAILED (${failures.length})`);
		return 1;
	}
	console.info(
		`${TAG} INVARIANTS OK — I1 ledger==balance for all ${rows.length} player(s) (net −${SIGNUP_BONUS}) · ` +
			'I2 ledger replay · I3 payouts · I4 verdicts · I5 pots · I6 ladder odds · I7 re-settle is a no-op'
	);
	return 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round(n * 100) / 100;

function closeStr(closes: IndexClose[], underlying: LadderUnderlying): string {
	const row = closes.find((candidate) => candidate.underlying === underlying);
	return row ? row.close.toFixed(2) : '—';
}

/** The verdict a bet MUST get, from the same pure rulebook the engine calls. */
function tierFor(
	underlying: LadderUnderlying,
	targetKind: 'up' | 'down',
	deltaPoints: number,
	prevClose: number,
	close: number
): Scenario {
	const tier = computeTier({ underlying, targetKind, deltaPoints }, prevClose, close);
	if (tier === 'abstain')
		throw new Error(`abstain on ${underlying}: anchor ${prevClose} is unusable`);
	return tier;
}

/**
 * One ladder option for one bet: uniform over the rungs, except that half the bets
 * on the `hit` index take the winning rung — so a run of any size exercises a HIT
 * without the closes being fitted to whatever the sampler happened to pick.
 */
function pickOption(
	options: LadderOption[],
	hitIndex: LadderUnderlying,
	winningRungs: LadderOption[],
	rng: () => number
): LadderOption {
	if (winningRungs.length > 0 && rng() < 0.5) {
		return winningRungs[Math.floor(rng() * winningRungs.length)] as LadderOption;
	}
	return options[Math.floor(rng() * options.length)] as LadderOption;
}

/**
 * A stake from the weighted pool, capped by what the wallet still holds. Null when
 * even the minimum does not fit — the caller stops betting rather than sending a
 * request that would bounce off `InsufficientFundsError`.
 */
function pickStake(rng: () => number, budget: number): number | null {
	const affordable = STAKE_POOL.filter((entry) => entry.stake <= budget);
	if (affordable.length === 0) return null;
	const weightTotal = affordable.reduce((sum, entry) => sum + entry.weight, 0);
	let roll = rng() * weightTotal;
	for (const entry of affordable) {
		roll -= entry.weight;
		if (roll <= 0) return entry.stake;
	}
	return (affordable[affordable.length - 1] as { stake: number }).stake;
}

/**
 * Every row the day touched, as one canonical string. Comparing two of these IS the
 * re-settle check: nothing has to know what a "change" looks like, only whether the
 * fingerprint moved. Timestamps are zeroed where the store stamps `now()` on a read.
 */
async function snapshotOf(
	store: GameStore,
	tradeDate: string,
	profiles: Profile[],
	bets: Bet[],
	sessionId: number
): Promise<string> {
	const pot = await store.pots.getDailyPot(tradeDate);
	return JSON.stringify({
		session: await store.sessions.getSessionById(sessionId),
		pot: pot ? { ...pot, updatedAt: 0 } : null,
		closes: (await store.closes.getIndexCloses(tradeDate)).sort((a, b) =>
			a.underlying.localeCompare(b.underlying)
		),
		bets: bets
			.map((bet) => ({
				id: bet.id,
				tier: bet.settlementTier,
				payout: bet.payout,
				settledAt: bet.settledAt,
				stake: bet.stake,
				odds: bet.odds
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		users: await Promise.all(
			profiles.map(async (profile) => {
				const ledger = await store.ledger.getLedgerForUser(profile.userId, 200);
				return {
					handle: profile.handle,
					balance: profile.balance,
					xp: profile.xp,
					streakDays: profile.streakDays,
					lastBetDate: profile.lastBetDate,
					stats: await store.stats.getUserStats(profile.userId),
					ledger: ledger
						.map((entry) => ({
							id: entry.id,
							kind: entry.kind,
							amount: entry.amount,
							after: entry.balanceAfter
						}))
						.sort((a, b) => a.id - b.id)
				};
			})
		)
	});
}

// Run-as-module guard (mirrors settle-manual.ts / session-admin.ts): a test may import
// this file's helpers without executing a whole fake day.
const isEntry =
	process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isEntry) {
	const exitCode = await main();
	// Drop the process store so a repeated import in the same run cannot hold a pool.
	resetStoreForTests();
	process.exitCode = exitCode;
}
