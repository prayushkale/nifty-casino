-- =============================================================================
-- 0001_init.sql — the full game schema (PLAN.md §3) + Row Level Security.
--
-- Run with EITHER:
--     supabase db push                        (recommended; tracks applied files)
--     psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
--
-- Everything below is the data model from PLAN.md §3 exactly: same tables, same
-- columns, same CHECK constraints, same indexes, same `partition by range` on
-- cas_ticks. Two deliberate additions, both marked inline:
--   • `if not exists` / `drop policy if exists`, so the file is safe to re-run by hand
--   • RLS, which PLAN §3 requires ("users SELECT own rows; all money mutations through
--     the service role")
--
-- ⚠ cas_ticks is DECLARED partitioned here but has NO partitions. Postgres refuses
--   inserts into a partitioned table with no matching partition, so after this
--   migration runs you must create them:
--       npx tsx scripts/partitions.ts --months 6 --retention-days 90
--   They are deliberately NOT in this migration: the range to pre-create and the
--   retention window are deployment decisions, not schema (see scripts/partitions.ts).
--
-- Portability: the RLS *policies* need Supabase's `auth.uid()`. When that function is
-- absent (vanilla Postgres) the policy block is skipped with a notice instead of
-- failing — RLS is still enabled, so the tables are closed to clients either way and
-- the service role keeps writing. The tables themselves are plain Postgres EXCEPT the
-- foreign keys to auth.users(id), which only exist on Supabase.
-- =============================================================================

-- gen_random_uuid() is built in from PG13; Supabase ships pgcrypto regardless.
-- Guarded so this file also runs on an older vanilla Postgres.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- profiles — extends auth.users; `balance` is the wallet in integer NC chips.
-- -----------------------------------------------------------------------------
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null,                -- public identity for leaderboards/profile pages
  email text not null,
  balance integer not null default 1000 check (balance >= 0),
  xp integer not null default 0,
  streak_days integer not null default 0,
  last_bet_date date,                         -- for streak computation at settlement
  created_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- daily_sessions — one row per IST trading day; the game's state machine.
-- -----------------------------------------------------------------------------
create table if not exists daily_sessions (
  id serial primary key,
  trade_date date unique not null,            -- IST date
  status text check (status in ('open','locked','settling','settled')) default 'open',
  cutoff_at timestamptz not null,             -- 15:20:00 IST
  created_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- bets — one active bet per (user, session, underlying); odds frozen at placement.
-- -----------------------------------------------------------------------------
create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  session_id int not null references daily_sessions(id),
  underlying text not null check (underlying in ('nifty','banknifty','sensex')),
  target_kind text not null check (target_kind in ('up','down')),
  delta_points numeric(10,2) not null,
  odds numeric(5,2) not null,                 -- multiplier copied at bet time (history-proof)
  stake integer not null check (stake > 0),
  settlement_tier text check (settlement_tier in ('hit','flat','miss')),
  payout integer,
  settled_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, session_id, underlying)
);
create index if not exists bets_session_idx on bets (session_id);
create index if not exists bets_user_created on bets (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- cas_ticks — append-only tick archive (all scraped data retained).
-- DECLARED partitioned by month; see scripts/partitions.ts for the child tables.
-- -----------------------------------------------------------------------------
create table if not exists cas_ticks (
  trade_date date not null,
  underlying text not null,
  ts timestamptz not null,
  value numeric(12,2) not null,
  change_pts numeric(10,2),
  change_pct numeric(8,4),
  primary key (trade_date, underlying, ts)
) partition by range (trade_date);            -- monthly partitions; drop/archive old ones freely

-- -----------------------------------------------------------------------------
-- index_closes — official (or live-approximate) closes; the settlement anchor.
-- `close` is not a reserved word in Postgres, so it stays unquoted as in the plan.
-- -----------------------------------------------------------------------------
create table if not exists index_closes (
  trade_date date not null,
  underlying text not null,
  close numeric(12,2) not null,
  source text not null,                       -- 'official' | 'live_approx'
  primary key (trade_date, underlying)
);

-- -----------------------------------------------------------------------------
-- daily_pots — platform-wide money counters ("total bets + fake money used").
-- Maintained transactionally at bet write/settlement; NEVER computed by SUM over
-- bets at read time (PLAN §3). Kept exact by the same transaction as the bet.
-- -----------------------------------------------------------------------------
create table if not exists daily_pots (
  trade_date date primary key,
  total_bets integer not null default 0,
  total_staked bigint not null default 0,
  total_paid_out bigint not null default 0,
  players_count integer not null default 0,
  updated_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- user_stats — all-time aggregates; a profile page is one row lookup, not a scan.
-- -----------------------------------------------------------------------------
create table if not exists user_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bets_placed integer not null default 0,
  bets_won integer not null default 0,
  total_staked bigint not null default 0,
  total_won bigint not null default 0,
  best_payout integer not null default 0,
  updated_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- ledger — append-only, signed money movements. sum(amount) per user == balance-1000,
-- which is the launch-gate check in PLAN §8.
-- -----------------------------------------------------------------------------
create table if not exists ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('signup_bonus','bet_stake','payout','refund')),
  amount integer not null,                    -- signed: stakes negative, payouts positive
  ref_bet_id uuid references bets(id),
  balance_after integer not null,
  created_at timestamptz default now()
);

