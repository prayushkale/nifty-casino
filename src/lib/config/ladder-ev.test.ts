/**
 * CI wrapper for the EV launch gate (PLAN §5 T15).
 *
 *   ⚠️  THE REAL GATE IS THE SCRIPT, NOT THIS TEST:
 *
 *       npx tsx scripts/simulate-ev.ts          (200,000 samples, ~2s, exits 1 on failure)
 *
 *   This file runs the SAME model — the same distributions and the same
 *   `computeTier`/`payoutFor` grading — at 2,000 samples so that `npm test` catches
 *   an odds edit that silently wrecks the house edge before anyone remembers to run
 *   the script. Re-tuning means re-running the script and updating ladder.ts's
 *   provenance comment; this test should survive that untouched.
 *
 * STRIKE-LADDER NOTE: with one MAX (28×) shared by every strike across the whole
 * ±3% CAS band, EV falls with distance by design — a near strike is likelier to
 * be hit than a far one at the same price. So unlike the old four-rung ladder,
 * there is NO per-option EV floor: the gate is the CEILING (no player-favourable
 * strike) plus the pooled house-edge check.
 *
 * The script is imported, not reimplemented, so the two can never drift: a change to
 * the distribution model moves both together.
 */
import { describe, expect, it } from 'vitest';
import {
	BASE_SCENARIO,
	DEFAULT_SEED,
	EV_BAND,
	SCENARIOS,
	SIM_ANCHORS,
	STAKE,
	simulateUnderlying
} from '../../../scripts/simulate-ev';
import { MAX_HIT_ODDS, ladderStrikesForAnchor, LADDER_UNDERLYINGS } from './ladder';

/** The documented fast sample count. Small on purpose — see the header. */
const SAMPLES = 2_000;
/** The CI band: the ceiling is the real gate; the floor is 0 by construction. */
const CI_EV_BAND = { lo: 0, hi: 1.15 } as const;

describe('EV sanity (fast CI wrapper on the launch gate)', () => {
	it('runs the base scenario of the real simulator, not a local copy of the model', () => {
		expect(BASE_SCENARIO.name).toBe('base');
		expect(BASE_SCENARIO.gated).toBe(true);
		// Every other scenario exists only to be printed by the script.
		expect(SCENARIOS.filter((s) => s.gated)).toHaveLength(1);
	});

	it('simulates exactly the strikes the generator builds for the sim anchor', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = simulateUnderlying(underlying, BASE_SCENARIO, 0, SAMPLES, DEFAULT_SEED);
			// Rows follow the strikes the generator builds: every CE distance, then
			// any PE distance that does not already share a CE strike row.
			const { up, down } = ladderStrikesForAnchor(SIM_ANCHORS[underlying], underlying);
			expect(
				rows.map((r) => r.step),
				underlying
			).toEqual([...up, ...down.filter((step) => !up.includes(step))]);
			for (const row of rows) {
				expect(row.odds, `${underlying} ±${row.step}`).toBe(MAX_HIT_ODDS);
			}
		}
	});

	it('keeps every strike at or under the ceiling — no player-favourable strike', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = simulateUnderlying(underlying, BASE_SCENARIO, 0, SAMPLES, DEFAULT_SEED);
			for (const row of rows) {
				const ev = (row.payoutUp + row.payoutDown) / (row.trials * STAKE);
				expect(ev, `${underlying} ±${row.step} @ ${row.odds}× EV=${ev.toFixed(4)}`).toBeLessThan(
					CI_EV_BAND.hi
				);
			}
		}
	});

	it('still grades a pooled house edge, not a player-favourable ladder', () => {
		// The ceiling above is per-strike; this is the whole-book check. With one
		// MAX over a fine ladder the pooled EV sits well below the old 0.90 launch
		// point — near strikes carry the play, far strikes carry the edge — but it
		// must never reach 1.
		let staked = 0;
		let credited = 0;
		for (const underlying of LADDER_UNDERLYINGS) {
			for (const row of simulateUnderlying(underlying, BASE_SCENARIO, 0, SAMPLES, DEFAULT_SEED)) {
				staked += row.trials * STAKE;
				credited += row.payoutUp + row.payoutDown;
			}
		}
		const ev = credited / staked;
		expect(ev).toBeLessThan(EV_BAND.hi);
	});

	it('keeps the launch band the script gates on', () => {
		// Accuracy-graded single-max over the full strike band: only the ceiling
		// (no player-favourable strike) is gated; lo = 0 documents that far
		// strikes are allowed to be house-heavy.
		expect(EV_BAND).toEqual({ lo: 0, hi: 0.95 });
	});
});
