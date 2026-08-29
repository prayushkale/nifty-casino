/**
 * The settlement engine (PLAN §5 T9) — one trading day, from "bets are in" to
 * "every wallet is paid", as few times as possible.
 *
 * Division of labour:
 *
 *   $lib/game/tier     — the rulebook: `computeTier`/`payoutFor` decide a bet's fate
 *                          (shared with the browser's payout preview — see its header)
 *   ../settle/capture  — how an official close gets into `index_closes` (the scheduler calls it)
 *   THIS module        — the orchestration: which bets, against which closes, in
 *                        which transactions, and what happens when a close is missing
 *   GameStore          — the money itself, one chunk per transaction (./db/money)
 *
 * The day's shape:
 *
 *   1. claim   — the session is flipped `open` → `settling` with a conditional
 *                UPDATE, so two overlapping runs cannot both own the day
 *   2. decide  — anchors from the ladder's walk-back, today's close from
 *                `source = 'official'` ONLY; a missing close or an `abstain`
 *                verdict parks that underlying's bets for a later re-run
 *   3. settle  — outcomes in chunks of SETTLE_CHUNK, one transaction per chunk
 *                (PLAN §6 R7: 30 lakh bets a day must not be one transaction)
 *   4. gamify  — XP + streak for every user who had a bet settle in this run
 *   5. close   — complete → `settled`; incomplete → back to `open` so the
 *                scheduler retries, with the list of what was missing
 *
 * IDEMPOTENCY, the property everything else leans on: a settled bet can never be
 * paid twice, because `settleBets` re-reads the row inside its transaction and
 * backs that up with the `ledger_payout_once` partial unique index. XP and streaks
 * are derived from the bets THIS run actually settled (never from a recount of the
 * day), so a re-run adds nothing. The one hole — a crash between step 3 and step 4 —
 * loses a user their XP for that day; it can never double-pay, and money is the
 * part that must not be wrong.
 */
import { SETTLE_CHUNK, XP_PER_BET, XP_PER_HIT } from '$lib/config/app';
import { LADDER_UNDERLYINGS, type LadderUnderlying } from '$lib/config/ladder';
import { isWeekend, shiftIstDate } from '$lib/time/ist';
import { getLadderForDate, invalidateLadderCache } from '$lib/server/ladder';
import type { GameStore } from '$lib/server/db';
import type { Underlying } from '$lib/server/db/types';
import { computeTier, payoutFor, type PayableTier } from '$lib/game/tier';

/** How many calendar days back a streak (or an anchor) may look for a trading day. */
export const SETTLE_MAX_LOOKBACK_DAYS = 10;

/** The previous trading day of `tradeDate` — weekends are skipped, not terminal. */
export function prevTradingDay(
	tradeDate: string,
	maxLookback = SETTLE_MAX_LOOKBACK_DAYS
): string | null {
	for (let back = 1; back <= maxLookback; back += 1) {
		const candidate = shiftIstDate(tradeDate, -back);
		if (!isWeekend(candidate)) return candidate;
	}
	return null;
}

/** Tunables overridable per call — tests inject a chunk size and a clock. */
export type SettleOptions = {
	/** Bets per transaction. Defaults to {@link SETTLE_CHUNK}. */
	chunkSize?: number;
	/** The instant the run is judged at (`bets.settled_at`). Defaults to now. */
	nowMs?: number;
	log?: Pick<Console, 'info' | 'warn' | 'error'>;
};

/** Every way a run can end. `settled` and `already-settled` are the only good ones. */
export type SettleStatus = 'settled' | 'incomplete' | 'already-settled' | 'busy' | 'no-session';

export type SettleReport = {
	tradeDate: string;
	sessionId: number | null;
	status: SettleStatus;
	/** True when this run wrote nothing at all because the day was already done. */
	idempotent: boolean;
	/** Bets settled by this run. */
	settled: number;
	/** Bets this run found already settled (an earlier run, or a pre-settled bet). */
	skipped: number;
	/** Transactions the money path used (1 per chunk). */
	chunks: number;
	/** Verdicts this run reached, per tier. */
	tiers: Record<PayableTier, number>;
	/** NC credited by this run. */
	paidOut: number;
	/** XP awarded by this run. */
	xpAwarded: number;
	/** Users this run touched (money or XP). */
	users: string[];
	/** Underlyings left unsettled and why — empty when the day is complete. */
	incomplete: Underlying[];
	/** `undefined` on a clean run. */
	reason?: string;
};

