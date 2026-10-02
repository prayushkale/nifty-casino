/**
 * Electron main process for the NiftyCasino desktop build.
 *
 * The app is a full SvelteKit server, not a wrapper around a website: this process starts
 * the real `adapter-node` build on a loopback port, waits for it to answer, and points a
 * window at it. Everything the server needs is bundled beside it.
 *
 * Design notes worth keeping:
 *
 * - **Loopback only.** `HOST` is pinned to 127.0.0.1 and never 0.0.0.0. The desktop build
 *   runs with no Supabase project, which turns `POST /api/auth/signup` into an
 *   unauthenticated "claim this handle" endpoint (see src/lib/server/auth/devAuth.ts).
 *   That is safe only while nothing off this machine can reach the port. It is also what
 *   keeps `crypto.randomUUID()` — the one secure-context API the login page uses — working,
 *   since 127.0.0.1 is a potentially-trustworthy origin. Do not "fix" the host binding.
 * - **`utilityProcess`, not `child_process`.** It runs on the Node runtime already embedded
 *   in Electron, so there is no second Node binary to ship, and it does not depend on the
 *   `ELECTRON_RUN_AS_NODE` fuse (which would break `child_process` if ever flipped).
 * - **A real child process, not an in-process handler.** adapter-node only honours its
 *   lifecycle env vars (PORT, HOST, SHUTDOWN_TIMEOUT) and its SIGTERM/SIGINT drain in its
 *   own `index.js`. Importing `handler.js` into this process would mean reimplementing
 *   graceful shutdown — and this app holds SSE connections open for 10 minutes.
 * - **One instance per data file.** Two windows would mean two servers writing the same
 *   JSON file, interleaved. The lock below turns that into "focus the existing window".
 */
import { app, BrowserWindow, dialog, shell, utilityProcess } from 'electron';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { UtilityProcess } from 'electron';

const HOST = '127.0.0.1';

/** How long to wait for the server to answer before giving up and showing an error. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 150;

let mainWindow: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
/** Set once quitting begins, so the window-closed handler knows to wait for the child. */
let quitting = false;

/**
 * Resolve the built server's entrypoint.
 *
 * In a packaged app the server is copied to `resources/server` by electron-builder's
 * `extraResources`, which lives OUTSIDE the asar archive: the SvelteKit bundle resolves
 * modules with dynamic `import()`, and dynamic imports do not work from inside an asar.
 *
 * The entry is `server.mjs`, not `index.js` — scripts/desktop-stage.mjs bundles adapter-node
 * and its externalised runtime deps (postgres, @supabase/*) into that one file. Shipping a
 * nested `node_modules` instead does not work: electron-builder prunes `node_modules` to
 * the root project's production deps, so a nested one is dropped from the package.
 */
function resolveServerEntry(): string {
	if (app.isPackaged) {
		return join(process.resourcesPath, 'server', 'server.mjs');
	}
	return join(app.getAppPath(), '.desktop-stage', 'server', 'server.mjs');
}

/**
 * Ask the OS for a free TCP port.
 *
 * Listening on port 0 and reading back the assignment is the only race-free way — scanning
 * for "free" ports and handing one to adapter-node leaves a window where something else
 * takes it first. There is a residual race (we close, then the server binds) which is why
 * the readiness poll below treats a start-up failure as fatal and reports it, rather than
 * silently retrying.
 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.once('error', reject);
		probe.listen({ host: HOST, port: 0 }, () => {
			const address = probe.address();
			if (address === null || typeof address === 'string') {
				probe.close();
				reject(new Error('could not determine a free port'));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

/** Resolve once the server answers, or reject with a useful message. */
async function waitForServer(url: string): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let lastError = 'timed out';

	while (Date.now() < deadline) {
		if (server === null) throw new Error('the game server exited during startup');
		try {
			const response = await fetch(url, { redirect: 'manual' });
			// Any HTTP answer means adapter-node is up and routing.
			if (response.status > 0) return;
		} catch (err: unknown) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
	}
	throw new Error(
		`the game server did not start within ${READY_TIMEOUT_MS / 1000}s (${lastError})`
	);
}

