/**
 * scripts/load-sim.ts — virtual clients against a RUNNING NiftyCasino server.
 * PLAN §5 T17 + the §8 gate "10k concurrent SSE + snapshot p95 < 500ms".
 *
 *   npx tsx scripts/load-sim.ts --base http://localhost:3000 --conns 300 --duration 20 --ramp 5
 *   npx tsx scripts/load-sim.ts --conns 10000 --duration 120 --ramp 30      # the §8 target
 *   npx tsx scripts/load-sim.ts --conns 300 --sse-ratio 0.5                 # fan-out heavy
 *
 * It is a plain-Node generator on purpose: global `fetch`, a hand-rolled SSE reader
 * over the response stream, and AbortControllers. No k6, no new dependencies, so it
 * runs anywhere the repo runs and its own overhead is visible rather than hidden in
 * a load tool's own event loop.
 *
 * THE MIX (default 60/30/10, normalised if it does not sum to 1):
 *
 *   state  GET /api/state      the one-request screen rebuild — per-user, no-store,
 *                              the payload every cold load, refresh and reconnect hits
 *   cas    GET /api/cas/all    the snapshot + backfill — hot buffer ∪ cas_ticks
 *   sse    GET /api/stream     one long-lived connection per client, counting frames,
 *                              bytes and reconnects, resuming with Last-Event-ID
 *
 * The GET clients read at the cadence the real clients use (`--think-state-ms`, default
 * 1s; `--think-cas-ms`, default 8s = CAS_FALLBACK_POLL_MS) rather than flat-out, so the
 * numbers mean something: this is a concurrency test, not a throughput benchmark.
 * SSE clients hold their connection for the whole run and reconnect with backoff when
 * the server drops them.
 *
 * WHAT IT MEASURES, per endpoint: requests, errors (non-2xx or thrown), mean/p50/p90/
 * p95/p99/max latency, actual rps, and a 10ms-bucket histogram. For SSE: connects,
 * reconnects, dropped connections, frames, bytes and time-to-first-frame (what a
 * player experiences as "the chart came up").
 *
 * FILE DESCRIPTORS — read before a big run. One virtual client is one socket on BOTH
 * ends: the generator's process AND the server's. Raise the limit in both places or
 * the run measures the OS, not the app. The script reads the local soft limit, warns
 * when `--conns` cannot fit under it, and prints the raise commands for macOS/Linux.
 * The documented §8 target (10,000 concurrent SSE + p95 < 500ms) therefore needs a
 * Linux box with the limit raised — a stock macOS shell (soft 256, hard 10240) tops
 * out far below it and that ceiling is the OS's, not this app's.
 *
 * READ-ONLY BY DESIGN: every request is a GET, so this is safe to point at a
 * production deployment (mind the bandwidth, not the data).
 *
 * Exit codes: 0 = the run completed (whatever the latencies were). 1 = refused (bad
 * arguments, or the target never answered).
 */
import { CAS_FALLBACK_POLL_MS } from '$lib/config/app';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

type Args = {
	base: string;
	conns: number;
	durationS: number;
	rampS: number;
	stateRatio: number;
	casRatio: number;
	sseRatio: number;
	thinkStateMs: number;
	thinkCasMs: number;
	timeoutMs: number;
	quiet: boolean;
};

const DEFAULT_CONNS = 1000;

