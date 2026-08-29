<script lang="ts">
	import { dismissToast, toasts, type ToastKind } from '$lib/stores/toast';

	/**
	 * The floor's announcements (PLAN §5 T13): bet placed, bet refused, refund
	 * landed, day settled.
	 *
	 * Mounted once in `+layout.svelte` so every page shares the same stack — the
	 * store is the singleton, this is only its renderer.
	 *
	 *   • Max three, newest on top — the store caps it, so a run of failures can
	 *     never bury the screen.
	 *   • Click (or Enter/Space) dismisses: each toast is a real button.
	 *   • `aria-live="polite"` on the container, so a screen reader announces a
	 *     result without interrupting whatever the player was reading.
	 *   • Bottom-centre on mobile, above the fixed nav and clear of the thumb;
	 *     bottom-right on desktop, where it cannot cover the place-bet button.
	 *   • SSR renders nothing (the store is empty), so there is no hydration flash.
	 */
	const ICON: Record<ToastKind, string> = { ok: '✦', err: '✕', info: '◆' };
	const HIDDEN: Record<ToastKind, string> = {
		ok: 'success',
		err: 'error',
		info: 'notice'
	};
</script>

{#if $toasts.length > 0}
	<div
		class="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col-reverse items-center gap-2 px-3 sm:items-center md:inset-x-auto md:bottom-5 md:right-5 md:items-end md:px-0"
		aria-live="polite"
		aria-atomic="false"
	>
		{#each $toasts as toast (toast.id)}
			<button
				type="button"
				class="nc-toast nc-toast-{toast.kind} nc-toast-enter max-w-sm"
				on:click={() => dismissToast(toast.id)}
				title="Dismiss"
			>
				<span class="mt-0.5 shrink-0 text-xs opacity-80" aria-hidden="true">{ICON[toast.kind]}</span
				>
				<span class="min-w-0 break-words">
					<span class="sr-only">{HIDDEN[toast.kind]}:</span>
					{toast.message}
				</span>
			</button>
		{/each}
	</div>
{/if}
