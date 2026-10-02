/**
 * Stage the runnable game server for the desktop build.
 *
 * Turns `npm run build` output into `.desktop-stage/server/`, which electron-builder
 * copies to `resources/server`.
 *
 * The server is BUNDLED into one file rather than shipped with a node_modules directory.
 * That is not a micro-optimisation — it is required:
 *
 * - adapter-node externalises the runtime deps (postgres, @supabase/ssr,
 *   @supabase/supabase-js), so a bare `build/` throws MODULE_NOT_FOUND at runtime.
 * - Shipping them in a nested `node_modules` does not work either: electron-builder
 *   prunes `node_modules` to the ROOT project's production dependencies, so a nested one
 *   is dropped from `extraResources` entirely. Verified on electron-builder 26.15.3 — the
 *   directory vanishes even with an explicit `filter` of all files.
 * - Bundling sidesteps the whole problem and removes the second reason asar is unsafe for
 *   this server (dynamic `import()` of externalised modules), so the bundle can live
 *   outside the archive with no special-casing.
 *
 * Side effect: the installer is ~19 MB smaller than shipping a node_modules tree.
 *
 * Output layout, which electron-builder.yml copies verbatim to `resources/server`:
 *
 *   .desktop-stage/server/
 *     server.mjs   ← everything: adapter-node + app + deps, inlined (~1.7 MB)
 *     client/      ← hashed SvelteKit assets, read from disk at request time (~6 MB)
 *
 * Nothing else is copied. The unbundled `build/` chunks are dead weight once the entry is
 * inlined, and shipping them cost ~4.6 MB per installer for files nothing reads.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, '.desktop-stage', 'server');
const build = join(root, 'build');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message) {
	console.error(`[desktop-stage] ${message}`);
	process.exit(1);
}

if (!existsSync(join(build, 'index.js')))
	fail('build/index.js is missing — run `npm run build` first.');

// 1. Compile the Electron main process. Electron loads plain JS, so this cannot be skipped.
//
// The output directory is cleared first: electron-builder copies whatever is in it, so a
// file left over from an earlier run (the entry point was once main.js, now main.cjs)
// would ship a dead second copy inside the asar.
//
// The `.cjs` extension is load-bearing, not cosmetic: this repo's package.json declares
// `"type": "module"`, and that package.json is shipped inside the asar. Without `.cjs`,
// Electron resolves main.js as ESM and the CommonJS output dies with
// "require is not defined in ES module scope". Verified by launching the packaged app.
const mainDist = join(root, 'desktop', 'dist');
rmSync(mainDist, { recursive: true, force: true });
await esbuild({
	entryPoints: [join(root, 'desktop', 'src', 'main.ts')],
	outfile: join(mainDist, 'main.cjs'),
	platform: 'node',
	target: 'node22',
	format: 'cjs', // Electron's main process entry is CommonJS
	bundle: true,
	external: ['electron'],
	sourcemap: true,
	logLevel: 'warning'
});

rmSync(join(root, '.desktop-stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 2. Copy the client assets. adapter-node serves these from disk at request time (the
//    hashed SvelteKit build output and the static/ files), so they must travel with the
//    bundle — verified by fetching one of the hashed entrypoints out of a bundle that has
//    nothing else beside it.
cpSync(join(build, 'client'), join(stage, 'client'), { recursive: true });

// 3. Inline adapter-node, the app, and every runtime dependency into one entry point.
await esbuild({
	entryPoints: [join(build, 'index.js')],
	outfile: join(stage, 'server.mjs'),
	platform: 'node',
	target: 'node22',
	format: 'esm',
	bundle: true,
	// Node built-ins stay external; Electron is never imported by the server.
	external: ['node:*', 'electron'],
	sourcemap: true,
	logLevel: 'warning'
});

// 4. Prove the entry points the packaged app actually loads exist, before packaging can
//    turn a missing file into a blank window on someone else's machine.
for (const required of ['server.mjs', 'client']) {
	if (!existsSync(join(stage, required))) fail(`staged server is missing ${required}`);
}

// 5. Record what this stage contains, so `desktop/src/main.ts` can report it on failure.
writeFileSync(
	join(stage, 'STAGE.json'),
	`${JSON.stringify(
		{
			version: rootPkg.version,
			electron: rootPkg.devDependencies?.electron ?? null,
			builtAt: new Date().toISOString()
		},
		null,
		2
	)}\n`
);

console.log(`[desktop-stage] staged ${stage}`);
console.log('[desktop-stage] the server is bundled — there is no node_modules to ship.');
console.log(
	'[desktop-stage] run the app with `npm run desktop:dev`, or package it with `npm run desktop:dist`.'
);
