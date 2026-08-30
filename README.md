# NiftyCasino

A standalone forecasting-game web app: between **15:00–15:20 IST** each trading day, players bet
**play-money NC chips** on how NIFTY 50, BANKNIFTY and SENSEX will settle in SEBI's
**Closing Auction Session (CAS)** — with live charts streamed from our server (which does all the
scraping), automatic settlement against the official close, and a gamified casino-floor UI.

> **No real money. Entertainment only.** Chips (`NC`) are virtual with zero cash-out.

## Quick start

```bash
npm install
cp .env.example .env   # optional for local dev — see "Auth backends"
npm run dev            # http://localhost:5173
```

Gates used in CI / every task:

```bash
npm run check && npm run lint && npm run test && npm run build
```

## House edge (EV) simulation

**The launch gate.** Every ladder option must have an expected value in **[0.85, 0.95]** — a
5–15% house edge. Nothing ships until that is true, and `scripts/simulate-ev.ts` exits **1** if it
is not, so it can be used as a CI gate:

```bash
npm run sim:ev                                 # 200,000 samples, seed 20260829, ~2s
npx tsx scripts/simulate-ev.ts --samples 50000 --seed 7 --quiet
```

The simulator contains no game maths of its own: each simulated day is graded by the real
`computeTier` and priced by the real `payoutFor` (`src/lib/game/tier`), with steps, odds and
tolerances read from `LADDER_CONFIG`. `src/lib/config/ladder-ev.test.ts` re-imports that same model
at 2,000 samples as a fast CI tripwire against an odds edit that silently breaks the edge — the
script above is the authoritative gate. `--suggest` prints the odds that would centre each option
at EV 0.90 (that is how the current table was derived).

**Modelling assumptions.** Δ = officialClose − prevClose is a full trading day's move, so
σ_day = annVol/√252 × level at 13% (NIFTY, SENSEX) / 15% (BANKNIFTY), zero-centred with a −0.02%/day
drift, plus an 8% Student-t(ν=4) heavy-tail mixture for gap days. Sensitivity (±25% vol, drift 0,
15% tail, and a "trendy auction" magnet that pulls closes toward the nearest rung) is printed but
not gated; the adversarial magnet case and a low-vol regime are the two that flip the edge
player-favourable.

**Final table** (`npm run sim:ev`, seed 20260829, 200,000 samples/scenario, 2026-08-29):

```
◆ base — 13%/15% ann vol, drift −0.02%/day, 8% t4 tail — THE GATE  ← GATED
underlying   step   odds   P(hit)  P(flat)  P(miss)       EV    edge  verdict
nifty         ±50   13.9 0.0577 0.0992 0.8432 0.9006   9.94%  PASS
nifty        ±100   15.2 0.0526 0.0992 0.8482 0.8987  10.13%  PASS
nifty        ±150   17.9 0.0448 0.0992 0.8561 0.9006   9.94%  PASS
nifty        ±200   22.4 0.0358 0.0992 0.8650 0.9012   9.88%  PASS
banknifty    ±100   18.3 0.0450 0.0766 0.8784 0.8996  10.04%  PASS
banknifty    ±200   19.1 0.0431 0.0766 0.8803 0.9001   9.99%  PASS
banknifty    ±300   21.3 0.0386 0.0766 0.8848 0.8991  10.09%  PASS
banknifty    ±400   24.0 0.0342 0.0766 0.8891 0.8984  10.16%  PASS
sensex       ±150   17.2 0.0470 0.0907 0.8623 0.8985  10.15%  PASS
sensex       ±250   17.8 0.0454 0.0907 0.8639 0.8985  10.15%  PASS
sensex       ±400   20.3 0.0399 0.0907 0.8693 0.9015   9.85%  PASS
sensex       ±500   22.4 0.0361 0.0907 0.8732 0.8999  10.01%  PASS

BASE-CASE GATE: ALL OPTIONS PASS — EV range 0.8984 … 0.9015 vs band [0.85, 0.95]
verdict: LAUNCH GATE GREEN
```

