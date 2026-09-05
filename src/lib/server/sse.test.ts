/**
 * SSE plumbing tests — the wire format, the push-based frame stream, and the
 * resume cursor. These run with no HTTP server and no sockets: the endpoint in
 * `/api/stream` is a thin adapter over exactly the functions asserted here.
 */
import { describe, expect, it } from 'vitest';
import { istAt } from './cas/test-clock';
import { CasStore, snapshotEventId, type StreamEvent } from './cas-store';
import type { CasTickPayload } from './cas/types';
import { createSseStream, encodeSseFrame, resolveSinceTs, sseResponse } from './sse';

const DAY = '2026-08-26';

function payload(ts: number, value = 25000): CasTickPayload {
	return {
		underlying: 'nifty',
		value,
		changePts: 12,
		changePct: 0.05,
		prevClose: 24988,
		ts,
		upstreamTs: null,
		source: 'nse'
	};
}

describe('encodeSseFrame', () => {
	it('writes the hello frame as id, event, data, blank-line terminator', () => {
		expect(
			encodeSseFrame({ id: 1724700000000, event: 'hello', data: { tradeDate: '2026-08-26' } })
		).toBe('id: 1724700000000\nevent: hello\ndata: {"tradeDate":"2026-08-26"}\n\n');
	});

	it('writes a delta frame with the default (message) event and a cursor', () => {
		expect(encodeSseFrame({ id: '5', data: { ticks: 1 } })).toBe('id: 5\ndata: {"ticks":1}\n\n');
	});

	it('writes a heartbeat with a named event and NO id (an id would move the resume cursor)', () => {
		expect(encodeSseFrame({ event: 'heartbeat', data: { ts: 1234 } })).toBe(
			'event: heartbeat\ndata: {"ts":1234}\n\n'
		);
	});

	it('splits multi-line data across data: lines instead of forging a terminator', () => {
		expect(encodeSseFrame({ data: 'alpha\nbeta' })).toBe('data: alpha\ndata: beta\n\n');
	});

	it('omits a null or empty id', () => {
		expect(encodeSseFrame({ id: null, data: 1 })).toBe('data: 1\n\n');
		expect(encodeSseFrame({ id: '', data: 1 })).toBe('data: 1\n\n');
	});

	it('passes an already-serialized body through untouched', () => {
		expect(encodeSseFrame({ data: '"raw"' })).toBe('data: "raw"\n\n');
	});
});

