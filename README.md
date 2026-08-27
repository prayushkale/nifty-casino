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