function startServer(entry: string, port: number, dataFile: string): UtilityProcess {
	// Built from scratch rather than inheriting: a stray DATABASE_URL or PUBLIC_SUPABASE_URL
	// in the developer's shell would silently turn this into a different app.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? '',
		HOME: process.env.HOME ?? '',
		SystemRoot: process.env.SystemRoot, // Windows: child processes need this
		NODE_ENV: 'production',
		HOST,
		PORT: String(port),
		// adapter-node's default is 30s; a solo player should not wait that long to quit.
		SHUTDOWN_TIMEOUT: '5',
		NC_DATA_FILE: dataFile
		// DATABASE_URL, PUBLIC_SUPABASE_* deliberately absent — see the header comment.
	};

	const child = utilityProcess.fork(entry, [], {
		// `utilityProcess` rejects any env value that is not a string, including
		// `undefined` — a Windows-only var like SystemRoot being unset is enough to throw
		// "Invalid value for env" and kill start-up. Drop them rather than stringify.
		env: Object.fromEntries(
			Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
		),
		stdio: 'pipe',
		serviceName: 'niftycasino-server'
	});

	// Pipe the child's output into the main console so the server's own logs ([db],
	// [cas-poller], [settle]) stay visible when running from a terminal.
	child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
	child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
	child.on('exit', (code) => {
		// A crash while running should surface, not silently leave a dead window.
		if (!quitting) {
			dialog.showErrorBox(
				'NiftyCasino stopped',
				`The game server exited unexpectedly (code ${code}).`
			);
			app.quit();
		}
	});

	return child;
}

function createWindow(url: string): BrowserWindow {
	const window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 900,
		minHeight: 640,
		show: false,
		backgroundColor: '#09090b',
		title: 'NiftyCasino',
		autoHideMenuBar: true,
		webPreferences: {
			// The renderer only ever talks to our own loopback server over relative URLs.
			// No node integration, and nothing that would let page JS reach the main process.
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});

	// Show only once there is something to show — an all-white flash reads as a broken app.
	window.once('ready-to-show', () => window.show());

	// The app is a single surface; external links belong in the real browser.
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith('http://') || target.startsWith('https://')) {
			void shell.openExternal(target);
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, target) => {
		if (!target.startsWith(url)) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});

	void window.loadURL(url);
	return window;
}

/** Tell the server to shut down and wait for it, so the data file gets its final flush. */
function stopServer(): Promise<void> {
	const child = server;
	server = null;
	if (child === null) return Promise.resolve();

	return new Promise((resolve) => {
		const done = setTimeout(() => {
			child.kill(); // still listening after SHUTDOWN_TIMEOUT — force it
			resolve();
		}, 7_000);

		child.once('exit', () => {
			clearTimeout(done);
			resolve();
		});
		child.kill(); // SIGTERM: adapter-node drains open requests before closing
	});
}

async function main(): Promise<void> {
	const entry = resolveServerEntry();
	if (!existsSync(entry)) {
		dialog.showErrorBox(
			'NiftyCasino — server not found',
			`Could not find the game server at:\n${entry}\n\nRun \`npm run desktop:stage\` before starting the app.`
		);
		app.quit();
		return;
	}

	const port = await findFreePort();
	const url = `http://${HOST}:${port}`;
	const dataFile = join(app.getPath('userData'), 'niftycasino.json');

	server = startServer(entry, port, dataFile);

	try {
		await waitForServer(url);
	} catch (err: unknown) {
		dialog.showErrorBox(
			'NiftyCasino — could not start',
			err instanceof Error ? err.message : String(err)
		);
		app.quit();
		return;
	}

	mainWindow = createWindow(url);
	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

// A second instance would race the first on the same JSON file and could lose a write.
// Focus what is already open instead.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow === null) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});

	void app.whenReady().then(main);

	// Closing the window quits the app — the server has no purpose without a window.
	app.on('window-all-closed', () => app.quit());

	// Quit only once the server has actually flushed, or a wallet write can be lost.
	app.on('before-quit', (event) => {
		if (quitting || server === null) return;
		event.preventDefault();
		quitting = true;
		void stopServer().finally(() => app.quit());
	});
}
