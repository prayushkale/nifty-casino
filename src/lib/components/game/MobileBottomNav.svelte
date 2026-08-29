<script lang="ts">
	import { page } from '$app/stores';

	/**
	 * The mobile-only third anchor (PLAN §4: "fixed bottom nav (3 tabs)").
	 *
	 * Three destinations, one thumb-reach away, every screen: the game, the
	 * leaderboard, and the player's own page — which for a stranger is the login
	 * form, since an anonymous player has no `/u/<handle>` to go to. Hidden from
	 * `md` up, where the same three links live in the footer.
	 */
	export let handle: string | null = null;

	const TABS = [
		{ href: '/', label: 'Game', icon: '🎰' },
		{ href: '/leaderboard', label: 'Board', icon: '🏆' },
		{ href: '/auth/login', label: 'Me', icon: '👤' }
	] as const;

	$: pathname = $page.url.pathname;
	$: meHref = handle ? `/u/${handle}` : '/auth/login';

	/** Exact match for the game root, prefix match for the rest. */
	function isActive(tabHref: string): boolean {
		if (tabHref === '/') return pathname === '/';
		if (tabHref === '/auth/login')
			return pathname.startsWith('/auth') || pathname.startsWith('/u/');
		return pathname.startsWith(tabHref);
	}
</script>

<nav
	class="fixed inset-x-0 bottom-0 z-30 border-t border-felt-700 bg-felt-950/95 backdrop-blur md:hidden"
	aria-label="Main"
>
	<ul class="mx-auto flex max-w-md">
		{#each TABS as tab (tab.href)}
			{@const href = tab.label === 'Me' ? meHref : tab.href}
			<li class="flex-1">
				<a
					{href}
					class="flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors {isActive(
						href
					)
						? 'text-gold'
						: 'text-zinc-500'}"
					aria-current={isActive(href) ? 'page' : undefined}
				>
					<span class="text-lg leading-none" aria-hidden="true">{tab.icon}</span>
					{tab.label}
				</a>
			</li>
		{/each}
	</ul>
</nav>
