/**
 * CAS curve time-series primitives (server-side port of Market OI Analyzer's
 * `cas-series.ts`, trimmed to what the tick store needs).
 *
 * The CAS indicative close is a point-sampled value (one number per poll), so
 * the "candles" reconstructed from it are flat (O=H=L=C = the sampled value of
 * the bucket). Ticks are captured per poll (~4s) and capped to a session-length
 * window; candles are derived on demand for charting (Task 12).
 */

import { RING_BUFFER_CAP } from '$lib/config/app';
import { istDateStr } from '$lib/time/ist';

/** One captured CAS indicative value. ts = epoch ms (IST wall time is derived from it). */
export type CasTick = { ts: number; value: number };

/** ~48 minutes @ 4s polls — comfortably covers the 15:13:30–15:42:00 window. */
export const MAX_CAS_TICKS = RING_BUFFER_CAP;

/**
 * Append incoming ticks to the series:
 *  - drops ticks with ts <= the newest retained tick (stale poll / ts collision, first wins)
 *  - drops non-positive values (indicative close is 0 outside the window)
 *  - trims to MAX_CAS_TICKS from the front when over the cap
 */
export function appendCasTicks(existing: CasTick[], incoming: CasTick[]): CasTick[] {
	const out = [...existing];
	let lastTs = out.length ? out[out.length - 1].ts : -Infinity;
	for (const t of incoming) {
		if (t.ts <= lastTs) continue;
		if (t.value <= 0) continue;
		lastTs = t.ts;
		out.push(t);
	}
	return out.length > MAX_CAS_TICKS ? out.slice(out.length - MAX_CAS_TICKS) : out;
}

/** IST date string "YYYY-MM-DD" for a tick timestamp (UTC+5:30, no DST in India). */
export function istDateForTick(ts: number): string {
	return istDateStr(new Date(ts));
}
