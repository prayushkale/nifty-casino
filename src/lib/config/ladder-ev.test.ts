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
 *   the script. 2,000 samples gives EV a Monte-Carlo standard error of roughly ±0.07,
 *   which is why the band here is deliberately WIDE (0.5, 1.15): the test is a tripwire
 *   for a badly wrong price, not a measurement of the 5–15% edge the launch gate
 *   demands. Re-tuning odds means re-running the script and updating ladder.ts's
 *   provenance comment; this test should survive that untouched.
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
	STAKE,
	simulateUnderlying
} from '../../../scripts/simulate-ev';
import { LADDER_CONFIG, LADDER_UNDERLYINGS } from './ladder';

/** The documented fast sample count. Small on purpose — see the header. */
const SAMPLES = 2_000;
/** The wide CI band, centred on the launch band's midpoint and ~5σ either side. */
const CI_EV_BAND = { lo: 0.5, hi: 1.15 } as const;

describe('EV sanity (fast CI wrapper on the launch gate)', () => {
	it('runs the base scenario of the real simulator, not a local copy of the model', () => {
		expect(BASE_SCENARIO.name).toBe('base');
		expect(BASE_SCENARIO.gated).toBe(true);
		// Every other scenario exists only to be printed by the script.
		expect(SCENARIOS.filter((s) => s.gated)).toHaveLength(1);
	});

	it('prices every configured step', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = simulateUnderlying(underlying, BASE_SCENARIO, 0, SAMPLES, DEFAULT_SEED);
			expect(
				rows.map((r) => r.step),
				underlying
			).toEqual([...LADDER_CONFIG[underlying].steps]);
			for (const row of rows) {
				expect(row.odds, `${underlying} ±${row.step}`).toBe(
					LADDER_CONFIG[underlying].odds[row.step]
				);
			}
		}
	});

	it('lands every option inside the wide CI band — a silent odds break fails here', () => {
		for (const underlying of LADDER_UNDERLYINGS) {
			const rows = simulateUnderlying(underlying, BASE_SCENARIO, 0, SAMPLES, DEFAULT_SEED);
			for (const row of rows) {
				const ev = (row.payoutUp + row.payoutDown) / (row.trials * STAKE);
				expect(ev, `${underlying} ±${row.step} @ ${row.odds}× EV=${ev.toFixed(4)}`).toBeGreaterThan(
					CI_EV_BAND.lo
				);
				expect(ev, `${underlying} ±${row.step} @ ${row.odds}× EV=${ev.toFixed(4)}`).toBeLessThan(
					CI_EV_BAND.hi
				);
			}
		}
	});

	it('still grades a house edge, not a player-favourable ladder', () => {
		// The wide band above would let EV drift to 1.14 without failing; that is a
		// loss-making game. At the launch odds the *point estimate* sits ~0.90, so a
		// run whose pooled EV is not clearly below 1 means the odds moved.
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
		expect(ev).toBeGreaterThan(EV_BAND.lo - 0.05);
	});

	it('keeps the launch band the script gates on', () => {
		expect(EV_BAND).toEqual({ lo: 0.85, hi: 0.95 });
	});
});
