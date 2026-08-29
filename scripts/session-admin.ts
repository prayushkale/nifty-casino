/**
 * scripts/session-admin.ts — the stuck-session lever (docs/RUNBOOK.md → "Stuck
 * session"). ONE job: flip a `daily_sessions` row back to `open` after a crashed
 * or killed settle run left it wedged in `settling`/`locked`, so the scheduler can
 * claim the day again. It writes nothing else — it never touches `bets`, `ledger`,
 * `index_closes` or `daily_pots`.
 *
 *   npx tsx scripts/session-admin.ts --date 2026-08-28 --show
 *   npx tsx scripts/session-admin.ts --date 2026-08-28 --to open --expect settling --dry-run
 *   npx tsx scripts/session-admin.ts --date 2026-08-28 --to open --expect settling
 *
 * WHY THE GUARDS:
 *
 *  • `--to open` is the only status this script will ever write. Anything else is
 *    a hand-written SQL decision and should be made slowly, in psql, with a backup.
 *  • `--expect <status>` turns the write into a compare-and-set
 *    (`setSessionStatusIf`), so the day only moves if it is still where you think
 *    it is. If another run moved it first, the write loses and says so.
 *  • `settling` needs `--confirm-no-live-run`, because flipping a day back to
 *    `open` while a settle loop is mid-run would let a second run claim it. The
 *    ledger's payout-once index still makes double-payment impossible, but two
 *    runs racing is a mess you do not want to debug at 16:00.
 *  • `settled` needs `--allow-reopen-settled`. Reopening a settled day makes the
 *    UI show it as unsettled until something settles it again; settlement itself
 *    is idempotent, so no money can move twice — but there is no good reason to do
 *    this, and the flag exists to make you type it.
 *
 * NEVER, under any circumstance, INSERT/UPDATE `index_closes` while a settle run
 * might be live (PLAN §5 T9: `captureOfficialCloses` is the only writer of
 * `source = 'official'` rows, and it never overwrites one). See the RUNBOOK.
 *
 * Requires DATABASE_URL. Exit codes: 0 = shown, or written; 1 = refused.
 */
import { CUTOFF_HMS } from '$lib/config/app';
import { istDateStr, istDateStrToMidnightUtcMs, istHmsToUtcMs } from '$lib/time/ist';
import { getStore, resetStoreForTests } from '$lib/server/db';
import { SESSION_STATUSES } from '$lib/server/db/types';
import type { Bet, SessionStatus } from '$lib/server/db/types';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

type Args = {
	tradeDate: string;
	show: boolean;
	to: SessionStatus | null;
	expect: SessionStatus[];
	dryRun: boolean;
	confirmNoLiveRun: boolean;
	allowReopenSettled: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage(): string {
	return [
		'Usage: npx tsx scripts/session-admin.ts --date YYYY-MM-DD (--show | --to open [--expect STATUS])',
		'',
		'  --show                 Print the session row + a bet summary. Writes nothing.',
		'  --to open              The one write this script can make: put a stuck day back in',
		'                         `open` so the settlement scheduler can claim it again.',
		'  --expect STATUS        Compare-and-set guard: only write if the row is currently in',
		'                         STATUS (' + SESSION_STATUSES.join('|') + '). Strongly recommended.',
		'  --dry-run              Say what would happen, write nothing.',
		'  --confirm-no-live-run  Required to move a day out of `settling`. Pass it only after',
		'                         you have confirmed no settle loop is running (see RUNBOOK).',
		'  --allow-reopen-settled Required to move a day out of `settled`. Almost always wrong.',
		'',
		'Requires DATABASE_URL. See docs/RUNBOOK.md → "Stuck session".'
	].join('\n');
}

/** A usage message is not a stack trace — carried out of band, printed without one. */
class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		tradeDate: istDateStr(),
		show: false,
		to: null,
		expect: [],
		dryRun: false,
		confirmNoLiveRun: false,
		allowReopenSettled: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (name: string): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
			i += 1;
			return next;
		};
		if (arg === '--date') args.tradeDate = value(arg);
		else if (arg === '--show') args.show = true;
		else if (arg === '--to') args.to = value(arg) as SessionStatus;
		else if (arg === '--expect') args.expect.push(value(arg) as SessionStatus);
		else if (arg === '--dry-run') args.dryRun = true;
		else if (arg === '--confirm-no-live-run') args.confirmNoLiveRun = true;
		else if (arg === '--allow-reopen-settled') args.allowReopenSettled = true;
		else if (arg === '--help' || arg === '-h') throw new UsageError(usage());
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (!isRealCalendarDate(args.tradeDate)) {
		throw new Error(`--date must be a real YYYY-MM-DD calendar date (got "${args.tradeDate}")`);
	}
	if (!args.show && !args.to) throw new Error('nothing to do: pass --show or --to open');
	if (args.to !== null && args.to !== 'open') {
		throw new Error(
			`--to only accepts "open" (got "${args.to}"). Any other transition is a hand-written SQL` +
				' decision — see docs/RUNBOOK.md → "Stuck session" for the safe recipe.'
		);
	}
	for (const status of args.expect) {
		if (!SESSION_STATUSES.includes(status)) {
			throw new Error(`--expect must be one of ${SESSION_STATUSES.join('|')} (got "${status}")`);
		}
	}
	const today = istDateStr();
	if (args.tradeDate > today) {
		throw new Error(`--date ${args.tradeDate} is in the future (today is ${today} IST) — refusing`);
	}
	return args;
}

