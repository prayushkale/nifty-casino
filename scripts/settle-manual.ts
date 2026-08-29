/**
 * scripts/settle-manual.ts — the manual settlement escape hatch (docs/RUNBOOK.md
 * → "Manual settle"). Runs one settle cycle for a trading day, OUTSIDE the
 * scheduler's 15:43–17:00 IST window, using the same `settleNow` the in-process
 * scheduler would have called. Nothing here re-implements settlement.
 *
 *   npx tsx scripts/settle-manual.ts                     # today's IST date
 *   npx tsx scripts/settle-manual.ts --date 2026-08-28   # a stuck past day
 *   npx tsx scripts/settle-manual.ts --no-capture        # closes already in place
 *   npx tsx scripts/settle-manual.ts --dry-run           # read-only
 *
 * WHAT IT WILL NOT DO (the honesty rules, unchanged from the engine):
 *
 *  • It never invents a close. A missing NIFTY/BANKNIFTY/SENSEX official close
 *    comes back as `incomplete`, the session stays `open`, and nothing is paid.
 *  • It only attempts a capture for TODAY's IST date, and only after 15:42 IST.
 *    A past date settles against whatever `index_closes` already holds — it is
 *    never back-filled with today's feed. `--no-capture` skips the attempt.
 *  • It is idempotent. Re-running a settled day is a no-op report; the
 *    `ledger_payout_once` partial unique index makes double-payment impossible.
 *
 * Requires DATABASE_URL (a real Postgres). Without it the script refuses: settling
 * the in-memory store would be theatre, and the exit code says so. `--dry-run`
 * still needs the store (it reports on real rows) but writes nothing.
 *
 * Exit codes: 0 = settled or already-settled. 1 = refused or incomplete — the
 * day is NOT done, and a cron/CI caller should treat that as an alert.
 */