> **These odds replace PLAN §0.2's table.** The plan's 6×/4.5×/3.8×/3.2× priced a 55–81% house
> edge, because Δ is a whole day's move (σ ≈ 205/529/672 pts) against a ±15/±30/±40 pt hit band —
> P(hit) is only 3.4–5.8%. The odds above are the simulator's, and they **rise** with the step: with
> a fixed-width band, a bigger step sits further into the tail of a zero-centred distribution and is
> harder to hit, which is the opposite of PLAN §0.2's "closer targets are harder" rationale. Tolerance,
> dead zone and the full-loss miss rule are game rules and were not touched. See the provenance
> comment in `src/lib/config/ladder.ts`.

## Simulation & load

Two scripts, both plain `tsx` with no new dependencies, both part of a launch drill:
`scripts/dry-run-day.ts` proves the money path end to end, `scripts/load-sim.ts` proves the
fan-out. They answer the two halves of the pre-launch checklist (`docs/RUNBOOK.md` §9) that a
single curl cannot: "does a settled day add up?" and "does 10,000 players hold?".

### `dry-run-day` — a whole fake trading day

```bash
npx tsx scripts/dry-run-day.ts --users 25            # memory store, free, ephemeral
npx tsx scripts/dry-run-day.ts --users 3 --seed 7    # twice → byte-identical output
npx tsx scripts/dry-run-day.ts --users 2000          # settlement-burst drill (PLAN §6 R7)
npx tsx scripts/dry-run-day.ts --date 2026-08-27 --yes   # a free past day, real Postgres
```

It runs the day in order — session, wallets (1,000 NC + signup ledger row + zeroed stats, the
same unit of work migration 0002 runs), prev-day anchors, 1–3 bets per player through the real
`store.placeBet` money path at an in-window `nowMs`, FAKE official closes, then
`settleNow(store, date, { capture: false })`, i.e. the production settlement path with the
capture off because the closes are already on disk. Each index gets one **scenario**: `hit`
(on a rung), `flat` (inside the dead zone) or `miss` (past every rung), so all three verdicts
exist in every run and no run's verdicts are an accident of sampling.

Invariants — any failure prints `INVARIANTS FAILED` and exits **1**, so the script is a gate and
not a demo:

