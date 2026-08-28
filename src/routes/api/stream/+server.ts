import { SSE_HEARTBEAT_MS, SSE_IDLE_TIMEOUT_MS } from '$lib/config/app';
import { getCasStore, heartbeatEvent, snapshotEventId } from '$lib/server/cas-store';
import { createSseStream, resolveSinceTs, sseResponse, unrefTimer } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * GET /api/stream — the live CAS fan-out (PLAN §2). One SSE connection per
 * player, held open for the auction; the 4s upstream poll happens exactly once
 * for all of them, in the poller.
 *
 * Frame sequence:
 *
 *   1. `event: hello` — a full snapshot (same shape as GET /api/cas/all), sent
 *      immediately so the chart can paint before any delta arrives. Its `id` is
 *      the newest tick ts, i.e. the cursor to resume from.
 *   2. default `message` frames — one per poll that produced new ticks, `id` =
 *      newest tick ts. This id is what makes reconnects gap-free.
 *   3. `event: heartbeat` every 15s — keeps proxies from killing an idle
 *      stream. Never carries an `id`: EventSource adopts *any* frame id as its
 *      reconnect cursor, and a heartbeat id would invent a gap.
 *
 * Resume: `EventSource` sends `Last-Event-ID` on reconnect; that ts becomes the
 * `since` cursor of the hello snapshot, so the client gets exactly the ticks it
 * missed. An explicit `?since=<epochMs>` overrides it, and `?since=0` is the
 * documented "everything" request. A cursor older than the ring buffer's
 * horizon is answered by the snapshot's `bufferedFrom` + GET /api/cas/all (the
 * DB backfill path) — the stream itself never queries Postgres.
 *
 * Lifecycle: each connection is dropped after SSE_IDLE_TIMEOUT_MS (a hidden tab
 * is not worth a socket; `EventSource` reconnects on its own, and the resume
 * above makes that free) and on `request.signal` abort, which also removes the
 * bus listener. No auth: the data is public market data, and this path is
 * excluded from the identity `profiles` lookup in `$lib/server/auth/session`.
 */
export const prerender = false;

export const GET: RequestHandler = async ({ request, url }) => {
	const store = getCasStore();
	const sinceTs = resolveSinceTs(
		url.searchParams.get('since'),
		request.headers.get('last-event-id')
	);
	const stream = createSseStream({ signal: request.signal });

	// Hello first, then subscribe — both synchronous, so no tick can slip between
	// the snapshot and the fan-out (there would be a duplicate, never a gap).
	const snapshot = store.snapshot(sinceTs);
	stream.send({ id: snapshotEventId(snapshot), event: 'hello', data: snapshot });

	const unsubscribe = store.subscribe((event) => {
		stream.send(
			event.type === 'ticks'
				? { id: event.id, data: event.payload }
				: { event: event.type, data: event.payload }
		);
	});

	// The store's heartbeat event supplies the payload; the frame deliberately
	// carries no id (see Resume above).
	const heartbeat = setInterval(() => {
		const event = heartbeatEvent();
		stream.send({ event: event.type, data: event.payload });
	}, SSE_HEARTBEAT_MS);
	// A fixed lifetime rather than an idle timer reset on every frame: simpler, and
	// the reconnect it eventually triggers costs one hello snapshot.
	const idle = setTimeout(() => stream.close(), SSE_IDLE_TIMEOUT_MS);
	// An idle SSE connection must never be the reason a process stays up.
	unrefTimer(heartbeat);
	unrefTimer(idle);

	const cleanup = (): void => {
		clearInterval(heartbeat);
		clearTimeout(idle);
		unsubscribe();
		stream.close();
	};
	if (request.signal.aborted) cleanup();
	else request.signal.addEventListener('abort', cleanup, { once: true });

	return sseResponse(stream);
};
