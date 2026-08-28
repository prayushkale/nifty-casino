/**
 * Test-only IST clock helper.
 *
 * Lets a test write "15:13:30 IST on Wednesday 2026-08-26" instead of hand-rolled
 * UTC arithmetic. Imported by *.test.ts files only — never by app code.
 */
import { istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';

/** A Wednesday. */
export const WEDNESDAY = '2026-08-26';
/** The Thursday after {@link WEDNESDAY}. */
export const THURSDAY = '2026-08-27';
/** A Saturday (market closed). */
export const SATURDAY = '2026-08-29';

/** IST wall-clock time on `dateStr` → epoch ms. */
export function istAt(dateStr: string, h: number, m: number, s = 0, ms = 0): number {
	return istHmsToUtcMs(istDateStrToMidnightUtcMs(dateStr), { h, m, s }) + ms;
}
