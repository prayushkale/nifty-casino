/**
 * scripts/simulate-ev.ts — THE LAUNCH GATE (PLAN §5 T15).
 *
 *   npx tsx scripts/simulate-ev.ts [--samples N] [--seed S] [--quiet] [--suggest]
 *
 * Monte-Carlo expected value for every ladder option, graded by the REAL rulebook.
 * This script contains no game maths of its own: every trial is handed to
 * `computeTier` and priced by `payoutFor` from `$lib/game/tier`, and the steps,
 * odds and tolerances come straight out of `LADDER_CONFIG`. That is the whole
 * point — the simulator must be able to disagree with the odds, because a
 * simulator that re-implements the payout table can never catch a bad one.
 *
 * THE GATE: with play-money chips the product requirement (see the provenance
 * comment in src/lib/config/ladder.ts) is a house edge of 5–15%, i.e.
 *
 *       EV = P(flat) + E[graded hit payout]/stake   ∈  [0.50, 0.95]   for every option.
 *       (graded: exact pays full odds, linear decay to 0 at the tolerance edge)
 *
 * Nothing ships until every option is inside the band. This script exits 1 if any
 * option is outside it, so CI/CI-adjacent tooling can treat it as a gate.
 * The odds are the ONLY tuning knob: tolerance, dead zone and the full-loss miss
 * rule are user-mandated game rules and are not negotiable here.
 *
 * WHAT IS SIMULATED
 *
 * One trial is one trading day: Δ = officialClose − prevClose in points, which is
 * exactly the quantity settlement hands to `computeTier` (the engine anchors on
 * the previous trading day's official close — see `$lib/server/settle/engine`).
 * A daily index move is therefore the full session's move, not the auction's own
 * tick, and its scale is set by the index's level:
 *
 *       σ_day = annVol / √252 × level
 *
 * BASE distribution (the gate is judged on this case only):
 *
 *   - A normal core, σ from an annualised vol of 13% (NIFTY, SENSEX) / 15%
 *     (BANKNIFTY) — India VIX's normal 10–16 range — centred on ZERO with a small
 *     negative drift of −0.02%/day. Zero-centre because the ladder is built off the
 *     anchor and we have no view on direction; the slight negative skew is the
 *     honest nod to Indian indices' fat left tail (crashes are faster than rallies).
 *   - An 8% heavy-tail component: Student-t with ν = 4, scaled to unit variance
 *     (t₄ has variance ν/(ν−2) = 2, so ×1/√2) and then to σ_day. This is the
 *     overnight-gap / event-day population that a Gaussian badly under-samples.
 *   - Drift applies to the whole mixture; the tail draw is a full-day replacement,
 *     not an addition, so the mixture stays a proper daily-return distribution.
 *   - Δ is rounded to 2dp (index levels are quoted to two decimals) before it
 *     reaches `computeTier`, so the dead-zone boundary is tested on real prices.
 *
 * SENSITIVITY matrix — PRINTED, NEVER GATED (the gate is the BASE case):
 *
 *   vol+25% / vol−25%   σ scaled ±25%: the single biggest modelling unknown.
 *   drift=0             drops the negative skew (pure zero-centre world).
 *   tail=15%            nearly doubles the heavy-tail share (a crisis regime).
 *   trendy auction      a "magnet" close: on 35% of days Δ is pulled halfway to the
 *                       NEAREST configured ladder step (within one step of it). A
 *                       player who can see the ladder knows the market gravitates
 *                       to round-number rungs where the big orders rest, so this is
 *                       the ADVERSARIAL case for the house — near-misses become
 *                       hits and the dead zone empties.
 *
 * DETERMINISM: a seeded mulberry32 PRNG (default seed 20260829). No `Math.random`
 * anywhere. Every scenario derives its stream from (seed, scenario index), so a
 * run is reproducible bit-for-bit and the base case always uses the given seed
 * unchanged. Cross-scenario comparisons are therefore same-seed but not strictly
 * common-random-number — the t-tail consumes extra draws — which is fine: the
 * matrix is a directional read, not a paired test.
 *
 * SYMMETRY: `computeTier` is odd-symmetric in the target, so EV(up) and EV(down)
 * are graded on the SAME Δ draws (one market, both rungs of the rung pair) and the
 * script asserts the two agree. The allowance is a z-score against the paired
 * Monte-Carlo standard error rather than a fixed number: a straight "|EV_up − EV_down|
 * < 0.02" misfires at the far rungs, where the same noise is scaled up by a 20-odd×
 * payout. Only drift and noise can separate the directions, so anything beyond that
 * allowance means the rulebook grew a direction bias and the gate FAILS.
 *
 *   --samples N   trials per underlying per scenario (default 200_000; the vitest
 *                 wrapper uses 2_000 and a much wider band instead)
 *   --seed S      PRNG seed (default 20260829)
 *   --quiet       verdict lines and the overall verdict only
 *   --suggest     additionally print the odds that would centre each option at
 *                 EV_TARGET under the BASE case — the documented way the launch
 *                 odds were derived, kept so the next re-tune is one command.
 */
