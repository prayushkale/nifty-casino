import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'dark' | 'light';
const KEY = 'nc-theme';

function getInitial(): Theme {
	if (!browser) return 'light';
	const stored = localStorage.getItem(KEY) as Theme | null;
	if (stored === 'light' || stored === 'dark') return stored;
	if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
	return 'light';
}

function createTheme() {
	const store = writable<Theme>(getInitial());

	function apply(theme: Theme): void {
		if (!browser) return;
		const root = document.documentElement;
		root.classList.toggle('dark', theme === 'dark');
		root.classList.toggle('light', theme === 'light');
		localStorage.setItem(KEY, theme);
		const meta =
			document.getElementById('theme-color') ?? document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#09090b');
	}

	return {
		subscribe: store.subscribe,
		set: (v: Theme) => {
			apply(v);
			store.set(v);
		},
		toggle: () => {
			const current = get(store);
			const next: Theme = current === 'dark' ? 'light' : 'dark';
			apply(next);
			store.set(next);
		},
		init: () => {
			const t = getInitial();
			apply(t);
			store.set(t);
		}
	};
}

export const theme = createTheme();
