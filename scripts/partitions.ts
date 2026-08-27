/**
 * scripts/partitions.ts — monthly partitions for `cas_ticks`, plus retention.
 *
 *   npx tsx scripts/partitions.ts --months 6 --retention-days 90
 *
 * `cas_ticks` is declared `PARTITION BY RANGE (trade_date)` in
 * supabase/migrations/0001_init.sql, and Postgres refuses to INSERT into a partitioned
 * table that has no matching partition — so this script is not optional. It is
 * deliberately NOT part of the migration because the window to pre-create and the
 * retention horizon are deployment decisions (PLAN §6: 90-day retention on cheap
 * partitions), not schema.
 *
 * What it does, in one transaction (all-or-nothing):
 *   1. CREATE monthly `cas_ticks_pYYYYMM` partitions covering today ± `--months`.
 *   2. DROP partitions whose entire range is older than `--retention-days`.
 *   3. Print what it did. Never touches a partition that contains today.
 *
 * Deterministic and idempotent: re-running is a no-op, and the same inputs always
 * produce the same DDL. No network access except the database itself.
 *
 *   --months N           partitions from N months back through N months ahead (default 6)
 *   --retention-days D   drop partitions ending before today − D (default 90)
 *   --dry-run            print the plan, execute nothing
 *
 * DATES are computed on the IST calendar (the app's clock, UTC+5:30 all year) so the
 * partitions line up with `daily_sessions.trade_date`, which is what the rows carry.
 */
import postgres from 'postgres';

/** IST = UTC+5:30, no DST — mirrors APP_TIMEZONE_OFFSET_MIN in src/lib/config/app.ts. */
const IST_OFFSET_MIN = 330;

type Args = { months: number; retentionDays: number; dryRun: boolean };

function parseArgs(argv: string[]): Args {
	let months = 6;
	let retentionDays = 90;
	let dryRun = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		/** Consume the token after `name`, so `--months 6` does not re-parse "6". */
		const value = (name: string): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) {
				throw new Error(`${name} needs a value`);
			}
			i += 1;
			return next;
		};
		if (arg === '--months') months = Number(value(arg));
		else if (arg === '--retention-days') retentionDays = Number(value(arg));
		else if (arg === '--dry-run') dryRun = true;
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (!Number.isInteger(months) || months < 1 || months > 60) {
		throw new Error(`--months must be an integer in 1..60 (got ${months})`);
	}
	if (!Number.isInteger(retentionDays) || retentionDays < 1) {
		throw new Error(`--retention-days must be a positive integer (got ${retentionDays})`);
	}
	return { months, retentionDays, dryRun };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Today's IST calendar date as a UTC-midnight Date (pure calendar arithmetic). */