|     | proven                                                            |
| --- | ----------------------------------------------------------------- |
| I1  | `Σ(ledger) == balance`, and `Σ(ledger) − signup == balance − 1000` (PLAN §8's form) for **every** player |
| I2  | replaying a wallet's ledger in `id` order reproduces the balance, never dips below 0, and every `balance_after` is honest |
| I3  | every bet settled exactly once, `payout == payoutFor(tier, stake, odds)`          |
| I4  | every verdict equals `computeTier(bet, anchor, close)`; the `hit`/`flat`/`miss` scenarios came out as planned |
| I5  | `daily_pots` equals the bets: `total_bets`, `total_staked`, `total_paid_out`, `players_count` |
| I6  | every bet's odds are today's ladder odds (nothing invented at placement)          |
| I7  | re-settling is a numeric no-op — a second `settleNow` **and** the same chunk handed straight back to `store.settleBets` |

```
[dry-run-day] anchors (2026-08-28) → fake official closes (2026-08-29)
[dry-run-day]   nifty      anchor   25218.12  scenario=miss  close   25459.86  Δ   +241.74
[dry-run-day]   banknifty  anchor   56365.62  scenario=hit   close   55952.82  Δ   -412.80  winning rung down+400
[dry-run-day]   sensex     anchor   82741.78  scenario=flat  close   82696.29  Δ    -45.49
[settle] 2026-08-29 settled: 44 bet(s) across 1 chunk(s), 53830 NC paid out, 2040 XP awarded

[dry-run-day] BALANCE ARC — 25 player(s) from a 1000 NC signup
  handle             start  staked  hit flat miss credited   final     net  I1
  d0829s260829u0001   1000     500    1    0    0    12000   12500   11500  ✓
  d0829s260829u0002   1000     225    1    0    1      600    1375     375  ✓
  ...
  TOTAL              25000    4870   16   11   17    53830   73960
[dry-run-day] re-settle: status=already-settled settled=0 paidOut=0 — snapshot identical
[dry-run-day] chunk replay: 44 settled outcome(s) re-run → settled=0 skipped=44 — snapshot identical
[dry-run-day] INVARIANTS OK — I1 ledger==balance for all 25 player(s) (net −1000) · I2 ledger replay · I3 payouts · I4 verdicts · I5 pots · I6 ladder odds · I7 re-settle is a no-op
```

Guards: with `DATABASE_URL` unset this drills the **memory** driver and writes nothing that
outlives the process. With `DATABASE_URL` set it writes real rows, so it **requires `--yes`**,
prints everything it is about to write first, and refuses a date that already has a session, bets
or official closes — a drill must never trample a day that happened, and never overwrite an
anchor that a real payout hung off. `--chunk-size` splits settlement into several transactions so
the chunked path (PLAN §6 R7) is exercised, not just read about.

> The memory driver snapshots every table on every transaction, so a 2,000-wallet drill takes
> ~90s on a laptop. That is the memory driver, not the engine — a burst number belongs on
> Postgres (`--yes` + `DATABASE_URL`).

### `load-sim` — virtual clients against a running server

```bash
npm run build && CAS_POLLER_DISABLED=1 SETTLE_DISABLED=1 PORT=3000 node build/index.js   # terminal 1
npx tsx scripts/load-sim.ts --base http://localhost:3000 --conns 300 --duration 20 --ramp 5   # terminal 2
npx tsx scripts/load-sim.ts --base http://localhost:3000 --conns 300 --sse-ratio 0.5          # fan-out heavy
npx tsx scripts/load-sim.ts --base http://localhost:3000 --conns 10000 --duration 120 --ramp 30   # the §8 target
```

A plain-Node generator: global `fetch`, a hand-rolled SSE frame reader over the response stream,
`AbortController`s — no k6, so its own overhead is visible rather than hidden in a tool's event
loop. Clients are a mix of `GET /api/state` (60%), `GET /api/cas/all` (30%, always the full
snapshot — the heaviest ask) and long-lived `GET /api/stream` (10%) which counts frames, bytes
and reconnects and reconnects with capped backoff. The GET clients read at the cadence real
clients read (1s / 8s = `CAS_FALLBACK_POLL_MS`) rather than flat-out, so this measures
**concurrency, not throughput**; `--state-ratio/--cas-ratio/--sse-ratio` are normalised shares.
It is **read-only** — every request is a GET — so it is safe to point at production.

Reported per endpoint: requests, errors, mean/p50/p90/p95/p99/max, actual rps, and a 10ms-bucket
histogram. For SSE: connects, reconnects, dropped connections, frames/s, bytes, max concurrent,
and time-to-first-frame (what a player feels as "the chart came up"). With
`CAS_POLLER_DISABLED=1` a stream only sees its hello frame plus one heartbeat per 15s — a live
auction adds one frame per 4s poll, so the frame rate above is the floor, not the shape.

```
── results (40.1s wall incl. the 20s ramp, 10000 client(s)) ──
  endpoint             reqs  errors      rps     mean      p50      p90      p95      p99      max  (ms)
  /api/state         206514       0   5153.2      3.4      3.0      6.0      8.0     17.0     95.0
  /api/cas/all        10973       0    273.8      3.2      2.0      6.0      8.0     20.0     48.0
  /api/stream          1000       0        —      2.7      2.0      5.0      7.0     14.0     19.0  ← time to first frame
[load-sim] SSE: connects=1000 reconnects=0 dropped=0 frames=2000 (49.9/s) bytes=212.9 KiB maxConcurrent=1000
```

**File descriptors — read before a big run.** One virtual client is one socket on **both** ends:
the generator's process *and* the server's. The script reads the local soft limit (`ulimit -n`),
warns when `--conns` cannot fit under it, and prints the raise commands:

```bash
# macOS (soft 256 / hard 10240 by default)
ulimit -n 10240                                 # this shell, up to `ulimit -Hn`
sudo launchctl limit maxfiles 65536 200000      # persistent; needs a re-login
# Linux
ulimit -n 65535                                 # this shell, up to `ulimit -Hn`
#   /etc/security/limits.conf:  *  soft  nofile  65535   (re-login)
#   systemd unit:               LimitNOFILE=65535    (daemon-reload + restart)
```

and raise the **server's** limit too, or the run measures the OS rather than the app.

`--conns` defaults to 1000 so a bare run is always safe. The documented target (PLAN §8: "10k
concurrent SSE + snapshot p95 < 500ms on Tier 1 hardware") is a **Linux** number: on an
Apple M4 / 16 GB laptop with the limit raised, `--conns 10000` holds all 10,000 streams with
0 dropped / 0 reconnects and a time-to-first-frame p95 of 3ms, and a 10,000-client mix
(6,000 `/api/state` + 3,000 `/api/cas/all` + 1,000 SSE) served 206,514 requests in 40s with
**p95 = 8ms** — but stock macOS tops out near 10,240 fds per process, and a laptop is not Tier 1
hardware. Treat the laptop as the shape check and the Linux box as the gate, then record both in
`docs/RUNBOOK.md` §9.

## Architecture in one line

One server-side poller hits NSE/BSE every 4s during the CAS window → stores every tick in
Postgres + an in-memory hot buffer → fans out to browsers over SSE (`/api/stream`), with a REST
snapshot/backfill at `/api/cas/all?since=` as the refresh-recovery path. Browsers never touch NSE/BSE.

See `PLAN.md` for the full product spec, data model and scale plan.

## Persistence: two drivers, one interface

All feature code touches persistence through **`GameStore`** (`src/lib/server/db/interface.ts`)
and nothing else. `getStore()` (`src/lib/server/db/index.ts`) picks the driver once per process
and logs which one is live, tagged `[db]`:

| driver           | when                                                              | durability | used for                                                                  |
| ---------------- | ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `MemoryStore`    | `DATABASE_URL` unset (default)                                    | none       | tests, `npm run dev`, dry-run scripts — the whole game runs with zero setup |
| `PostgresStore`  | `DATABASE_URL` set                                                | durable    | production, and any local integration test                                 |

- Game **math needs no Supabase project**. Tests pass with no env vars at all; `npm run dev`
  works out of the box on the memory driver.
- **Auth does need the env vars** below, because it talks to Supabase. Unconfigured auth shows a
  banner in the UI; it never blocks the game.
- Money paths (`placeBet`, settlement) run as **single raw-SQL transactions** with
  `SELECT … FOR UPDATE` on the wallet row — PostgREST cannot express row locks, so the game store
  uses the `postgres` driver over `DATABASE_URL` directly, while **`supabase-js` is reserved for
  auth admin** (`src/lib/server/supabaseAdmin.ts`).

## Auth

Two modes, picked per request by configuration — never by the caller:

| mode              | when `PUBLIC_SUPABASE_URL` is… | session lives in                        | signup                   |
| ----------------- | ------------------------------ | --------------------------------------- | ------------------------ |
| **Supabase**      | set (+ `PUBLIC_SUPABASE_ANON_KEY`) | httpOnly cookies, via `@supabase/ssr` | email + verify link      |
| **dev fallback**  | unset                          | the `nc_dev_uid` cookie (30 days)       | a handle, claimed directly |

Everything below is play-money auth: the worst a stolen session costs is chips.

### How a request learns who you are

`src/hooks.server.ts` calls `resolveIdentity()` (`src/lib/server/auth/session.ts`) on every
request and stores the result on `locals`:

- **Supabase configured** → a per-request `@supabase/ssr` client is built over the request's
  cookies (`getSupabaseForEvent`) and `auth.getUser()` **revalidates the JWT with the auth
  server**. `getSession()` is never trusted: session cookies are client-held storage. The handle
  comes from the `profiles` row, which is the one place the *unique* handle lives.
- **Supabase unconfigured** → the guard in `devAuth.ts` (`isDevAuthEnabled`) is checked again,
  then `nc_dev_uid` is read and looked up in the same `profiles` table. A cookie pointing at a
  profile that no longer exists is deleted and the request is anonymous.
- Anything else is **anonymous**, which is a normal state, not an error.

Routes never touch cookies or Supabase — they read `locals.userId` / `locals.handle`.

### Endpoints (`/api/auth/*`)

| endpoint            | body            | effect                                                              |
| ------------------- | --------------- | ------------------------------------------------------------------- |
| `POST /signup`      | email, password, handle?, tos | `auth.signUp` → `{needsVerify}` / dev profile → `{dev:true}` |
| `POST /login`       | email, password | `signInWithPassword`; **400 `AUTH_NOT_CONFIGURED`** in dev mode      |
| `POST /logout`      | —               | `signOut()` + dev cookie cleared → `204`                            |
| `POST /forgot`      | email           | `resetPasswordForEmail` → `/auth/confirm?type=recovery`              |
| `POST /reset`       | password        | `updateUser({password})` — needs the recovery session                |
| `POST /resend`      | email           | `auth.resend({type:'signup'})`                                       |
| `GET /me`           | —               | `{authenticated, handle, source, devAuth}` for the header chrome     |

Unconfigured auth is a **400 `AUTH_NOT_CONFIGURED`, never a 500**: "no Supabase project" is a
supported state of this app, and the login page uses that code to show the dev panel instead.

Pages: `/auth/signup`, `/auth/verify`, `/auth/login`, `/auth/forgot`, `/auth/reset`, `/terms`,
and `/auth/confirm` (the link target — exchanges `?code=` or `?token_hash=&type=` server-side,
then forwards to `/` or `/auth/reset`).

### Handles

`^[a-z0-9_]{3,20}$`, lowercased. Skipped → generated as `trader` + 4 digits, retried on
collision (requested name → 4 generated → a uuid-derived last resort), exactly the ladder the
`handle_new_user()` trigger runs. An *invalid* handle is a 400 at the API (a form can ask) but a
silent generate at the database (a trigger cannot).

### Dev-auth fallback — read this before touching it

With no Supabase project, `POST /api/auth/signup` becomes an **unauthenticated identity-claim
endpoint**: send a handle, *be* that handle, wallet included. That is what makes local
multi-player testing trivial (type an existing handle to log in as that player), and it is
survivable only because:

- the guard is fail-closed: dev auth is dead code the moment `PUBLIC_SUPABASE_URL` is set, and
  hooks re-check the guard, so a stale dev cookie is worthless in a real deployment;
- unconfigured means the wallet is in RAM (or a Postgres with no auth provider) — nothing of
  value is at stake;
- a half-configured deploy (URL set, anon key missing) keeps dev auth **off** rather than
  silently switching identity mechanisms.

Never "temporarily" relax the guard to demo something: put a project behind it instead.

Wallet provisioning in dev mirrors the 0002 trigger row for row — `profiles` at
`SIGNUP_BONUS` (1,000 NC), one `signup_bonus` ledger row with `balance_after = 1,000` (so the
`sum(ledger) == balance − 1,000` invariant in the launch checklist holds from row one), and a
zeroed `user_stats` row, all inside a single `store.tx()`.

### What the tests do not cover

Automated tests (`src/lib/server/auth/*.test.ts`) cover handle rules, the signup validator, the
dev guard, dev wallet math and identity resolution. **They cannot cover the live Supabase
flows** — signup/verify/login/forgot/reset need a real project and a real inbox. That is what
the checklist below is for.

### Manual verification checklist (needs a configured project + an inbox)

1. `cp .env.example .env`, fill `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`; `npm run dev`. The login page must **not** show
   the dev panel now.
2. **Signup** `/auth/signup` with a handle → lands on `/auth/verify` ("check your inbox").
3. **Verify** by clicking the emailed link → you are redirected home and the top bar shows your
   handle.
4. **Profile + wallet**: in the DB, `profiles` has your handle, `balance = 1000`, `ledger` has
   one `signup_bonus` row of `+1000` with `balance_after = 1000`, and `user_stats` has a zeroed
   row. Nothing else may have been written.
5. **Logout** via the top bar → `204`, the bar flips to "Log in / Sign up", `/api/auth/me`
   reports `authenticated: false`.
6. **Login** `/auth/login` with the same credentials → back home, same handle and balance.
7. **Handle uniqueness**: sign up a second account requesting the *same* handle → 400 with a
   `fields.handle` error. Sign up with the handle left blank → a `trader####` handle is assigned.
8. **Forgot/reset**: `/auth/forgot` → email → link lands on `/auth/reset` → set a new password →
   login with the new password works, the old one does not.
9. **Resend**: on `/auth/verify` hit "Resend the link" → a second email arrives (the built-in
   provider rate-limits to one per 60s; the 429 is shown, not swallowed).
10. **Expired/second-click link**: open the same confirmation link twice → the second click lands
    on `/auth/login` with a readable banner, not a 500.
11. **Dev fallback is really off**: with the env vars set, `curl -X POST localhost:5173/api/auth/signup
    -d '{"email":"x@y.co","password":"12345678","handle":"hijack","tos":true}'` must go through
    Supabase (check the inbox) — never mint an `nc_dev_uid` cookie.
12. **Dev mode on a fresh clone** (env vars removed): the dev panel appears, entering a handle
    mints 1,000 NC + the ledger row in the memory store, and the same handle logs you back in.

> **Email templates.** Supabase's built-in templates link with `{{ .ConfirmationURL }}`, which
> honours the `emailRedirectTo`/`redirectTo` values above. If you follow the Supabase SSR guides
> instead and build links from `{{ .TokenHash }}`, point them at
> `<site-url>/auth/confirm?token_hash={{ .TokenHash }}&type=signup` (or `type=recovery` for
> resets) — `/auth/confirm` handles both shapes. If confirmations are switched **off** in the
> Supabase dashboard, signup returns a live session and the app skips `/auth/verify` entirely.

## Supabase setup (production auth + Postgres)

Roughly five minutes. Skip it entirely for local development.

1. **Create the project** — [supabase.com](https://supabase.com) → New project. Note the
   database password and the project ref (the `abc` in `https://abc.supabase.co`).

2. **Run the migrations.** Either the Supabase CLI:

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push
   ```

   …or plain `psql` with the **direct** connection string (DDL wants a real session, not the
   pooler):

   ```bash
   psql "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
        -f supabase/migrations/0001_init.sql
   psql "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
        -f supabase/migrations/0002_handle_new_user.sql
   ```

   `0001_init.sql` creates every table from `PLAN.md` §3 with RLS enabled — reads are limited to a
   user's own rows, and **there are no client write policies at all**: every write goes through
   the server with the service role, inside a transaction. `0002_handle_new_user.sql` adds the
   `handle_new_user()` trigger that provisions a new signup with a unique handle, 1,000 NC and the
   matching `signup_bonus` ledger row.

3. **Create the tick partitions.** `cas_ticks` is declared `PARTITION BY RANGE (trade_date)` but
   the migration deliberately creates no partitions — Postgres rejects inserts into a partitioned
   table with no matching partition, so this step is not optional:

   ```bash
   export DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   npx tsx scripts/partitions.ts --months 6 --retention-days 90
   ```

   That creates monthly `cas_ticks_pYYYYMM` partitions covering today ± 6 months and drops
   partitions older than 90 days. Run it from cron (daily is fine); add `--dry-run` to preview.

4. **Copy the keys** into `.env` (never committed) — Project Settings → API:

   ```bash
   cp .env.example .env
   ```

   | variable                    | where it comes from                          | needed for                     |
   | --------------------------- | -------------------------------------------- | ------------------------------ |
   | `PUBLIC_SUPABASE_URL`       | Project Settings → API → Project URL         | browser auth client            |
   | `PUBLIC_SUPABASE_ANON_KEY`  | Project Settings → API → anon/public key     | browser auth client            |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role key    | server auth admin (bypasses RLS) |
   | `DATABASE_URL`              | Project Settings → Database → Connection string | the game store              |

5. **Connection string.** Use the **session pooler** (`:5432` on `…pooler.supabase.com`) for the
   app. If you must use the **transaction pooler** (`:6543`, PgBouncer transaction mode), nothing
   to configure — the driver detects the port and disables prepared statements — but avoid
   session-state tricks across statements. Keep the **direct** string for migrations and DDL only.

6. **Verify.** Signup should create a `profiles` row with `balance = 1000`, a `ledger` row of
   `+1000` (`balance_after = 1000`) and an empty `user_stats` row. If a handle was requested it is
   used as-is (sanitized to `^[a-z0-9_]{3,20}$`); otherwise it is generated as `trader` + 4 digits,
   retried on collision. Re-running the partition script must report nothing to do.

> **SMTP.** Supabase's built-in email provider is rate-limited and meant for development only.
> Before launch, configure a real provider (e.g. Resend's free tier) under
> Project Settings → Authentication → SMTP, or verifications will silently stall.

### Local Postgres instead of Supabase

Any Postgres 13+ works for the store — `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nifty_casino`
plus the two migrations via `psql`. Migration 0001 skips its RLS policies (they need Supabase's
`auth.uid()`) and leaves the tables closed to clients, which is the safe default; migration 0002
no-ops without `auth.users`. Local auth still needs Supabase, or a different provider in T6.

