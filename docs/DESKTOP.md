# Desktop build

NiftyCasino ships as a double-clickable desktop app for Windows, macOS and Linux. Each install
runs its **own local game server** and opens its **own window** — no Node install, no Docker, no
`.env`, no account setup. It is the same SvelteKit app, running on your machine.

---

## What you get

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Installer | `NiftyCasino-<v>-win-x64.exe` (NSIS) | `NiftyCasino-<v>-mac-{arm64,x64}.dmg` | `NiftyCasino-<v>-linux-x86_64.AppImage` |
| Also | `…-win-x64.exe` portable — no install, just run it | universal `.dmg` (both arches) | |
| Size | ~120 MB | ~120 MB | ~123 MB |

The size is Chromium. That is the cost of "no browser required, no webview dependency, identical
on every machine".

### Everything runs locally

- **Your data is yours.** Wallets, bets, history and stats live in a JSON file in the app's own
  data directory. Nothing is uploaded, nothing is shared.
- **No shared leaderboard.** Each install is its own casino, so the pot and the board contain only
  you. The web deployment is the multiplayer one; this is the offline one.
- **The live feed is on**, time-gated exactly as designed — the poller only talks to NSE/BSE
  between **15:13:30 and 15:42:00 IST** on trading days, and settlement runs **15:30–17:00 IST**.
  Outside those windows the app makes no outbound requests at all. Residential connections are
  preferred: a datacenter IP often gets blocked by the exchanges' CDN.

---

## Build it

```bash
npm ci --include=dev
npm run desktop:stage        # build the app + bundle the server
npm run desktop:dist:linux   # → release/NiftyCasino-<v>-linux-x86_64.AppImage
```

| Script | What it does |
| --- | --- |
| `desktop:stage` | `npm run build`, compile `desktop/src/main.ts`, bundle the server into `.desktop-stage/` |
| `desktop:dev` | stage, then launch Electron against it (this is the dev loop) |
| `desktop:pack` | stage, then an unpacked build in `release/` — fast sanity check, no installer |
| `desktop:dist` | stage, then a full installer for the current platform |
| `desktop:dist:linux` | force the Linux AppImage |

### macOS and Windows builds come from CI

A macOS `.dmg` **cannot** be built on Linux or Windows — it needs Apple's frameworks and signing
toolchain. Windows installers cross-compile from Linux but need Wine, which is slow and fragile.

So the honest answer is: **tag a version and let GitHub build them.**

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/desktop.yml` then builds one artefact per platform and attaches them to a
GitHub Release. Windows also gets a portable exe, and macOS gets a universal binary.

---

## Signing

**Unsigned builds work** — they just make the OS complain on first run:

| OS | What the user sees | How to proceed |
| --- | --- | --- |
| Windows | "Windows protected your PC" | More info → Run anyway |
| macOS | "cannot be opened because the developer cannot be verified" | right-click the app → Open |

Signing is already wired into the workflow and activates on its own once these repository secrets
exist. Nothing in the code changes.

| Secret | Cost | Effect |
| --- | --- | --- |
| `WINDOWS_CERT_PFX_BASE64` | ~$70–200/yr | Authenticode — no SmartScreen warning |
| `WINDOWS_CERT_PASSWORD` | — | password for the above |
| `APPLE_ID` | $99/yr (Apple Developer) | Developer ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | — | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | — | 10-char team id |

```bash
# base64 a Windows .pfx into the secret (macOS/Linux)
base64 -i cert.pfx | pbcopy
```

An EV certificate is *not* required — a standard code-signing cert removes the SmartScreen warning
after a few downloads accumulate reputation.

---

## How it is put together

```
┌─ Electron main process (app.asar, ~6 KB) ────────────────────┐
│  single-instance lock → free port → utilityProcess.fork      │
│  → poll until it answers → BrowserWindow → quit: SIGTERM     │
└──────────────────────────────────────────────────────────────┘
                              ▼
┌─ Game server (resources/server, outside asar) ──────────────┐
│  server.mjs   ← adapter-node + app + deps, bundled (1.7 MB) │
│  client/      ← hashed SvelteKit assets                       │
│  LocalMemoryStore ──► userData/niftycasino.json              │
└──────────────────────────────────────────────────────────────┘
```

Three decisions worth knowing about before you change anything:

**The server is bundled into one file.** `adapter-node` externalises its runtime dependencies, so
a bare `build/` cannot run. Shipping them in a nested `node_modules` does not work either —
electron-builder prunes `node_modules` down to the *root* project's production dependencies and
drops a nested one entirely (verified on 26.15.3; it disappears even with an explicit filter). So
`scripts/desktop-stage.mjs` bundles instead. That also means **no `node_modules` ships at all**,
which is where ~19 MB of the installer went.

**The server lives outside the asar.** The SvelteKit bundle resolves modules with dynamic
`import()`, and dynamic imports do not work from inside an asar archive.

**`directories.buildResources` must not be `build/`.** electron-builder's default for that is
`build/`, which is precisely adapter-node's output directory — it would scan the compiled server
looking for icons.

---

## Where your data lives

| OS | Path |
| --- | --- |
| Linux | `~/.config/NiftyCasino/niftycasino.json` |
| macOS | `~/Library/Application Support/NiftyCasino/niftycasino.json` |
| Windows | `%APPDATA%\NiftyCasino\niftycasino.json` |

It is a plain, readable JSON file. Back it up by copying it. Delete it to start fresh with a
1,000 NC signup bonus.

**What is and isn't guaranteed.** Quitting normally — closing the window, `SIGTERM`, Task Manager's
"End task" — always flushes, so your balance is safe. A hard `kill -9` or a power cut cannot be
intercepted by anything running inside the process; anything from the last fraction of a second may
be lost. The file is written atomically (temp file + rename), so a crash can leave it slightly
stale but never half-written. A corrupt or unrecognised file starts a fresh store rather than
refusing to start.

---

## Troubleshooting

**"server not found"** — you ran `electron .` without staging. Run `npm run desktop:stage` first.

**Charts stay empty** — expected outside market hours. The feed only runs 15:13:30–15:42:00 IST. A
`● live` indicator in the app means the poller is running.

**"No tick for N seconds" / feed stopped** — the exchanges block datacenter IPs. Residential
connection, or see `docs/RUNBOOK.md` §4 for the relay options.

**macOS: app is quarantined** — right-click → Open. Unsigned builds always do this once.

**Linux: AppImage will not run** — needs FUSE. `chmod +x` the file, or extract it:
`./NiftyCasino.AppImage --appimage-extract`.

**Port already in use** — the app asks the OS for a free port on every launch, so this should not
happen. If it does, another instance is running; the single-instance lock will focus that window
instead of starting a second server.

---

## What it deliberately does not do

- **No auto-update.** `electron-updater` needs a signed first release and a stable update feed.
  Adding it before signing ships a broken updater. Revisit after certificates exist.
- **No shared state.** See "What you get" above — this is the intentional trade for zero setup.
- **No bundled database.** Postgres would multiply the installer size several times over for data
  that is one player's.
- **No touch of the game maths.** The EV launch gate (`npm run sim:ev`) is the most carefully
  defended thing in this repo and packaging has no reason to perturb it.