import { CUTOFF_HMS } from '$lib/config/app';
import { isWeekend, istDateStr, istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { settleNow } from '$lib/server/settle/scheduler';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

type Args = {
	tradeDate: string;
	capture: boolean;
	dryRun: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage(): string {
	return [
		'Usage: npx tsx scripts/settle-manual.ts [--date YYYY-MM-DD] [--no-capture] [--dry-run]',
		'',
		'  --date YYYY-MM-DD  IST trade date (default: today). Must not be in the future.',
		'  --no-capture       Do not attempt an official-close capture; settle against',
		'                     index_closes as it stands (use when the closes are already',
		'                     in place and the feed is down).',
		'  --dry-run          Print the day and the closes, write nothing.',
		'',
		'Requires DATABASE_URL. See docs/RUNBOOK.md → "Manual settle".'
	].join('\n');
}

function parseArgs(argv: string[]): Args {
	let tradeDate = istDateStr();
	let capture = true;
	let dryRun = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (name: string): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
			i += 1;
			return next;
		};
		if (arg === '--date') tradeDate = value(arg);
		else if (arg === '--no-capture') capture = false;
		else if (arg === '--dry-run') dryRun = true;
		else if (arg === '--help' || arg === '-h') throw new UsageError(usage());
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (!isRealCalendarDate(tradeDate)) {
		throw new Error(`--date must be a real YYYY-MM-DD calendar date (got "${tradeDate}")`);
	}
	const today = istDateStr();
	if (tradeDate > today) {
		throw new Error(`--date ${tradeDate} is in the future (today is ${today} IST) — refusing`);
	}
	return { tradeDate, capture, dryRun };
}

/** A usage message is not a stack trace — carried out of band, printed without one. */
class UsageError extends Error {}

/** 15:20:00 IST of `tradeDate`, in epoch ms — the cutoff the session row carries. */
function cutoffMsFor(tradeDate: string): number {
	return istHmsToUtcMs(istDateStrToMidnightUtcMs(tradeDate), CUTOFF_HMS);
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

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err: unknown) {
		const isUsage = err instanceof UsageError;
		console.error(`[settle-manual] ${(err as Error).message}`);
		if (!isUsage) console.error(`\n${usage()}`);
		// `--help` is a success, not a failure.
		return isUsage ? 0 : 1;
	}

	const databaseUrl = process.env['DATABASE_URL']?.trim();
	if (!databaseUrl) {
		console.error(
			'[settle-manual] DATABASE_URL is not set — refusing. Settlement must land in the real\n' +
				'store; settling the in-memory fallback would report success and change nothing.'
		);
		return 1;
	}

	const { tradeDate, capture, dryRun } = args;
	const store = getStore();

	const session = await store.sessions.getSessionByDate(tradeDate);
	const closes = await store.closes.getIndexCloses(tradeDate);

	console.info(
		`[settle-manual] ${tradeDate}` +
			`${isWeekend(tradeDate) ? ' (WEEKEND)' : ''}` +
			` session=${session ? session.status : 'none'}` +
			` cutoff=${new Date(cutoffMsFor(tradeDate)).toISOString()}` +
			` closes=${closes.map((c) => `${c.underlying}:${c.close}(${c.source})`).join(', ') || 'none'}` +
			`${capture ? '' : ' capture=off'}${dryRun ? ' [dry-run]' : ''}`
	);

	if (!session) {
		console.error(
			'[settle-manual] no session row for this date — nobody could bet, so there is nothing to\n' +
				'settle and nothing to create. If this date SHOULD have had a session, the day the bets\n' +
				'were placed is the day to look at.'
		);
		return 1;
	}
	if (session.status === 'settling') {
		console.error(
			"[settle-manual] the session is 'settling' — another run claims this day. Do NOT force it\n" +
				'with scripts/session-admin.ts while a settle run may be live; wait for it to finish or\n' +
				'confirm the process is dead first.'
		);
		return 1;
	}
	if (session.status !== 'settled' && !capture && closes.length === 0) {
		console.error(
			'[settle-manual] --no-capture with no index_closes rows: there is nothing to settle\n' +
				'against and this script will not invent a close. Let the capture run, or insert the\n' +
				"exchange's official closes by hand FIRST (docs/RUNBOOK.md → 'Stuck session')."
		);
		return 1;
	}

	if (dryRun) {
		console.info('[settle-manual] dry-run: no capture, no settlement, no writes.');
		return 0;
	}

	const { capture: captureReport, settle } = await settleNow(store, tradeDate, { capture });

	if (captureReport) {
		console.info(
			`[settle-manual] capture attempted=${captureReport.attempted}` +
				` written=[${captureReport.written.join(', ')}]` +
				` missing=[${captureReport.missing.join(', ')}]` +
				(captureReport.errors.length ? ` errors=${captureReport.errors.join(' | ')}` : '') +
				(captureReport.warnings.length ? ` warnings=${captureReport.warnings.join(' | ')}` : '')
		);
	}

	console.info(
		`[settle-manual] status=${settle.status} settled=${settle.settled} skipped=${settle.skipped}` +
			` tiers=${JSON.stringify(settle.tiers)} paidOut=${settle.paidOut} xp=${settle.xpAwarded}` +
			` chunks=${settle.chunks}`
	);

	if (settle.incomplete.length > 0) {
		console.error(
			`[settle-manual] INCOMPLETE — no usable official close for ${settle.incomplete.join(', ')}.` +
				' The session is back to `open` and nothing was paid for those bets. Fix the feed, then' +
				' re-run this script; it is idempotent.'
		);
		return 1;
	}
	if (settle.status === 'no-session' || settle.status === 'busy') {
		console.error(`[settle-manual] ${settle.status}: the day was not settled.`);
		return 1;
	}

	console.info(
		`[settle-manual] done. Verify with:` +
			`\n  select trade_date, status from daily_sessions where trade_date = '${tradeDate}';` +
			`\n  select settlement_tier, count(*), sum(payout) from bets where session_id = ${session.id} group by 1;`
	);
	return 0;
}

// Run-as-module guard (mirrors scripts/simulate-ev.ts): vitest imports this file
// for its helpers without executing main().
const isEntry =
	process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isEntry) {
	const exitCode = await main();
	// Drop the process store so a repeated import in the same run cannot hold a pool.
	resetStoreForTests();
	process.exitCode = exitCode;
}