describe('createSseStream', () => {
	it('delivers queued frames in order, then ends on close', async () => {
		const stream = createSseStream();
		stream.send({ id: 1, event: 'hello', data: { a: 1 } });
		stream.send({ id: 2, data: { b: 2 } });
		expect(stream.pending).toBe(2);

		stream.close();
		const collected: string[] = [];
		for await (const frame of stream.events) collected.push(frame);

		expect(collected).toEqual([
			'id: 1\nevent: hello\ndata: {"a":1}\n\n',
			'id: 2\ndata: {"b":2}\n\n'
		]);
		expect(stream.closed).toBe(true);
		expect(stream.pending).toBe(0);
	});

	it('wakes a consumer that is already waiting on an empty queue', async () => {
		const stream = createSseStream();
		const collected: string[] = [];
		const consuming = (async (): Promise<void> => {
			for await (const frame of stream.events) collected.push(frame);
		})();

		stream.send({ data: 'later' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		stream.close();
		await consuming;

		expect(collected).toEqual(['data: later\n\n']);
	});

	it('ignores frames pushed after close, and close is idempotent', () => {
		const stream = createSseStream();
		stream.send({ data: 1 });
		stream.close();
		stream.close();
		stream.send({ data: 2 });
		expect(stream.pending).toBe(1);
		expect(stream.closed).toBe(true);
	});

	it('closes when the request signal aborts (a dropped client frees its listener)', async () => {
		const controller = new AbortController();
		const stream = createSseStream({ signal: controller.signal });
		const collected: string[] = [];
		const consuming = (async (): Promise<void> => {
			for await (const frame of stream.events) collected.push(frame);
		})();

		stream.send({ data: 'before' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await consuming;

		expect(collected).toEqual(['data: before\n\n']);
		expect(stream.closed).toBe(true);
	});

	it('treats an already-aborted signal as a closed stream', () => {
		const controller = new AbortController();
		controller.abort();
		const stream = createSseStream({ signal: controller.signal });
		expect(stream.closed).toBe(true);
		stream.send({ data: 1 });
		expect(stream.pending).toBe(0);
	});

	it('ends cleanly when the consumer breaks out of the loop (iterator return)', async () => {
		const stream = createSseStream();
		stream.send({ data: 1 });
		const collected: string[] = [];
		for await (const frame of stream.events) {
			collected.push(frame);
			break;
		}
		expect(collected).toHaveLength(1);
		expect(stream.closed).toBe(true);
	});
});

describe('sseResponse', () => {
	it('sends the anti-buffering headers a proxy needs', () => {
		const response = sseResponse(createSseStream());
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		expect(response.headers.get('cache-control')).toContain('no-cache');
		expect(response.headers.get('x-accel-buffering')).toBe('no');
		expect(response.headers.get('connection')).toBe('keep-alive');
	});

	it('streams the encoded frames as the body and ends when the stream closes', async () => {
		const stream = createSseStream();
		stream.send({ id: 7, event: 'hello', data: { ok: true } });
		stream.send({ id: 8, data: { v: 1 } });
		stream.close();
		const response = sseResponse(stream);

		await expect(response.text()).resolves.toBe(
			'id: 7\nevent: hello\ndata: {"ok":true}\n\nid: 8\ndata: {"v":1}\n\n'
		);
	});

	it('closes the writer when the client cancels the body', async () => {
		const stream = createSseStream();
		stream.send({ id: 1, data: { a: 1 } });
		const response = sseResponse(stream);
		const reader = response.body?.getReader();
		expect(await reader?.read()).toEqual({
			done: false,
			value: new TextEncoder().encode('id: 1\ndata: {"a":1}\n\n')
		});
		await reader?.cancel();
		expect(stream.closed).toBe(true);
	});
});

describe('resolveSinceTs — Last-Event-ID resume', () => {
	it.each([
		['explicit ?since= wins over the header', '100', '999', 100],
		['Last-Event-ID is used when there is no ?since=', null, '999', 999],
		['no cursor anywhere → full snapshot', null, null, undefined],
		['?since=0 means everything', '0', '999', 0],
		['a non-numeric cursor degrades to a full snapshot', 'abc', null, undefined],
		['a negative cursor degrades to a full snapshot', '-5', null, undefined],
		['whitespace is tolerated', ' 123 ', null, 123]
	])('%s', (_name, since, lastEventId, expected) => {
		expect(resolveSinceTs(since, lastEventId)).toBe(expected);
	});

	it('a reconnecting client gets exactly the ticks it has not seen', () => {
		const store = new CasStore();
		const now = new Date(istAt(DAY, 15, 20, 0));
		store.ingest([payload(istAt(DAY, 15, 14), 1)], now);
		store.ingest([payload(istAt(DAY, 15, 14, 4), 2)], now);
		store.ingest([payload(istAt(DAY, 15, 14, 8), 3)], now);

		// the cursor is the id of the last frame the client saw
		const cursor = String(istAt(DAY, 15, 14, 4));
		const snapshot = store.snapshot(resolveSinceTs(null, cursor), now);

		expect(snapshot.ticks.nifty.map((t) => t.value)).toEqual([3]);
		const hello = encodeSseFrame({
			id: snapshotEventId(snapshot),
			event: 'hello',
			data: snapshot
		});
		expect(hello).toContain(`id: ${istAt(DAY, 15, 14, 8)}`);
		expect(hello).toContain('event: hello');
		expect(hello.endsWith('\n\n')).toBe(true);
	});
});

describe('frame shapes end to end', () => {
	it('produces the three frames /api/stream sends, in order, byte-exact', async () => {
		const stream = createSseStream();
		const snapshot = { tradeDate: DAY, serverNow: 1, stale: false };
		stream.send({
			id: snapshotEventId({ ticks: { nifty: [], banknifty: [], sensex: [] }, latest: {} }),
			event: 'hello',
			data: snapshot
		});
		const delta: StreamEvent = { id: '1724700000000', type: 'ticks', payload: { tradeDate: DAY } };
		stream.send(
			delta.type === 'ticks'
				? { id: delta.id, data: delta.payload }
				: { event: delta.type, data: delta.payload }
		);
		stream.send({ event: 'heartbeat', data: { ts: 1724700015000 } });

		expect(stream.pending).toBe(3);
		stream.close();
		const collected: string[] = [];
		for await (const frame of stream.events) collected.push(frame);

		expect(collected).toEqual([
			'id: 0\nevent: hello\ndata: {"tradeDate":"2026-08-26","serverNow":1,"stale":false}\n\n',
			'id: 1724700000000\ndata: {"tradeDate":"2026-08-26"}\n\n',
			'event: heartbeat\ndata: {"ts":1724700015000}\n\n'
		]);
	});
});
