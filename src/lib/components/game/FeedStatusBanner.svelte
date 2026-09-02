<script lang="ts">
	import { feedStatus, type FeedConnection } from '$lib/stores/casStream';

	/**
	 * The one thin strip above the charts that says whether the numbers can be
	 * trusted (PLAN §5 T12 "connection/staleness banner").
	 *
	 * Four states, one line, most alarming first:
	 *
	 *   ⚠ feed stale      the auction is live and the newest tick is >12s old
	 *   ▤ fallback        SSE was abandoned (proxy) — REST polling at 8s
	 *   ○ reconnecting    the socket dropped; EventSource is re-establishing it
	 *   ● live            deltas are arriving
	 *
	 * Rendered server-side as nothing at all: `$feedStatus` sits at `idle` until the
	 * page's `onMount` starts the stream, so there is no SSR/CSR text to disagree.
	 */
	const COPY: Record<FeedConnection, { icon: string; text: string; cls: string } | null> = {
		idle: null,
		connecting: { icon: '○', text: 'connecting', cls: 'text-zinc-500' },
		live: { icon: '●', text: 'live', cls: 'text-up' },
		reconnecting: { icon: '○', text: 'reconnecting', cls: 'text-gold' },
		polling: { icon: '▤', text: 'fallback polling (8s)', cls: 'text-gold' },
		down: { icon: '○', text: 'feed stopped', cls: 'text-zinc-500' }
	};

	$: view = $feedStatus;
	$: base = COPY[view.status];
	/** Staleness outranks everything: it is the only state that says the *data* is wrong. */
	$: staleNow = view.stale;
</script>

{#if staleNow || (base && view.status !== 'live')}
	<div
		class="flex items-center gap-2 rounded-lg border bg-white px-3 py-1 text-xs shadow-sm dark:border-felt-700 dark:bg-felt-900/80"
		role="status"
		aria-live="polite"
	>
		{#if staleNow}
			<span class="text-down" aria-hidden="true">⚠</span>
			<span class="text-down">feed stale — no tick for 12s or more</span>
			<span class="text-zinc-600">the line you see is the last one the exchange sent</span>
		{:else if base}
			<span class={base.cls} aria-hidden="true">{base.icon}</span>
			<span class={base.cls}>{base.text}</span>
			<span class="text-zinc-600">
				{view.status === 'polling'
					? 'the live stream is unreachable from here — values refresh every 8s instead'
					: view.status === 'reconnecting'
						? 'rebuilding from the last tick you were sent'
						: ''}</span
			>
		{/if}
	</div>
{/if}
