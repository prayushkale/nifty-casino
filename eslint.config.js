import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	prettier,
	...svelte.configs['flat/prettier'],
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		}
	},
	{
		// Generated artefacts, not source: `build/` is adapter-node's output, `dist/` is
		// desktop/dist (esbuild output), and `.desktop-stage/` is the staged runtime.
		ignores: [
			'.svelte-kit/*',
			'build/*',
			'dist/*',
			'desktop/dist/*',
			'.desktop-stage/*',
			'release/*',
			'node_modules/*',
			'.commandcode/*'
		]
	}
];