/** A close that may anchor a payout: positive and finite, or not usable at all. */
function usable(row: { close: number }): boolean {
	return Number.isFinite(row.close) && row.close > 0;
}

/**
 * Settle one trading day. Safe to call twice; the second call is a no-op report.
 * Throws only on a store failure — every "cannot settle honestly" outcome is a
 * returned report, never an exception.
 */
export async function settleSession(
	store: GameStore,
	tradeDate: string,
	options: SettleOptions = {}
): Promise<SettleReport> {
	const log = options.log ?? console;
	const chunkSize = Math.max(1, options.chunkSize ?? SETTLE_CHUNK);
	const nowMs = options.nowMs ?? Date.now();

	const report: SettleReport = {
		tradeDate,
		sessionId: null,
		status: 'no-session',
		idempotent: false,
		settled: 0,
		skipped: 0,
		chunks: 0,
		tiers: { hit: 0, flat: 0, miss: 0 },
		paidOut: 0,
		xpAwarded: 0,
		users: [],
		incomplete: []
	};

	const session = await store.sessions.getSessionByDate(tradeDate);
	// No session row means nobody could bet: nothing to settle and nothing to create
	// — the scheduler must not invent sessions for days nobody played.
	if (!session) return report;
	report.sessionId = session.id;

	if (session.status === 'settled') {
		return { ...report, status: 'already-settled', idempotent: true };
	}
	// The claim is the re-entry guard: a `settling` row belongs to another run.
	const claimed = await store.sessions.setSessionStatusIf(session.id, 'settling', [
		'open',
		'locked'
	]);
	if (!claimed) return { ...report, status: 'busy' };

	try {
		// 2. Anchors. The ladder caches per process for the day, and it may have been
		//    asked for this morning — before the previous day's OFFICIAL close landed.
		//    Settlement is the one reader that must re-resolve, so the cache goes first.
		invalidateLadderCache();
		const ladder = await getLadderForDate(store, tradeDate);

		// Today's close, official only. A `live_approx` row is the feed's running
		// estimate of the PREVIOUS close — settling on it would pay against a number
		// the exchange never published.
		const closes = await store.closes.getIndexCloses(tradeDate);
		const official = new Map<Underlying, number>();
		for (const row of closes) {
			if (row.source === 'official' && usable(row)) official.set(row.underlying, row.close);
		}

		const bets = await store.bets.listBetsForSession(session.id);
		const missing = new Set<Underlying>();
		// Per-user roll-up of what THIS run settles — the XP/streak phase's exact input.
		const userTallies = new Map<string, UserTally>();
		type Outcome = {
			betId: string;
			userId: string;
			stake: number;
			odds: number;
			tier: PayableTier;
			payout: number;
		};
		const outcomes: Outcome[] = [];

		for (const bet of bets) {
			// Already settled (a previous run, or a hand-pre-settled row): the driver
			// would skip it anyway, so leave it out of the chunk entirely.
			if (bet.settledAt !== null) continue;

			const underlying = bet.underlying as LadderUnderlying;
			const prevClose = ladder.anchors[underlying];
			const close = official.get(bet.underlying);

			if (prevClose === null || close === undefined) {
				missing.add(bet.underlying);
				continue;
			}
			const tier = computeTier(
				{
					underlying,
					targetKind: bet.targetKind,
					deltaPoints: bet.deltaPoints
				},
				prevClose,
				close
			);
			// An unusable anchor is an abstain: those bets wait for a re-run too.
			if (tier === 'abstain') {
				missing.add(bet.underlying);
				continue;
			}
			outcomes.push({
				betId: bet.id,
				userId: bet.userId,
				stake: bet.stake,
				odds: bet.odds,
				tier,
				payout: payoutFor(tier, bet.stake, bet.odds)
			});
			report.tiers[tier] += 1;
		}
		report.incomplete = LADDER_UNDERLYINGS.filter((underlying) => missing.has(underlying));

		// 3. The money, in chunks. Each chunk is its own transaction, so a failure
		//    costs one chunk and the payout-once ledger makes retrying it free.
		for (let i = 0; i < outcomes.length; i += chunkSize) {
			const result = await store.settleBets({
				sessionId: session.id,
				tradeDate,
				outcomes: outcomes.slice(i, i + chunkSize),
				settledAtMs: nowMs
			});
			report.chunks += 1;
			report.settled += result.settled;
			report.skipped += result.skipped;
			report.paidOut += result.byUser.reduce((total, tally) => total + tally.payout, 0);
			for (const tally of result.byUser) {
				const existing = userTallies.get(tally.userId);
				if (existing) {
					existing.settled += tally.settled;
					existing.hits += tally.hits;
				} else {
					userTallies.set(tally.userId, { settled: tally.settled, hits: tally.hits });
				}
			}
		}
		report.users = [...userTallies.keys()].sort();

		// 4. Gamification, one transaction per affected user. Only users who had a bet
		//    settle in THIS run: a re-run must not re-award XP for bets it did not settle.
		for (const userId of report.users) {
			const tally = userTallies.get(userId);
			if (!tally) continue;
			await settleProgress(store, userId, tradeDate, tally);
			report.xpAwarded += XP_PER_BET * tally.settled + XP_PER_HIT * tally.hits;
		}

		// 5. Complete → settled. Incomplete → back to `open`, so the scheduler (or a
		//    human) can re-run the day once the missing closes arrive.
		if (report.incomplete.length === 0) {
			await store.sessions.setSessionStatus(session.id, 'settled');
			report.status = 'settled';
			log.info(
				`[settle] ${tradeDate} settled: ${report.settled} bet(s) across ${report.chunks} chunk(s), ` +
					`${report.paidOut} NC paid out, ${report.xpAwarded} XP awarded` +
					(report.skipped > 0 ? `, ${report.skipped} already settled` : '')
			);
			return report;
		}

		await store.sessions.setSessionStatus(session.id, 'open');
		report.status = 'incomplete';
		report.reason = `no official close for ${report.incomplete.join(', ')}`;
		log.warn(`[settle] ${tradeDate} incomplete — ${report.reason}; bets left for a re-run`);
		return report;
	} catch (err: unknown) {
		// Release the claim: a day stuck in `settling` would block every later run.
		await store.sessions.setSessionStatusIf(session.id, 'open', ['settling']);
		throw err;
	}
}

