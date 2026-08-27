/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	darkMode: 'class',
	theme: {
		extend: {
			colors: {
				felt: {
					950: '#09090b',
					900: '#101014',
					800: '#18181f',
					700: '#23232d'
				},
				gold: {
					DEFAULT: '#f5c451',
					dim: '#a8842f',
					glow: '#ffe08a'
				},
				up: '#34d399',
				down: '#f87171'
			},
			fontFamily: {
				display: ['ui-sans-serif', 'system-ui', 'sans-serif'],
				num: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
			},
			boxShadow: {
				glow: '0 0 24px rgba(245,196,81,0.25)',
				card: '0 8px 30px rgba(0,0,0,0.55)'
			}
		}
	},
	plugins: []
};