-- Settlement's idempotency guard: a bet can be paid out exactly once. Re-running
-- settleSession hits this index and is a no-op, not a double credit.
create unique index if not exists ledger_payout_once
  on ledger (ref_bet_id) where kind = 'payout';

-- NOT in PLAN §3 — added: the history/receipt view reads `where user_id = ? order by
-- id desc`, which without this index is a seq scan over an append-only table that
-- grows by every stake and every payout.
create index if not exists ledger_user_id_id_idx on ledger (user_id, id desc);

-- =============================================================================
-- Row Level Security
--
-- READS  (client-facing, per PLAN §3 "users SELECT own rows"):
--   profiles / bets / user_stats / ledger → own rows only (auth.uid() = user_id)
--   daily_sessions / daily_pots / index_closes / cas_ticks → any authenticated user
--     (session state, the pot ticker, ladder anchors and chart backfill are shared,
--     non-personal data)
--
-- WRITES: there are deliberately NO insert/update/delete policies on ANY table.
--   With RLS enabled, no policy means denied, so anon/authenticated cannot write a
--   single row — not a balance, not a settlement_tier, not a counter — even with a
--   hand-rolled request. Every write goes through the server using the service role
--   key (bypasses RLS), inside the transactions in src/lib/server/db/postgres.ts.
--   The revokes below are belt-and-braces on top of that default-deny.
--
--   The one exception that looks like a client write but isn't: profile creation on
--   signup happens inside the SECURITY DEFINER trigger (0002_handle_new_user.sql),
--   which runs as its owner and therefore bypasses RLS.
-- =============================================================================
alter table profiles      enable row level security;
alter table daily_sessions enable row level security;
alter table bets          enable row level security;
alter table cas_ticks     enable row level security;
alter table index_closes  enable row level security;
alter table daily_pots    enable row level security;
alter table user_stats    enable row level security;
alter table ledger        enable row level security;

do $rls$
begin
  -- Supabase-only surface. On a vanilla Postgres (no auth schema) the tables above are
  -- still RLS-enabled with zero policies → fully closed, which is the safe default.
  if to_regproc('auth.uid') is null then
    raise notice 'auth.uid() not found — not a Supabase project. RLS enabled with no policies (all client access denied). Skipping the SELECT policies and role grants.';
    return;
  end if;

  -- own rows -------------------------------------------------------------------
  drop policy if exists profiles_select_own on public.profiles;
  create policy profiles_select_own on public.profiles
    for select to authenticated using (auth.uid() = user_id);

  drop policy if exists bets_select_own on public.bets;
  create policy bets_select_own on public.bets
    for select to authenticated using (auth.uid() = user_id);

  drop policy if exists user_stats_select_own on public.user_stats;
  create policy user_stats_select_own on public.user_stats
    for select to authenticated using (auth.uid() = user_id);

  -- a user's own wallet audit trail (receipts/history); writes stay service-role only
  drop policy if exists ledger_select_own on public.ledger;
  create policy ledger_select_own on public.ledger
    for select to authenticated using (auth.uid() = user_id);

  -- shared, non-personal game state --------------------------------------------
  drop policy if exists daily_sessions_select_authenticated on public.daily_sessions;
  create policy daily_sessions_select_authenticated on public.daily_sessions
    for select to authenticated using (true);

  drop policy if exists daily_pots_select_authenticated on public.daily_pots;
  create policy daily_pots_select_authenticated on public.daily_pots
    for select to authenticated using (true);

  drop policy if exists index_closes_select_authenticated on public.index_closes;
  create policy index_closes_select_authenticated on public.index_closes
    for select to authenticated using (true);

  drop policy if exists cas_ticks_select_authenticated on public.cas_ticks;
  create policy cas_ticks_select_authenticated on public.cas_ticks
    for select to authenticated using (true);

  -- Explicit privilege revocation. Supabase grants ALL on public tables to
  -- anon/authenticated by default; RLS already blocks writes, and this removes the
  -- privilege itself so no future policy can accidentally expose one.
  if to_regrole('anon') is not null and to_regrole('authenticated') is not null then
    revoke insert, update, delete, truncate on
      public.profiles, public.daily_sessions, public.bets, public.cas_ticks,
      public.index_closes, public.daily_pots, public.user_stats, public.ledger
      from anon, authenticated;
  end if;
end
$rls$;

-- -----------------------------------------------------------------------------
-- Loud warning when the tick archive has nowhere to put today's ticks.
-- -----------------------------------------------------------------------------
do $partitions$
begin
  if not exists (
    select 1 from pg_inherits where inhparent = to_regclass('public.cas_ticks')
  ) then
    raise warning 'cas_ticks has no partitions yet — INSERTs will fail with "no partition of relation found". Run: npx tsx scripts/partitions.ts --months 6 --retention-days 90';
  end if;
end
$partitions$;