/** Per-user roll-up of one run's settlements — exactly what the XP/streak phase needs. */
type UserTally = { settled: number; hits: number };

/**
 * XP + streak for one user on one settled day. Deliberately derived from the bets
 * this run settled (`tally`), never from a recount of the day: a bet's XP is awarded
 * in the same run that settles it, so re-running a day cannot award it twice.
 */
async function settleProgress(
	store: GameStore,
	userId: string,
	tradeDate: string,
	tally: UserTally
): Promise<void> {
	await store.tx(async (t) => {
		const profile = await t.profiles.lockForUpdate(userId);
		// The wallet was credited in the chunk tx, so a missing profile here would be
		// a data fault — but XP is not worth aborting the day over.
		if (!profile) return;

		const xpDelta = XP_PER_BET * tally.settled + XP_PER_HIT * tally.hits;

		// Streak: unchanged when this day is already the user's last betting day
		// (a re-run), +1 when it continues yesterday's, otherwise a fresh streak.
		// A `lastBetDate` later than this trade date means someone is settling an old
		// session out of order — leave the newer streak alone rather than rewinding it.
		const yesterday = prevTradingDay(tradeDate);
		const isNewerDay = profile.lastBetDate !== null && profile.lastBetDate > tradeDate;
		const lastBetDate =
			isNewerDay && profile.lastBetDate !== null ? profile.lastBetDate : tradeDate;
		const streakDays = isNewerDay
			? profile.streakDays
			: profile.lastBetDate === tradeDate
				? profile.streakDays
				: profile.lastBetDate === yesterday
					? profile.streakDays + 1
					: 1;

		await t.profiles.applyProfileProgress(userId, { xpDelta, streakDays, lastBetDate });
	});
}
