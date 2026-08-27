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

