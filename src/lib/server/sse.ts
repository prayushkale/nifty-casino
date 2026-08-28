/**
 * Server-Sent Events plumbing — frame encoding, a push-based frame stream, and
 * the Response that carries it. Extracted from `/api/stream` so the byte format
 * and the resume-cursor rules are unit-testable without an HTTP server (PLAN
 * T4), and so the SSE endpoint itself stays a ~40-line adapter.
 *
 * Frame format (the WHATWG `text/event-stream` wire format EventSource speaks):
 *
 *   id: 1724700000000\n        <- optional, becomes the client's Last-Event-ID
 *   event: hello\n             <- optional; absent = the default 'message' event
 *   data: {"ticks":[]}\n       <- one line per data line
 *   \n                         <- terminator: dispatches the event
 *
 * Two rules the whole app depends on:
 *
 *  1. Only `ticks` frames carry an `id`. Heartbeats must not — EventSource
 *     adopts *any* frame's id as its reconnect cursor, and a heartbeat id would
 *     make a reconnecting client ask "everything since this heartbeat" and get
 *     a pointless gap.
 *  2. Delta frames use the default `message` event (so the client's
 *     `onmessage` is the only handler it needs); `hello` and `heartbeat` are
 *     named events.
 */
const ENCODER = new TextEncoder();

export type SseFrameInit = {
	/** Last-Event-ID cursor for this frame. Omit for frames the client must not resume from. */
	id?: string | number | null;
	/** Named event ('hello' | 'heartbeat'); omit for the default 'message' event. */
	event?: string;
	/** JSON-serializable body, or an already-serialized string. */
	data: unknown;
};

/** Encode one SSE frame, terminator included. Pure and byte-exact. */
export function encodeSseFrame({ id, event, data }: SseFrameInit): string {
	const lines: string[] = [];
	if (id !== undefined && id !== null && `${id}` !== '') lines.push(`id: ${id}`);
	if (event) lines.push(`event: ${event}`);
	const body = typeof data === 'string' ? data : JSON.stringify(data);
	// A literal newline inside data would forge a frame terminator, so every
	// line of a multi-line body gets its own `data:` prefix (per spec).
	for (const line of body.split('\n')) lines.push(`data: ${line}`);
	return `${lines.join('\n')}\n\n`;
}

export type SseStream = {
	/** Queue an already-encoded frame. A no-op once closed. */
	push(frame: string): void;
	/** Encode + queue — the common path. */
	send(init: SseFrameInit): void;
	/** Encoded frames, ending when the stream is closed. Single-consumer. */
	readonly events: AsyncIterable<string>;
	/** End the stream; a pending iterator resolves done. Idempotent. */
	close(): void;
	readonly closed: boolean;
	/** Frames queued but not yet consumed — tests and backpressure introspection. */
	readonly pending: number;
};

/**
 * A bounded-by-the-consumer frame stream: `push` never blocks and never grows
 * past what the HTTP layer has asked for, because the body's `pull` drains one
 * frame at a time. `opts.signal` (the request's) closes the stream, so a
 * dropped client cannot leave a listener or a timer behind.
 */
const ITERATOR_DONE: IteratorResult<string> = { value: undefined, done: true };

export function createSseStream(opts: { signal?: AbortSignal } = {}): SseStream {
	const queue: string[] = [];
	let closed = false;
	let waiter: (() => void) | null = null;

	const wake = (): void => {
		const resolve = waiter;
		waiter = null;
		resolve?.();
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		wake();
	};

	const push = (frame: string): void => {
		if (closed) return;
		queue.push(frame);
		wake();
	};

	const next = (): Promise<IteratorResult<string>> => {
		if (queue.length > 0) return Promise.resolve({ value: queue.shift() as string, done: false });
		if (closed) return Promise.resolve(ITERATOR_DONE);
		return new Promise<void>((resolve) => {
			waiter = resolve;
		}).then(next);
	};

	if (opts.signal) {
		if (opts.signal.aborted) close();
		else opts.signal.addEventListener('abort', close, { once: true });
	}

	const iterator: AsyncIterator<string> = {
		next,
		return: async () => {
			close();
			return ITERATOR_DONE;
		}
	};

	return {
		push,
		send: (init) => push(encodeSseFrame(init)),
		events: { [Symbol.asyncIterator]: () => iterator },
		close,
		get closed() {
			return closed;
		},
		get pending() {
			return queue.length;
		}
	};
}

/**
 * The SSE Response: a ReadableStream that hands the body one frame per pull
 * (which is what makes a 10k-connection fan-out cheap — no per-client queue
 * grows unboundedly), with the headers that keep proxies out of the way.
 *
 * `X-Accel-Buffering: no` stops nginx/Cloudflare from buffering the stream into
 * a single burst; `no-transform` stops gzip proxies from sitting on it; the
 * explicit `Connection: keep-alive` keeps intermediaries from closing early.
 */
export function sseResponse(stream: SseStream, headers: Record<string, string> = {}): Response {
	const iterator = stream.events[Symbol.asyncIterator]();
	let cancelled = false;

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { value, done } = await iterator.next();
			if (cancelled) return; // the client went away mid-frame — the stream is gone
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(ENCODER.encode(value));
		},
		cancel() {
			cancelled = true;
			stream.close();
		}
	});

	return new Response(body, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			...headers
		}
	});
}

/**
 * Turn a request into a snapshot cursor.
 *
 * Precedence: an explicit `?since=<epochMs>` wins over the header (it is what a
 * client that already knows its gap asks for), `Last-Event-ID` is the
 * EventSource reconnect path, and neither present means "full snapshot".
 * `?since=0` is therefore the documented "give me everything" request. Anything
 * non-numeric or negative is ignored rather than thrown — a bad cursor degrades
 * to a full snapshot, never to a 400 on a hot path.
 */
export function resolveSinceTs(
	sinceParam: string | null,
	lastEventId: string | null
): number | undefined {
	const parse = (raw: string | null): number | undefined => {
		if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	};
	return parse(sinceParam) ?? parse(lastEventId);
}

/** Node timers must never hold the process open because of an idle SSE connection. */
export function unrefTimer(timer: unknown): void {
	const t = timer as { unref?: () => void } | null;
	if (t && typeof t.unref === 'function') t.unref();
}