function usage(): string {
	return [
		'Usage: npx tsx scripts/load-sim.ts --base http://localhost:3000 [--conns 1000] [--duration 60]',
		'',
		'  --base URL           Origin to hit (default http://localhost:3000). Read-only.',
		'  --conns N            Virtual clients in total across the mix (default ' +
			DEFAULT_CONNS +
			').',
		'  --duration S         Seconds of steady-state measurement after the ramp (default 60).',
		'  --ramp S             Seconds over which clients start, so the server is not hit by a',
		'                       single thundering herd (default 10).',
		'  --state-ratio F      Share of clients on GET /api/state (default 0.6).',
		'  --cas-ratio F        Share of clients on GET /api/cas/all (default 0.3).',
		'  --sse-ratio F        Share of clients holding GET /api/stream open (default 0.1).',
		'                       The three are normalised, so `--sse-ratio 1` is all SSE.',
		'  --think-state-ms MS  Pause between /api/state reads (default 1000).',
		'  --think-cas-ms MS    Pause between /api/cas/all reads (default ' +
			CAS_FALLBACK_POLL_MS +
			').',
		'  --timeout-ms MS      Per-request timeout; a timed-out request counts as an error',
		'                       (default 10000).',
		'  --quiet              No 5s progress lines.',
		'',
		'Booting a server to hit:  npm run build && CAS_POLLER_DISABLED=1 SETTLE_DISABLED=1 PORT=3000 node build/index.js',
		'See README → "Simulation & load" and docs/RUNBOOK.md §9 (the 10k / p95 gate).'
	].join('\n');
}