function todayIst(): Date {
	const shifted = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
	return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** First day of the month, N months from `date`. */
function firstOfMonth(date: Date, months: number): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

/** 'YYYY-MM-DD' for a UTC-midnight date. */
const isoDate = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

type Partition = {
	/** cas_ticks_p202608 */
	name: string;
	/** inclusive lower bound, 'YYYY-MM-DD' */
	from: string;
	/** exclusive upper bound, 'YYYY-MM-DD' */
	to: string;
};

function partitionFor(from: Date): Partition {
	const to = firstOfMonth(from, 1);
	const ym = `${from.getUTCFullYear()}${pad2(from.getUTCMonth() + 1)}`;
	return { name: `cas_ticks_p${ym}`, from: isoDate(from), to: isoDate(to) };
}

/** Monthly partitions covering [firstOfMonth(today − months), firstOfMonth(today + months + 1)). */
function plannedPartitions(months: number, today: Date): Partition[] {
	const out: Partition[] = [];
	for (let m = -months; m <= months; m++) out.push(partitionFor(firstOfMonth(today, m)));
	return out; // ascending by month
}

/** A partition is droppable only when it ends before the retention cutoff. */
function isExpired(p: Partition, cutoffIso: string): boolean {
	return p.to <= cutoffIso;
}

function usage(): string {
	return [
		'Usage: npx tsx scripts/partitions.ts [--months 6] [--retention-days 90] [--dry-run]',
		'',
		'Requires DATABASE_URL (Supabase connection string — see README → "Supabase setup").',
		'Without it the script does nothing and exits 0, so it is safe to run in CI.'
	].join('\n');
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err: unknown) {
		console.error(`[partitions] ${(err as Error).message}\n\n${usage()}`);
		return 1;
	}

	const databaseUrl = process.env['DATABASE_URL']?.trim();
	if (!databaseUrl) {
		console.info(
			[
				'[partitions] DATABASE_URL is not set — nothing to do.',
				'',
				'To create the cas_ticks partitions, point DATABASE_URL at your Postgres:',
				'  1. Supabase → Project Settings → Database → Connection string (URI)',
				'  2. export DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"',
				'  3. npx tsx scripts/partitions.ts --months 6 --retention-days 90',
				'',
				'(A session-pooler or direct connection is best here: partition DDL is DDL.)'
			].join('\n')
		);
		return 0;
	}

	const today = todayIst();
	const planned = plannedPartitions(args.months, today);
	const cutoffIso = isoDate(new Date(today.getTime() - args.retentionDays * 86_400_000));
	const todayIso = isoDate(today);

	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15, onnotice: () => {} });

	try {
		const parent = await sql`select to_regclass('public.cas_ticks') as reg`;
		if (!parent[0]?.reg) {
			console.error(
				'[partitions] public.cas_ticks does not exist. Run the schema migration first:\n' +
					'  supabase db push        (or)\n' +
					'  psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql'
			);
			return 1;
		}

		const existing = await sql`
			select c.relname as name
			from pg_class c
			join pg_inherits i on i.inhrelid = c.oid
			where i.inhparent = 'public.cas_ticks'::regclass`;
		const existingNames = new Set(existing.map((row) => String(row.name)));

		const creates = planned.filter((p) => !existingNames.has(p.name));
		// Retention only ever considers partitions that exist, so we never try to drop
		// something the create window has not made yet.
		const drops = planned
			.filter((p) => existingNames.has(p.name) && isExpired(p, cutoffIso))
			.filter((p) => !(p.from <= todayIso && todayIso < p.to)); // belt and braces
		const kept = planned.filter((p) => existingNames.has(p.name) && !drops.includes(p));

		console.info(
			`[partitions] today=${todayIso} (IST) window=${planned[0].from}..${planned[planned.length - 1].to} retention=${args.retentionDays}d (cutoff ${cutoffIso})${args.dryRun ? ' [dry-run]' : ''}`
		);

		const run = async (): Promise<void> => {
			for (const p of creates) {
				// `${sql(p.name)}` interpolates a quoted identifier (postgres.js' Identifier
				// helper); the bounds are cast to date explicitly so the untyped text params
				// cannot be misread.
				await sql`create table if not exists ${sql(p.name)} partition of cas_ticks for values from (${p.from}::date) to (${p.to}::date)`;
			}
			for (const p of drops) {
				await sql`drop table if exists ${sql(p.name)}`;
			}
		};

		if (args.dryRun) {
			for (const p of planned) {
				const state = existingNames.has(p.name)
					? isExpired(p, cutoffIso)
						? 'DROP (expired)'
						: 'keep'
					: 'CREATE';
				console.info(`[partitions]   ${p.name.padEnd(20)} ${p.from} → ${p.to}  ${state}`);
			}
			console.info('[partitions] dry-run: no DDL executed.');
			return 0;
		}

		// One transaction: a half-applied partition plan is worse than none.
		await sql.begin(run);

		console.info(
			`[partitions] done — created ${creates.length}, dropped ${drops.length}, kept ${kept.length} (${existingNames.size} existed before).`
		);
		if (creates.length === 0 && drops.length === 0) {
			console.info('[partitions] nothing to do — partition set already covers the window.');
		}
		return 0;
	} catch (err: unknown) {
		console.error(`[partitions] failed: ${(err as Error).message}`);
		return 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

const exitCode = await main();
process.exitCode = exitCode;