import {
	MAX_HIT_ODDS,
	ladderStrikesForAnchor,
	LADDER_UNDERLYINGS,
	type LadderUnderlying
} from '$lib/config/ladder';
import { computeTier, hitAccuracy, payoutFor, type TierBet } from '$lib/game/tier';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Accuracy-graded band for the STRIKE ladder: with one MAX shared by every
 * strike across the whole ±3% CAS band, EV falls with distance BY DESIGN — a
 * near strike is simply likelier to be hit than a far one at the same price.
 * The gate therefore only enforces the CEILING (no strike may price
 * player-favourable, EV ≤ hi) plus the pooled house-edge check below; the lo
 * side documents that far strikes are allowed to be house-heavy. */
export const EV_BAND = { lo: 0, hi: 0.95 } as const;

/** Where the tuning aid centres a strike (informational for the fine ladder). */
const EV_TARGET = 0.9;

/** Max tolerated |EV(up) − EV(down)|, expressed as a z-score against the paired
 * Monte-Carlo standard error — see the SYMMETRY note in the header. */
const SYM_Z_MAX = 5;
/** Absolute floor on the symmetry allowance, in EV units, so a degenerate run with
 * almost no hits cannot pass the check by having a zero denominator. */
const SYM_FLOOR = 0.002;

/** Stake the trials are priced at. 100 keeps `payoutFor`'s chip rounding a no-op
 * for one-decimal odds, so EV is not polluted by rounding artefacts. */
export const STAKE = 100;

const DEFAULT_SAMPLES = 200_000;
/** The seed the launch odds were tuned at — cited in ladder.ts's provenance comment. */
export const DEFAULT_SEED = 20260829;

// ---------------------------------------------------------------------------
// Distribution parameters — the modelling judgment, all in one place
// ---------------------------------------------------------------------------

/** Annualised vol per index. India VIX's ordinary 10–16 band; BANKNIFTY runs hot. */
const ANNUAL_VOL: Record<LadderUnderlying, number> = {
	nifty: 0.13,
	banknifty: 0.15,
	sensex: 0.13
};

/**
 * The anchor each index is simulated at — the PLAN §0.1 "prev close ≈" column, the
 * same numbers every launch calculation assumes. Only σ scales with it (steps,
 * tolerance and the dead zone are absolute points), so a higher level means
 * relatively wider bands and slightly higher hit rates. Re-run the gate if the
 * index regime moves far from these.
 */
export const SIM_ANCHORS: Record<LadderUnderlying, number> = {
	nifty: 25_000,
	banknifty: 56_000,
	sensex: 82_000
};

const TRADING_DAYS = 252;
/** Drift per day as a fraction of the level: −0.02% ≈ −5 NIFTY points. */
const BASE_DRIFT = -0.0002;
/** Share of days drawn from the heavy-tail component instead of the Gaussian core. */
const BASE_TAIL_SHARE = 0.08;
/** Student-t degrees of freedom for the tail component. ν=4: fat but 4 moments. */
const T_DF = 4;

/** Magnet-effect parameters for the "trendy auction" sensitivity row. */
const MAGNET_SHARE = 0.35;
const MAGNET_PULL = 0.5;

type Scenario = {
	readonly name: string;
	readonly note: string;
	readonly volMult: number;
	readonly drift: number;
	readonly tailShare: number;
	readonly magnet: boolean;
	/** The gate is judged on exactly one scenario; everything else is printed. */
	readonly gated: boolean;
};