/** A usage message is not a stack trace — carried out of band, printed without one. */
class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		base: 'http://localhost:3000',
		conns: DEFAULT_CONNS,
		durationS: 60,
		rampS: 10,
		stateRatio: 0.6,
		casRatio: 0.3,
		sseRatio: 0.1,
		thinkStateMs: 1000,
		thinkCasMs: CAS_FALLBACK_POLL_MS,
		timeoutMs: 10_000,
		quiet: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (name: string): string => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
			i += 1;
			return next;
		};
		const num = (name: string, raw: string): number => {
			const parsed = Number(raw);
			if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number (got "${raw}")`);
			return parsed;
		};
		if (arg === '--base') args.base = value(arg).replace(/\/+$/, '');
		else if (arg === '--conns') args.conns = num(arg, value(arg));
		else if (arg === '--duration') args.durationS = num(arg, value(arg));
		else if (arg === '--ramp') args.rampS = num(arg, value(arg));
		else if (arg === '--state-ratio') args.stateRatio = num(arg, value(arg));
		else if (arg === '--cas-ratio') args.casRatio = num(arg, value(arg));
		else if (arg === '--sse-ratio') args.sseRatio = num(arg, value(arg));
		else if (arg === '--think-state-ms') args.thinkStateMs = num(arg, value(arg));
		else if (arg === '--think-cas-ms') args.thinkCasMs = num(arg, value(arg));
		else if (arg === '--timeout-ms') args.timeoutMs = num(arg, value(arg));
		else if (arg === '--quiet') args.quiet = true;
		else if (arg === '--help' || arg === '-h') throw new UsageError(usage());
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (args.conns < 1 || args.conns > 100_000)
		throw new Error(`--conns must be in 1..100000 (got ${args.conns})`);
	if (args.durationS < 1 || args.durationS > 3600)
		throw new Error(`--duration must be in 1..3600 seconds (got ${args.durationS})`);
	if (args.rampS < 0 || args.rampS > 600)
		throw new Error(`--ramp must be in 0..600 seconds (got ${args.rampS})`);
	if (args.thinkStateMs < 0 || args.thinkCasMs < 0) throw new Error('think times must be ≥ 0');
	if (args.timeoutMs < 1) throw new Error(`--timeout-ms must be ≥ 1 (got ${args.timeoutMs})`);

	const ratioSum = args.stateRatio + args.casRatio + args.sseRatio;
	if (ratioSum <= 0)
		throw new Error('at least one of --state-ratio/--cas-ratio/--sse-ratio must be > 0');
	// Normalise rather than refuse: `--sse-ratio 0.5` on its own is a natural thing to type.
	args.stateRatio /= ratioSum;
	args.casRatio /= ratioSum;
	args.sseRatio /= ratioSum;
	return args;
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

/** Latencies are kept in a bounded reservoir so a 10k-conn, 2-min run cannot balloon. */
const RESERVOIR_CAP = 500_000;

class Endpoint {
	readonly name: string;
	requests = 0;
	errors = 0;
	private readonly latencies: number[] = [];
	private seen = 0;

	constructor(name: string) {
		this.name = name;
	}

	/** `ok` false → the request counted, but as an error (non-2xx or thrown). */
	record(ms: number, ok: boolean): void {
		this.requests += 1;
		if (!ok) {
			this.errors += 1;
			return;
		}
		this.seen += 1;
		if (this.latencies.length < RESERVOIR_CAP) {
			this.latencies.push(ms);
		} else {
			// Uniform reservoir: every sample has an equal chance of being kept, so the
			// percentiles below stay unbiased without holding millions of numbers.
			const slot = Math.floor(Math.random() * this.seen);
			if (slot < RESERVOIR_CAP) this.latencies[slot] = ms;
		}
	}

	get samples(): number {
		return this.latencies.length;
	}

	summary(): {
		count: number;
		errors: number;
		mean: number;
		p50: number;
		p90: number;
		p95: number;
		p99: number;
		max: number;
	} {
		const sorted = [...this.latencies].sort((a, b) => a - b);
		const pick = (p: number): number =>
			sorted.length === 0
				? 0
				: (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number);
		const mean = sorted.length === 0 ? 0 : sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
		return {
			count: this.requests,
			errors: this.errors,
			mean,
			p50: pick(50),
			p90: pick(90),
			p95: pick(95),
			p99: pick(99),
			max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number)
		};
	}

	histogram(bucketMs = 10, maxRows = 45): { from: number; to: number; count: number }[] {
		if (this.latencies.length === 0) return [];
		const sorted = [...this.latencies].sort((a, b) => a - b);
		const max = sorted[sorted.length - 1] as number;
		const rows = new Map<number, number>();
		for (const value of this.latencies) {
			const bucket = Math.min(Math.floor(value / bucketMs), Math.floor(max / bucketMs));
			rows.set(bucket, (rows.get(bucket) ?? 0) + 1);
		}
		const ordered = [...rows.keys()].sort((a, b) => a - b);
		const kept = ordered.slice(0, maxRows);
		const out = kept.map((bucket) => ({
			from: bucket * bucketMs,
			to: (bucket + 1) * bucketMs,
			count: rows.get(bucket) as number
		}));
		const overflow = ordered
			.slice(maxRows)
			.reduce((sum, bucket) => sum + (rows.get(bucket) as number), 0);
		if (overflow > 0) out.push({ from: maxRows * bucketMs, to: Math.ceil(max), count: overflow });
		return out;
	}
}

type SseStats = {
	connects: number;
	reconnects: number;
	dropped: number;
	errors: number;
	frames: number;
	bytes: number;
	maxConcurrent: number;
	concurrent: number;
	firstFrame: Endpoint;
};

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------

const TAG = '[load-sim]';

const padStartStr = (value: string, width: number): string =>
	value.length >= width ? value : ' '.repeat(width - value.length) + value;
const padEndStr = (value: string, width: number): string =>
	value.length >= width ? value : value + ' '.repeat(width - value.length);
const num = (value: number, width: number): string => padStartStr(String(value), width);
const fixed = (value: number, digits: number, width: number): string =>
	padStartStr(value.toFixed(digits), width);
const bytes = (n: number): string =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
			? `${(n / 1024).toFixed(1)} KiB`
			: `${(n / (1024 * 1024)).toFixed(2)} MiB`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One fetch with its own timeout + the run's shutdown signal wired in. Returns the
 * response, or throws — the callers only distinguish "2xx" from "not".
 */
async function fetchWithTimeout(
	url: string,
	shutdown: AbortSignal,
	timeoutMs: number,
	headers: Record<string, string> = {}
): Promise<Response> {
	const controller = new AbortController();
	// 0 = no per-request timeout — that is the SSE case, where the stream is meant to
	// outlive any single request budget and only the run's deadline may end it.
	const timer =
		timeoutMs > 0
			? setTimeout(() => controller.abort(new Error('client timeout')), timeoutMs)
			: null;
	const onShutdown = (): void => controller.abort(new Error('run over'));
	shutdown.addEventListener('abort', onShutdown, { once: true });
	try {
		return await fetch(url, { signal: controller.signal, headers });
	} finally {
		if (timer) clearTimeout(timer);
		shutdown.removeEventListener('abort', onShutdown);
	}
}

/**
 * A GET client: read, record, think, repeat until the deadline.
 *
 * `/api/cas/all` is requested WITHOUT `?since`, i.e. the full snapshot — the heaviest
 * thing the endpoint can be asked for, and what a first load / a cache-cold reconnect
 * costs. Steady-state incremental backfill can only be cheaper than this.
 */
async function restClient(
	url: string,
	deadline: number,
	thinkMs: number,
	timeoutMs: number,
	metrics: Endpoint,
	shutdown: AbortSignal,
	startDelayMs: number
): Promise<void> {
	await sleep(startDelayMs);
	while (Date.now() < deadline && !shutdown.aborted) {
		const started = Date.now();
		try {
			const response = await fetchWithTimeout(url, shutdown, timeoutMs);
			// Drain the body: latency here means "payload in hand", not "headers seen".
			await response.arrayBuffer();
			metrics.record(Date.now() - started, response.ok);
		} catch {
			metrics.record(Date.now() - started, false);
		}
		const remaining = thinkMs - (Date.now() - started);
		// Never sleep past the deadline: a client whose think time outlives the run
		// would hold the whole report open for no measurement.
		if (remaining > 0) await sleep(Math.min(remaining, Math.max(0, deadline - Date.now())));
	}
}

/**
 * An SSE client: hold the stream open, count frames, and reconnect with backoff when
 * the server (or the run) ends it. Resumes with `Last-Event-ID`, exactly as
 * EventSource would, so a reconnect costs the server the same hello snapshot a real
 * client would trigger.
 */
async function sseClient(
	url: string,
	deadline: number,
	timeoutMs: number,
	stats: SseStats,
	shutdown: AbortSignal,
	startDelayMs: number
): Promise<void> {
	await sleep(startDelayMs);
	let backoffMs = 500;

	while (Date.now() < deadline && !shutdown.aborted) {
		// This controller is the stream's lifetime, so it is handed to fetch DIRECTLY.
		// Going through `fetchWithTimeout` would hang: that helper releases its own
		// controller the moment the response HEADERS arrive (its job is per-request
		// budgets, and a GET is finished at that point), which leaves a body that is
		// still streaming with no signal attached — an abort then reaches nothing.
		const controller = new AbortController();
		// Two ways out: the run's shutdown, and the run's deadline. `--timeout-ms`
		// bounds only the wait for the response to OPEN, after which the stream is
		// meant to be long-lived.
		const openTimer = setTimeout(() => controller.abort(new Error('open timeout')), timeoutMs);
		const endTimer = setTimeout(
			() => controller.abort(new Error('run over')),
			Math.max(1, deadline - Date.now())
		);
		const onShutdown = (): void => controller.abort(new Error('run over'));
		shutdown.addEventListener('abort', onShutdown, { once: true });

		const started = Date.now();
		let firstFrameSeen = false;
		stats.concurrent += 1;
		stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);

		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' }
			});
			clearTimeout(openTimer);

			if (!response.ok || !response.body) {
				stats.errors += 1;
				stats.dropped += 1;
			} else {
				stats.connects += 1;
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					stats.bytes += chunk.value.byteLength;
					buffer += decoder.decode(chunk.value, { stream: true });

					let boundary = buffer.indexOf('\n\n');
					while (boundary !== -1) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						// A heartbeat frame counts: it is real bytes the server wrote for
						// this client, and it is what proves the connection is alive.
						if (frame.length > 0) stats.frames += 1;
						if (!firstFrameSeen) {
							firstFrameSeen = true;
							stats.firstFrame.record(Date.now() - started, true);
						}
						boundary = buffer.indexOf('\n\n');
					}
				}
			}
		} catch (err: unknown) {
			// The run's own shutdown/deadline is how a client stops, not a failure.
			const reason = err instanceof Error ? err.message : '';
			const ours = shutdown.aborted || reason === 'run over' || reason === 'open timeout';
			if (!ours) {
				stats.errors += 1;
				stats.dropped += 1;
			}
		} finally {
			clearTimeout(openTimer);
			clearTimeout(endTimer);
			shutdown.removeEventListener('abort', onShutdown);
			stats.concurrent -= 1;
		}

		if (Date.now() >= deadline || shutdown.aborted) break;
		// Going round again — whether the stream closed cleanly or died — is a reconnect:
		// a real EventSource retries either way, and each retry costs the server one
		// hello snapshot. `dropped` above records how the previous stream ended.
		stats.reconnects += 1;
		await sleep(backoffMs);
		backoffMs = Math.min(backoffMs * 2, 5_000); // capped exponential, as EventSource does
	}
}

// ---------------------------------------------------------------------------
// file-descriptor guidance
// ---------------------------------------------------------------------------

const FD_RESERVE = 64; // stdio, the pool, the event loop's own plumbing

function softFdLimit(): number | null {
	try {
		const out = execFileSync('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim();
		const parsed = Number(out);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null; // Windows, or a shell without ulimit — say so rather than guess
	}
}

function fdGuidance(conns: number, limit: number | null): string[] {
	const lines: string[] = [];
	if (limit === null) {
		lines.push(
			`${TAG} could not read the fd soft limit (no \`ulimit\` here) — check it yourself before a big run.`
		);
	} else if (conns + FD_RESERVE > limit) {
		lines.push(
			`${TAG} WARNING: --conns ${conns} needs ~${conns + FD_RESERVE} file descriptors but this shell's soft limit is ${limit}.` +
				' The run will fail with EMFILE long before it measures the server. Raise it first:'
		);
		if (process.platform === 'darwin') {
			lines.push(
				`${TAG}   macOS   ulimit -n 10240                       # this shell, up to the hard limit (ulimit -Hn)`,
				`${TAG}           sudo launchctl limit maxfiles 65536 200000   # persistent, needs a re-login`
			);
		} else {
			lines.push(
				`${TAG}   Linux   ulimit -n 65535                      # this shell, up to the hard limit (ulimit -Hn)`,
				`${TAG}           /etc/security/limits.conf:  *  soft  nofile  65535   (re-login)`
			);
		}
		lines.push(
			`${TAG}   and raise the SERVER's limit too — every client is a socket on that end as well`,
			`${TAG}   (systemd: LimitNOFILE=65535 in the unit, then daemon-reload + restart).`
		);
	} else {
		lines.push(`${TAG} fd soft limit ${limit} — ${conns} client(s) fit, no raise needed.`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err: unknown) {
		const isUsage = err instanceof UsageError;
		console.error(`${TAG} ${(err as Error).message}`);
		if (!isUsage) console.error(`\n${usage()}`);
		return isUsage ? 0 : 1;
	}

	const { base, conns, durationS, rampS, timeoutMs } = args;
	const stateCount = Math.round(conns * args.stateRatio);
	const casCount = Math.round(conns * args.casRatio);
	const sseCount = Math.max(0, conns - stateCount - casCount);
	const rampMs = rampS * 1000;
	const deadline = Date.now() + durationS * 1000 + rampMs;

	const state = new Endpoint('/api/state');
	const cas = new Endpoint('/api/cas/all');
	const sse: SseStats = {
		connects: 0,
		reconnects: 0,
		dropped: 0,
		errors: 0,
		frames: 0,
		bytes: 0,
		maxConcurrent: 0,
		concurrent: 0,
		firstFrame: new Endpoint('sse-first-frame')
	};

	console.info(
		`${TAG} base=${base} conns=${conns} (state ${stateCount} / cas ${casCount} / sse ${sseCount})` +
			` duration=${durationS}s ramp=${rampS}s think=${args.thinkStateMs}/${args.thinkCasMs}ms timeout=${timeoutMs}ms`
	);
	for (const line of fdGuidance(conns, softFdLimit())) console.info(line);

	// Reachability first: a typo in --base should fail in one request, not after the ramp.
	const probeStarted = Date.now();
	try {
		const probe = await fetchWithTimeout(
			`${base}/api/cas/all`,
			new AbortController().signal,
			timeoutMs
		);
		await probe.arrayBuffer();
		console.info(
			`${TAG} probe /api/cas/all → ${probe.status} in ${Date.now() - probeStarted}ms` +
				(probe.ok ? '' : ' — non-2xx, results below will be all errors')
		);
	} catch (err: unknown) {
		console.error(
			`${TAG} REFUSED: ${base} did not answer /api/cas/all (${(err as Error).message}).`
		);
		console.error(
			`${TAG} Boot one first: npm run build && CAS_POLLER_DISABLED=1 SETTLE_DISABLED=1 PORT=3000 node build/index.js`
		);
		return 1;
	}

	const shutdown = new AbortController();
	const startDelayMs = (index: number): number =>
		// Spread starts across the ramp, plus a few ms of jitter so clients do not
		// arrive in lockstep on the same tick.
		(conns <= 1 ? 0 : (index / conns) * rampMs) + Math.random() * 5;

	const workers: Promise<void>[] = [];
	let index = 0;
	for (let i = 0; i < stateCount; i += 1, index += 1) {
		workers.push(
			restClient(
				`${base}/api/state`,
				deadline,
				args.thinkStateMs,
				timeoutMs,
				state,
				shutdown.signal,
				startDelayMs(index)
			)
		);
	}
	for (let i = 0; i < casCount; i += 1, index += 1) {
		workers.push(
			restClient(
				`${base}/api/cas/all`,
				deadline,
				args.thinkCasMs,
				timeoutMs,
				cas,
				shutdown.signal,
				startDelayMs(index)
			)
		);
	}
	for (let i = 0; i < sseCount; i += 1, index += 1) {
		workers.push(
			sseClient(
				`${base}/api/stream`,
				deadline,
				timeoutMs,
				sse,
				shutdown.signal,
				startDelayMs(index)
			)
		);
	}

	const startedAt = Date.now();
	const progressEveryMs = 5_000;
	let nextProgressAt = startedAt + progressEveryMs;
	const progressTimer = setInterval(() => {
		if (args.quiet || Date.now() < nextProgressAt) return;
		nextProgressAt += progressEveryMs;
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
		console.info(
			`${TAG} ${padStartStr(elapsed, 4)}s  state ${state.requests}/${state.errors}err · cas ${cas.requests}/${cas.errors}err` +
				` · sse conn ${sse.connects} (live ${sse.concurrent}) frames ${sse.frames} · dropped ${sse.dropped}`
		);
	}, 1_000);

	// The deadline is what ends the run; the abort is the belt for a worker stuck in a read.
	const endTimer = setTimeout(
		() => shutdown.abort(new Error('run over')),
		Math.max(1, deadline - Date.now() + 1_000)
	);
	await Promise.all(workers);
	clearTimeout(endTimer);
	clearInterval(progressTimer);
	const elapsedS = (Date.now() - startedAt) / 1000;

	// -- the report --------------------------------------------------------------
	const stateSummary = state.summary();
	const casSummary = cas.summary();
	const firstFrame = sse.firstFrame.summary();

	const width = 16;
	console.info('');
	console.info(
		`${TAG} ── results (${elapsedS.toFixed(1)}s wall incl. the ${rampS}s ramp, ${conns} client(s)) ──`
	);
	console.info(
		`  ${padEndStr('endpoint', width)} ${padStartStr('reqs', 8)} ${padStartStr('errors', 7)}` +
			` ${padStartStr('rps', 8)} ${padStartStr('mean', 8)} ${padStartStr('p50', 8)} ${padStartStr('p90', 8)}` +
			` ${padStartStr('p95', 8)} ${padStartStr('p99', 8)} ${padStartStr('max', 8)}  (ms)`
	);
	for (const [name, endpoint] of [
		['/api/state', stateSummary],
		['/api/cas/all', casSummary]
	] as const) {
		console.info(
			`  ${padEndStr(name, width)} ${num(endpoint.count, 8)} ${num(endpoint.errors, 7)}` +
				` ${fixed(endpoint.count / elapsedS, 1, 8)} ${fixed(endpoint.mean, 1, 8)} ${fixed(endpoint.p50, 1, 8)}` +
				` ${fixed(endpoint.p90, 1, 8)} ${fixed(endpoint.p95, 1, 8)} ${fixed(endpoint.p99, 1, 8)} ${fixed(endpoint.max, 1, 8)}`
		);
	}
	console.info(
		`  ${padEndStr('/api/stream', width)} ${num(sse.connects, 8)} ${num(sse.errors, 7)} ${padStartStr('—', 8)}` +
			` ${fixed(firstFrame.mean, 1, 8)} ${fixed(firstFrame.p50, 1, 8)} ${fixed(firstFrame.p90, 1, 8)}` +
			` ${fixed(firstFrame.p95, 1, 8)} ${fixed(firstFrame.p99, 1, 8)} ${fixed(firstFrame.max, 1, 8)}` +
			'  ← time to first frame'
	);
	console.info(
		`${TAG} SSE: connects=${sse.connects} reconnects=${sse.reconnects} dropped=${sse.dropped}` +
			` frames=${sse.frames} (${(sse.frames / elapsedS).toFixed(1)}/s) bytes=${bytes(sse.bytes)}` +
			` maxConcurrent=${sse.maxConcurrent}`
	);
	// The §8 line is a read of the SHAPE, not a pass/fail: the gate is judged on Tier 1
	// hardware against a realistic mix, and a mix with no GET clients has no p95 to report.
	const p95orNa = (summary: { count: number; p95: number }): string =>
		summary.count === 0 ? 'n/a (no requests)' : `${fixed(summary.p95, 1, 0)}ms`;
	console.info(
		`${TAG} §8 gate shape: ${sse.maxConcurrent} concurrent SSE client(s) held (of ${sseCount} asked);` +
			` /api/cas/all p95 ${p95orNa(casSummary)}, /api/state p95 ${p95orNa(stateSummary)}` +
			' vs the <500ms target — on this machine, not on Tier 1 hardware.'
	);

	for (const [name, endpoint] of [
		['/api/state', state],
		['/api/cas/all', cas]
	] as const) {
		const histogram = endpoint.histogram();
		if (histogram.length === 0) continue;
		const peak = Math.max(...histogram.map((row) => row.count));
		console.info(
			`\n${TAG} latency histogram ${name} (${endpoint.samples} sample(s), 10ms buckets)`
		);
		for (const row of histogram) {
			const bar = '█'.repeat(Math.max(1, Math.round((row.count / peak) * 40)));
			console.info(
				`  ${padStartStr(String(row.from), 6)}–${padEndStr(`${row.to}ms`, 11)} ${num(row.count, 8)}  ${bar}`
			);
		}
	}

	const totalErrors = stateSummary.errors + casSummary.errors + sse.errors;
	console.info(
		`\n${TAG} done — ${stateSummary.count + casSummary.count} request(s), ${totalErrors} error(s), ` +
			`${sse.connects} stream(s). Read-only: nothing was written to the store.`
	);
	return 0;
}

// Run-as-module guard (mirrors the other scripts): importing this file must not start a run.
const isEntry =
	process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isEntry) {
	const exitCode = await main();
	process.exitCode = exitCode;
	// Return explicitly: a run that ends with sockets half-closed must not wait on
	// anything the event loop still believes it owes.
	process.exit(exitCode);
}
