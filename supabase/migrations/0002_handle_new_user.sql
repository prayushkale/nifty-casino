-- =============================================================================
-- 0002_handle_new_user.sql — provision a wallet the instant a user signs up.
--
-- AFTER INSERT on auth.users → creates, in one shot:
--   • profiles row   (handle, email, balance = 1000 NC)
--   • ledger row     (signup_bonus, +1000, balance_after = 1000) — so sum(ledger) ==
--                      balance - 1000 holds from the very first row (PLAN §8 gate)
--   • user_stats row (zeroed)
--
-- The trigger is SECURITY DEFINER (owned by postgres, which owns the tables and so
-- bypasses RLS): 0001_init.sql grants clients no INSERT on public.profiles, so this is
-- the only path that can create a profile.
--
-- Runs on Supabase only — it triggers off auth.users. On a vanilla Postgres the whole
-- file no-ops with a notice rather than failing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The signup bonus. Single source of truth inside SQL, referenced by both the
-- profiles.balance default-ish insert and the ledger row so the two can never drift.
--   ⚠ KEEP IN SYNC with SIGNUP_BONUS = 1000 in src/lib/config/app.ts — change both
--     together or new signups and the app will disagree about a starting wallet.
-- -----------------------------------------------------------------------------
create or replace function public.nc_signup_bonus()
returns integer
language sql
immutable
as $$
  select 1000;  -- = SIGNUP_BONUS in src/lib/config/app.ts
$$;

-- -----------------------------------------------------------------------------
-- Handle sanitizer: lowercase, /^[a-z0-9_]{3,20}$/ or NULL.
-- Returns NULL for anything unusable (absent, wrong shape, too long) so the caller
-- falls through to a generated handle instead of storing junk in a public URL.
-- -----------------------------------------------------------------------------
create or replace function public.sanitize_nc_handle(raw text)
returns text
language sql
immutable
as $$
  select case
    when lower(btrim(coalesce(raw, ''))) ~ '^[a-z0-9_]{3,20}$'
      then lower(btrim(coalesce(raw, '')))
  end;
$$;

-- -----------------------------------------------------------------------------
-- The trigger body. Exception-safe by contract: a failure here must never block the
-- auth.users insert, or nobody can sign up at all.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''        -- pg_catalog stays implicit; everything else is qualified
as $$
declare
  desired      text;
  candidate    text;
  attempt      int;
  created      boolean := false;
  signup_bonus constant integer := public.nc_signup_bonus();
begin
  -- Already provisioned (manual backfill, or the trigger re-fired) → idempotent no-op.
  if exists (select 1 from public.profiles where user_id = new.id) then
    return new;
  end if;

  desired := public.sanitize_nc_handle(new.raw_user_meta_data ->> 'handle');

  -- 6 attempts: the requested handle, 4 generated, then a deterministic last resort.
  -- Attempts 2-5 can collide under concurrent signups; the unique index decides, and
  -- the loop simply picks another name — the caller never sees an error.
  for attempt in 1 .. 6 loop
    candidate :=
      case
        when attempt = 1 and desired is not null then desired
        when attempt <= 5 then 'trader' || lpad((floor(random() * 10000))::int::text, 4, '0')
        else 'trader_' || left(md5(new.id::text), 10)   -- derived from the uuid: unique
      end;

    begin
      insert into public.profiles (user_id, handle, email, balance)
      values (new.id, candidate, lower(coalesce(new.email, '')), signup_bonus);
      created := true;
      exit;
    exception
      -- profiles_handle_key: that handle is taken → try the next name.
      when unique_violation then
        created := false;
    end;
  end loop;

  if not created then
    raise warning 'handle_new_user: no free handle for user % after 6 attempts', new.id;
    return new;
  end if;

  insert into public.ledger (user_id, kind, amount, ref_bet_id, balance_after)
  values (new.id, 'signup_bonus', signup_bonus, null, signup_bonus);

  insert into public.user_stats (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
exception
  when others then
    -- A broken wallet must never stop someone signing up. Logged loudly, repairable by
    -- hand — see README "Verification checklist".
    raise warning 'handle_new_user failed for % (%): %', new.id, sqlstate, sqlerrm;
    return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Wire the trigger. Supabase's own docs use this name; keep it recognisable.
-- -----------------------------------------------------------------------------
do $trigger$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users not found — not a Supabase project. Skipping the handle_new_user trigger.';
    return;
  end if;

  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

  -- The trigger fires on the server's own insert; nobody needs to call the function,
  -- and Supabase grants EXECUTE on public functions to anon/authenticated by default.
  if to_regrole('anon') is not null and to_regrole('authenticated') is not null then
    revoke execute on function public.handle_new_user() from anon, authenticated;
    revoke execute on function public.sanitize_nc_handle(text) from anon, authenticated;
  end if;
end
$trigger$;