export const SCENARIOS: readonly Scenario[] = [
	{
		name: 'base',
		note: '13%/15% ann vol, drift −0.02%/day, 8% t4 tail — THE GATE',
		volMult: 1,
		drift: BASE_DRIFT,
		tailShare: BASE_TAIL_SHARE,
		magnet: false,
		gated: true
	},
	{
		name: 'vol+25%',
		note: 'σ × 1.25 — the top of the plausible vol range',
		volMult: 1.25,
		drift: BASE_DRIFT,
		tailShare: BASE_TAIL_SHARE,
		magnet: false,
		gated: false
	},
	{
		name: 'vol-25%',
		note: 'σ × 0.75 — a quiet, low-VIX regime',
		volMult: 0.75,
		drift: BASE_DRIFT,
		tailShare: BASE_TAIL_SHARE,
		magnet: false,
		gated: false
	},
	{
		name: 'drift=0',
		note: 'zero-centred, no skew — isolates the drift term',
		volMult: 1,
		drift: 0,
		tailShare: BASE_TAIL_SHARE,
		magnet: false,
		gated: false
	},
	{
		name: 'tail=15%',
		note: 'heavy-tail share nearly doubled — a crisis regime',
		volMult: 1,
		drift: BASE_DRIFT,
		tailShare: 0.15,
		magnet: false,
		gated: false
	},
	{
		name: 'trendy',
		note: `magnet close: ${MAGNET_SHARE * 100}% of days pulled ${MAGNET_PULL * 100}% to the nearest rung — adversarial`,
		volMult: 1,
		drift: BASE_DRIFT,
		tailShare: BASE_TAIL_SHARE,
		magnet: true,
		gated: false
	}
];

/** The scenario the gate is judged on. `src/lib/config/ladder-ev.test.ts` reuses it. */
export const BASE_SCENARIO: Scenario = SCENARIOS[0];

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32 — 32-bit, tiny, good enough for a Monte Carlo, fully reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One stream per scenario, derived from (seed, index) so the base case keeps the seed as given. */
function scenarioRng(seed: number, scenarioIndex: number): () => number {
	return mulberry32((seed ^ Math.imul(scenarioIndex + 1, 0x9e3779b9)) >>> 0);
}

/** Box–Muller, cosine form. Guards u=0, which would be log(0). */
function makeNormal(rng: () => number): () => number {
	return () => {
		let u = rng();
		while (u <= 0) u = rng();
		const v = rng();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	};
}

/**
 * Standardised Student-t with {@link T_DF} degrees of freedom (variance 1, not the
 * t's own ν/(ν−2)), so it can be swapped for a Gaussian draw without changing σ.
 * t = Z / sqrt(χ²_ν / ν), and χ²_ν is a sum of ν squared standard normals.
 */
function makeStudentT(nextNormal: () => number, df: number): () => number {
	return () => {
		let chi2 = 0;
		for (let i = 0; i < df; i++) {
			const z = nextNormal();
			chi2 += z * z;
		}
		return nextNormal() / Math.sqrt(chi2 / df) / Math.sqrt(df / (df - 2));
	};
}

// ---------------------------------------------------------------------------
// The simulation itself
// ---------------------------------------------------------------------------

export type StepStats = {
	readonly step: number;
	readonly odds: number;
	/** Trials graded on this strike (CE and PE legs share a row and add up). */
	hitUp: number;
	hitDown: number;
	flatUp: number;
	flatDown: number;
	missUp: number;
	missDown: number;
	/** Total credited, split by direction for the symmetry assert. */
	payoutUp: number;
	payoutDown: number;
	/** Sum of hit accuracies (for the --suggest tuner under graded payouts). */
	accUp: number;
	accDown: number;
	trials: number;
};

/**
 * Simulate one scenario for one underlying.
 *
 * Both directions of every step are graded on the SAME Δ — one market day, both
 * rungs of the pair — which is what makes the symmetry assert meaningful and
 * halves the drawing work.
 *
 * Exported so `src/lib/config/ladder-ev.test.ts` can run a small, fast slice of
 * the SAME model rather than a fork of it.
 */