/** 15:20:00 IST of `tradeDate`, in epoch ms — what `daily_sessions.cutoff_at` holds. */
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

function describeBets(bets: Bet[]): string {
	if (bets.length === 0) return 'no bets';
	const tiers = bets.reduce<Record<string, number>>((acc, bet) => {
		const key = bet.settlementTier ?? 'unsettled';
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	}, {});
	const staked = bets.reduce((sum, bet) => sum + bet.stake, 0);
	const paid = bets.reduce((sum, bet) => sum + (bet.payout ?? 0), 0);
	return `${bets.length} bet(s), ${staked} NC staked, ${paid} NC paid — ${JSON.stringify(tiers)}`;
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err: unknown) {
		const isUsage = err instanceof UsageError;
		console.error(`[session-admin] ${(err as Error).message}`);
		if (!isUsage) console.error(`\n${usage()}`);
		// `--help` is a success, not a failure.
		return isUsage ? 0 : 1;
	}

	if (!process.env['DATABASE_URL']?.trim()) {
		console.error(
			'[session-admin] DATABASE_URL is not set — refusing. The in-memory fallback would report' +
				' success and change nothing.'
		);
		return 1;
	}

	const db = getStore();
	const session = await db.sessions.getSessionByDate(args.tradeDate);

	if (!session) {
		console.error(
			`[session-admin] no session row for ${args.tradeDate}. Nothing to un-stick. The scheduler` +
				' only ever settles days that have a row (a row appears when the first bet is placed).'
		);
		return 1;
	}

	const bets = await db.bets.listBetsForSession(session.id);
	console.info(
		`[session-admin] ${args.tradeDate}: id=${session.id} status=${session.status}` +
			` cutoff=${new Date(cutoffMsFor(args.tradeDate)).toISOString()} — ${describeBets(bets)}`
	);

	if (args.show || args.dryRun) {
		const expected = args.expect.length ? args.expect.join('|') : 'any non-open status';
		console.info(
			args.show
				? '[session-admin] --show: read-only, nothing written.'
				: `[session-admin] dry-run: would write status open (guard: ${expected}). Nothing written.`
		);
		return 0;
	}

	if (session.status === 'settling' && !args.confirmNoLiveRun) {
		console.error(
			'[session-admin] REFUSED: the day is in `settling`, which normally means a settle run owns' +
				' it right now. Confirm no run is live first:\n' +
				'    journalctl -u niftycasino -n 200 | grep -i settle\n' +
				'  …then re-run with --confirm-no-live-run --expect settling.'
		);
		return 1;
	}
	if (session.status === 'settled' && !args.allowReopenSettled) {
		console.error(
			'[session-admin] REFUSED: this day is already `settled` and its bets are paid. Reopening it' +
				' is almost never what you want (the UI would show it as unsettled until something' +
				' settles it again). Pass --allow-reopen-settled only if you are certain.'
		);
		return 1;
	}

	const expected = args.expect.length ? args.expect : SESSION_STATUSES.filter((s) => s !== 'open');
	console.warn(
		`[session-admin] FORCING ${args.tradeDate} (id=${session.id}) ${session.status} → open` +
			` unless it is no longer in {${expected.join(', ')}}. This is a manual override of the day's` +
			' state machine — the settlement engine remains the only thing that can pay anyone.'
	);

	const won = await db.sessions.setSessionStatusIf(session.id, 'open', expected);
	if (!won) {
		console.error(
			`[session-admin] the write did not land: the row is no longer in {${expected.join(', ')}}.` +
				' Re-run with --show to see where it went.'
		);
		return 1;
	}

	console.info(
		`[session-admin] done — ${args.tradeDate} is ` +
			`${(await db.sessions.getSessionByDate(args.tradeDate))?.status}.` +
			' Next: fix the underlying problem, then scripts/settle-manual.ts.'
	);
	return 0;
}

// Run-as-module guard (mirrors scripts/simulate-ev.ts): vitest imports this file
// for its helpers without executing main().
const isEntry =
	process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isEntry) {
	const exitCode = await main();
	resetStoreForTests();
	process.exitCode = exitCode;
}