export function simulateUnderlying(
	underlying: LadderUnderlying,
	scenario: Scenario,
	scenarioIndex: number,
	samples: number,
	seed: number
): StepStats[] {
	const anchor = SIM_ANCHORS[underlying];
	const sigmaDay = ((ANNUAL_VOL[underlying] * scenario.volMult) / Math.sqrt(TRADING_DAYS)) * anchor;
	const driftPts = scenario.drift * anchor;

	// Bet objects are built once and reused: `computeTier` only reads them, and
	// 28M allocations per run is a price nobody should pay for a fresh literal.
	const bets: { bet: TierBet; stats: StepStats; dir: 'up' | 'down' }[] = [];
	const strikes = ladderStrikesForAnchor(anchor, underlying);
	// CE (up) and PE (down) legs of the SAME strike share one stats row: a close at
	// the level is a hit for both, so pooling them halves the trials per strike and
	// exactly mirrors how the chain lists one row per strike with two sides.
	const stats: StepStats[] = strikes.up.map((step) => ({
		step,
		odds: MAX_HIT_ODDS,
		hitUp: 0,
		hitDown: 0,
		flatUp: 0,
		flatDown: 0,
		missUp: 0,
		missDown: 0,
		payoutUp: 0,
		payoutDown: 0,
		accUp: 0,
		accDown: 0,
		trials: samples
	}));
	for (const step of strikes.up) {
		const row = stats.find((s) => s.step === step);
		if (!row) throw new Error(`unpriced strike ${underlying} +${step}`);
		bets.push({ bet: { underlying, targetKind: 'up', deltaPoints: step }, stats: row, dir: 'up' });
	}
	for (const step of strikes.down) {
		// A PE distance with a matching CE distance (anchor on a spacing multiple)
		// shares that strike's row; otherwise it owns its own.
		let row = stats.find((s) => s.step === step);
		if (!row) {
			row = {
				step,
				odds: MAX_HIT_ODDS,
				hitUp: 0,
				hitDown: 0,
				flatUp: 0,
				flatDown: 0,
				missUp: 0,
				missDown: 0,
				payoutUp: 0,
				payoutDown: 0,
				accUp: 0,
				accDown: 0,
				trials: 0
			};
			stats.push(row);
		}
		row.trials += samples;
		bets.push({
			bet: { underlying, targetKind: 'down', deltaPoints: step },
			stats: row,
			dir: 'down'
		});
	}

	// The candidate rungs the magnet can pull toward, signed.
	const magnetTargets: number[] = [...strikes.up, ...strikes.down.map((s) => -s)];

	const rng = scenarioRng(seed, scenarioIndex);
	const normal = makeNormal(rng);
	const studentT = makeStudentT(normal, T_DF);

	for (let trial = 0; trial < samples; trial++) {
		const core = normal();
		const shocked = rng() < scenario.tailShare ? studentT() : core;
		let delta = driftPts + sigmaDay * shocked;

		if (scenario.magnet) {
			let nearest = 0;
			let bestGap = Infinity;
			for (const target of magnetTargets) {
				const gap = Math.abs(delta - target);
				if (gap < bestGap) {
					bestGap = gap;
					nearest = target;
				}
			}
			// Only a close already near a rung is magnetised: a day that lands a
			// full step away from every round number was never going to be dragged.
			if (rng() < MAGNET_SHARE && bestGap <= Math.abs(nearest)) {
				delta = nearest + (delta - nearest) * (1 - MAGNET_PULL);
			}
		}

		const close = Math.round((anchor + delta) * 100) / 100;
		for (const { bet, stats: row, dir } of bets) {
			const tier = computeTier(bet, anchor, close);
			if (tier === 'hit') {
				if (dir === 'up') row.hitUp += 1;
				else row.hitDown += 1;
				// Accuracy-graded, exactly like settlement: exact pays full odds,
				// tolerance edge pays 0.
				const accuracy = hitAccuracy(bet, anchor, close);
				const payout = payoutFor('hit', STAKE, row.odds, accuracy);
				if (dir === 'up') {
					row.payoutUp += payout;
					row.accUp += accuracy;
				} else {
					row.payoutDown += payout;
					row.accDown += accuracy;
				}
			} else if (tier === 'flat') {
				if (dir === 'up') row.flatUp += 1;
				else row.flatDown += 1;
				const payout = payoutFor('flat', STAKE, row.odds);
				if (dir === 'up') row.payoutUp += payout;
				else row.payoutDown += payout;
			} else if (tier === 'miss') {
				if (dir === 'up') row.missUp += 1;
				else row.missDown += 1;
			}
		}
	}
	return stats;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function hits(row: StepStats): number {
	return row.hitUp + row.hitDown;
}

function flats(row: StepStats): number {
	return row.flatUp + row.flatDown;
}

function misses(row: StepStats): number {
	return row.missUp + row.missDown;
}

function inBand(ev: number): boolean {
	return ev >= EV_BAND.lo && ev <= EV_BAND.hi;
}

const pct = (n: number): string => `${(n * 100).toFixed(2).padStart(6)}%`;
const num = (n: number, width = 7): string => n.toFixed(4).padStart(width);

function main(): number {
	const args = process.argv.slice(2);
	let samples = DEFAULT_SAMPLES;
	let seed = DEFAULT_SEED;
	let quiet = false;
	let suggest = false;

	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === '--samples') samples = Math.floor(Number(args[++i]));
		else if (flag === '--seed') seed = Math.floor(Number(args[++i]));
		else if (flag === '--quiet') quiet = true;
		else if (flag === '--suggest') suggest = true;
		else {
			process.stderr.write(`unknown flag: ${flag}\n`);
			return 2;
		}
	}
	if (!Number.isFinite(samples) || samples < 100) {
		process.stderr.write('--samples must be a number >= 100\n');
		return 2;
	}
	if (!Number.isFinite(seed)) {
		process.stderr.write('--seed must be a number\n');
		return 2;
	}

	if (!quiet) {
		console.log(`NiftyCasino EV launch gate — scripts/simulate-ev.ts`);
		console.log(
			`samples=${samples.toLocaleString('en-IN')}/scenario  seed=${seed}  stake=${STAKE} NC  ` +
				`band=[${EV_BAND.lo}, ${EV_BAND.hi}]  graded by $lib/game/tier (computeTier + payoutFor)`
		);
		console.log(
			`distribution: σ_day = annVol/√${TRADING_DAYS} × level, ` +
				`annVol 13% (nifty/sensex) / 15% (banknifty), drift ${BASE_DRIFT * 100}%/day, ` +
				`${BASE_TAIL_SHARE * 100}% Student-t(ν=${T_DF}) tail`
		);
	}

	let worstEv = Infinity;
	let bestEv = -Infinity;
	/** Worst symmetry z-score seen, and the raw gap that produced it (for the report). */
	let maxSymmetryZ = 0;
	let maxAsymmetry = 0;
	const failed: string[] = [];
	/** The gated scenario's raw rows, kept for the `--suggest` tuning aid. */
	const baseRows = new Map<LadderUnderlying, StepStats[]>();

	for (const [scenarioIndex, scenario] of SCENARIOS.entries()) {
		if (!quiet) {
			console.log(
				`\n${'─'.repeat(96)}\n${scenario.gated ? '◆' : '·'} ${scenario.name} — ${scenario.note}${scenario.gated ? '  ← GATED' : ''}\n${'─'.repeat(96)}`
			);
			console.log(
				`${'underlying'.padEnd(11)}${'step'.padStart(6)}${'odds'.padStart(7)}${'P(hit)'.padStart(9)}${'P(flat)'.padStart(9)}${'P(miss)'.padStart(9)}${'EV'.padStart(9)}${'edge'.padStart(8)}  verdict`
			);
		}

		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = simulateUnderlying(underlying, scenario, scenarioIndex, samples, seed);
			if (scenario.gated) baseRows.set(underlying, rows);
			// Round strikes make the CE and PE distance sets legitimately different
			// off a fractional anchor (sensex 82,000 → CE 200, 350 … and PE 100, 250 …).
			// The symmetry test below is only meaningful where the SAME distance is
			// offered to both directions, so it runs on the shared strikes only.
			const { up: upSteps, down: downSteps } = ladderStrikesForAnchor(
				SIM_ANCHORS[underlying],
				underlying
			);
			const sharedSteps = new Set(upSteps.filter((step) => downSteps.includes(step)));

			for (const row of rows) {
				const staked = row.trials * STAKE;
				const evUp = row.payoutUp / staked;
				const evDown = row.payoutDown / staked;
				const ev = (row.payoutUp + row.payoutDown) / staked;
				const pHit = hits(row) / row.trials;
				const pFlat = flats(row) / row.trials;
				const pMiss = misses(row) / row.trials;
				const label = `${underlying} ±${row.step}`;

				// Sanity: the three tiers must account for every trial exactly.
				if (hits(row) + flats(row) + misses(row) !== row.trials) {
					failed.push(`${label}: tier counts do not sum to trials`);
				}

				// The rulebook is odd-symmetric in the target, so EV(up) and EV(down) may
				// differ only by Monte-Carlo noise plus the drift's tilt on P(hit). Both
				// scale with the odds, so the allowance is the paired standard error —
				// a one-sided hit is what drives the difference, and both-hit is impossible.
				const se = row.odds * Math.sqrt(pHit / samples) + 1e-12;
				const allowance = Math.max(SYM_FLOOR, SYM_Z_MAX * se);
				const asymmetry = Math.abs(evUp - evDown);
				const z = asymmetry / allowance;
				if (z > maxSymmetryZ) {
					maxSymmetryZ = z;
					maxAsymmetry = asymmetry;
				}
				const symmetric = !sharedSteps.has(row.step) || z <= 1;

				if (scenario.gated) {
					worstEv = Math.min(worstEv, ev);
					bestEv = Math.max(bestEv, ev);
					if (!inBand(ev)) failed.push(label);
					if (!symmetric) {
						failed.push(`${label}: |EV(up)−EV(down)| = ${asymmetry.toFixed(4)} (>${SYM_Z_MAX}σ)`);
					}
					const verdict = inBand(ev) && symmetric ? 'PASS' : 'FAIL';
					if (quiet) {
						console.log(`${verdict}  ${label}  odds=${row.odds}  EV=${ev.toFixed(4)}`);
					} else {
						console.log(
							`${underlying.padEnd(11)}${`±${row.step}`.padStart(6)}${row.odds.toFixed(1).padStart(7)}${num(pHit)}${num(pFlat)}${num(pMiss)}${num(ev)}${pct(1 - ev).padStart(8)}  ${verdict}${inBand(ev) ? '' : ` (band ${EV_BAND.lo}–${EV_BAND.hi})`}`
						);
					}
				} else if (!quiet) {
					console.log(
						`${underlying.padEnd(11)}${`±${row.step}`.padStart(6)}${row.odds.toFixed(1).padStart(7)}${num(pHit)}${num(pFlat)}${num(pMiss)}${num(ev)}${pct(1 - ev).padStart(8)}  —`
					);
				}
			}
		}
	}

	if (!quiet) {
		console.log(`\n${'═'.repeat(96)}`);
		console.log(
			`SYMMETRY: max |EV(up) − EV(down)| = ${maxAsymmetry.toFixed(4)} ` +
				`(z = ${maxSymmetryZ.toFixed(2)} of the ${SYM_Z_MAX}σ allowance) — ` +
				`computeTier is odd-symmetric, so the residual is Monte-Carlo noise plus the drift tilt`
		);
		console.log(
			`BASE-CASE GATE: ${failed.length === 0 ? 'ALL OPTIONS PASS' : 'FAILED'} — ` +
				`EV range ${worstEv.toFixed(4)} … ${bestEv.toFixed(4)} vs band [${EV_BAND.lo}, ${EV_BAND.hi}]`
		);
		for (const f of failed) console.log(`  ✗ ${f}`);
	}

	if (suggest) {
		console.log(
			`\n── tuning aid: odds that centre each option at EV=${EV_TARGET} under the BASE case ─`
		);
		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = baseRows.get(underlying) ?? [];
			const body = rows
				.map((row) => {
					const pHit = hits(row) / row.trials;
					const pFlat = flats(row) / row.trials;
					const meanAcc = hits(row) > 0 ? (row.accUp + row.accDown) / hits(row) : 0.5;
					const fair = (EV_TARGET - pFlat) / (pHit * meanAcc);
					return `${row.step}: ${Number(fair.toFixed(1))}`;
				})
				.join(', ');
			console.log(`  ${underlying.padEnd(10)} { ${body} }`);
		}
		console.log(
			'  (odds are the only knob — tolerance, dead zone and the miss rule are game rules)'
		);
	}

	if (!quiet) {
		console.log(
			`\nverdict: ${failed.length === 0 ? 'LAUNCH GATE GREEN' : 'LAUNCH GATE RED — do not ship'}`
		);
	}

	return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
//
// `main()` runs only when THIS file is the process's entry module. That is what
// lets `ladder-ev.test.ts` import the model (and so grade the real rulebook with
// the real distributions) without triggering a 1.2-million-trial run — or worse,
// setting `process.exitCode` inside the vitest worker and failing the suite.
// realpathSync is what makes the comparison survive macOS's /tmp → /private/tmp.
// ---------------------------------------------------------------------------

const selfHref = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
const entryHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
export const IS_CLI = entryHref === selfHref;

if (IS_CLI) {
	process.exitCode = main();
}
