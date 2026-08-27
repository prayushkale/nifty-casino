# NiftyCasino Implementation Plan (v2)

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** A standalone forecasting-game web app where users sign up with email, verify, and between 15:00–15:20 IST each trading day place play-money bets on how NIFTY 50, BANKNIFTY, and SENSEX will close in SEBI's Closing Auction Session (CAS) — with live CAS charts streamed from OUR server (which does the scraping, stores every tick, and fans out to all clients), automatic settlement against the official close, a full-loss miss rule, platform-wide pot counters (overall + per user), and a gamified casino-grade UI that works on desktop and mobile.

**Scale target (from Prayush):** ~10,000 DAU at launch, design for 1,00,000, survive 10,00,000. Cost-efficient first, scale-out path pre-planned, never rebuilt.

**Architecture:** SvelteKit app at `~/projects/niftycasino`. The server — not any browser — is the single scraper: one 4s poller hits NSE/BSE, writes every tick to Postgres + an in-memory hot buffer, and fans out to clients via SSE (`/api/stream`) with a REST snapshot (`/api/cas/all`) as fallback and refresh-recovery path. Postgres + auth on Supabase (free tier until scale forces upgrade — upgrade path in §8). Virtual-currency wallet (`NC` chips, 1,000 signup), bet API locked server-side by IST windows, idempotent settlement at ~15:45 IST. State is fully server-derived: any refresh, tab-switch, or next-day return rebuilds the screen from `/api/state` + tick backfill.

**Tech Stack:** SvelteKit 2 + Svelte 4 + TypeScript + TailwindCSS · Supabase (auth + Postgres + RLS) · lightweight-charts v5 · SSE for live fan-out · Redis (only from Tier 2) · Vitest · `@sveltejs/adapter-node` behind Caddy.

---

## 0. Product spec — decided defaults (v2)

| Area                              | Decision                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Participation window              | 15:00 → **15:20:00 IST cutoff**, daily. Market holidays: no session.                                                                                                  |
| Indices                           | Bet on any subset of the three (NIFTY / BANKNIFTY / SENSEX). Optional per index — casual-friendly.                                                                    |
| Currency                          | Virtual "NC" chips; **1,000 NC** signup bonus; no real money ever                                                                                                     |
| Anchor                            | Moves measured vs the **previous day's official close** (matches CAS `icChange` semantics)                                                                            |
| Bet rules                         | One active bet per index per day; freely editable until 15:20 cutoff; sufficient balance required at confirm                                                          |
| **Miss rule (v2, user-mandated)** | **Wrong direction = 100% stake lost. No consolation tier.** Only flat dead-zone refunds. See §0.2.                                                                    |
| Totals visibility (user-mandated) | Platform-wide pot (total bets, total NC staked) shown live on the game page; per-user totals on a public profile page `/u/<handle>` (balance, bets, win rate, streak) |
| Gamification (v2)                 | Streak flame (consecutive betting days), XP + rank titles, confetti on wins, live pot ticker, leaderboard — all updated at settlement time, cheap writes              |
| Resume/refresh (user-mandated)    | Server is source of truth; every screen state is reconstructible from `GET /api/state`. No client-held state is authoritative.                                        |

### 0.1 The bet ladder (unchanged from v1)

Options generated from each index's prev-close anchor, round-number deltas within ±3% CAS band, computed server-side each morning:

```
Index      | Prev close ≈          | Options offered
-----------+-----------------------+--------------------------------------------------
NIFTY      | ~25,000               | ±50, ±100, ±150, ±200 (8 options)
BANKNIFTY  | ~56,000 (+3%≈1680pts) | ±100, ±200, ±300, ±400 (8 options)
SENSEX     | ~82,000 (+3%≈2460pts) | ±150, ±250, ±400, ±500 (8 options)
```

Steps are config (`src/lib/config/ladder.ts`); generator rejects steps exceeding ±3% of prev close (CAS hard limit).

### 0.2 Payout model (v2 — strict miss = full loss)

Final move Δ = officialClose − prevClose, from exchange-settled values.

| Outcome             | Condition                                                                        | Result                                                       |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 🎯 HIT              | direction correct AND \|Δ − target\| ≤ tolerance                                 | **Multiplier × stake** (multiplier sized by step, see below) |
| ➖ FLAT (dead zone) | \|Δ\| < half the index's smallest step                                           | stake refunded 1×                                            |
| 💀 MISS             | everything else — wrong direction, or right direction but missed the target band | **0× — full stake lost**                                     |

Multipliers are per-option fixed odds (casino style), tuned by Task 15 simulation so every option's EV lands in ~[0.85, 0.95]:

```
NIFTY      ±50 → 6×   ±100 → 4.5×   ±150 → 3.8×   ±200 → 3.2×   (tol ±15pts)
BANKNIFTY  ±100 → 6×  ±200 → 4.5×   ±300 → 3.8×   ±400 → 3.2×   (tol ±30pts)
SENSEX     ±150 → 6×  ±250 → 4.5×   ±400 → 3.8×   ±500 → 3.2×   (tol ±40pts)
```

Rationale: closer targets are harder → bigger odds. The dead-zone FLAT refund is the only mercy rule (kept so a do-nothing day doesn't nuke everyone). This replaces v1's three-tier NEAR/DIRECTION ladder — user explicitly said "if miss then full loss." EV simulation (Task 15) is the tuning gate; nothing ships until every option's EV < 1.

---

## 1. Current context / reuse layer (unchanged, verified)

**CAS fetching from Market OI Analyzer (copy-adapt, do not link):**

1. **NSE (NIFTY 50, NIFTY BANK):** E1 `GET https://www.nseindia.com/api/NextApi/apiClient?functionName=getIndexData&&type=All` (literal `&&`), fields `indicativeClose`/`icChange`/`icPerChange`, populated ~15:20–15:35. E3 `/api/marketStatus` `indicativenifty50.closingValue` as cross-check. Akamai: homepage warm-up (`nse-session.ts`), browser UA, NO Cookie header, semaphore max 2 concurrent, retry-once after `resetNseSession()` on AUTH/BLOCKED.
2. **BSE SENSEX:** `GET https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexDatanew/w`, Origin+Referer bseindia.com, no cookies; `iclsprice`/`iclsChg`/`Prev_Close`; "-" → 0 via `bseNum()`.
3. **Tick handling:** `appendCasTicks` — drop non-positive, drop ts ≤ newest, cap ring buffer 720 samples (~48 min @4s).
4. **Window gating:** `isCasWindowActive()` = `[15:13:30, 15:42:00]` IST via UTC-ms arithmetic; skip hidden tabs (client side) — irrelevant server-side (always polls in window).
5. **Tick-rate reality:** 4s upstream polling is the max free rate; no true streaming feed. Server interpolates between polls client-side for a sub-4s feel (cosmetic).

**v2 change:** everything above now runs ONLY server-side. Browsers never touch NSE/BSE. Details in §2.

**Assumptions:**

- New SvelteKit app in this repo (`~/projects/nifty-casino`), not inside Market OI Analyzer.
- Supabase for auth+Postgres to start; the scale plan (§7) defines the migration triggers off free tier.
- Play-money only; "no real money; entertainment" disclaimers in footer + ToS checkbox at signup; no gambling-license imagery.
- Deployment starts on an existing EC2 VM behind Caddy; NSE-blocks-on-datacenter-IP remains THE critical risk (§6 R1).

---

## 2. Data flow: scrape → store → serve (v2 core)

```
NSE E1/E3 ─┐
           ├─► [Server poller 4s, 15:13:30–15:42 IST] ─► cas-store (hot RAM ring buffer)
BSE SENSEX ┘            │
                        ├─► INSERT cas_ticks (Postgres, partitioned by trade_date)  ← permanent record, all data stored
                        ├─► UPDATE daily_pots counters? no — pots come from bets, see §3
                        └─► SSE broadcast to connected clients (delta frames)
                                        │
Browsers ◄── SSE /api/stream ───────────┘
Browsers ◄── GET /api/cas/all?since=ts  (snapshot + backfill — used on load, reconnect, refresh)
Browsers ◄── GET /api/state             (session status, my bets, my balance, pot totals, serverNow)
```

- **One upstream cadence regardless of audience.** 10 users or 10 lakh users = same 4s NSE/BSE hit rate (Akamai-safe).
- **All scraped data persisted:** `cas_ticks(trade_date, underlying, ts, value, change_pts, change_pct)` — append-only, daily partitions, retained ≥ 1 year. `index_closes` keeps official closes. Nothing is lost if a user disappears mid-session and returns tomorrow.
- **SSE, not WebSocket, for v1 fan-out:** one-way server→client is all we need (bets go over REST); SSE survives proxies, needs no sticky sessions for reconnect (Last-Event-ID resumption), and is trivially load-balanced. WebSocket endpoint can be added later if two-way ever matters (it doesn't for this game).
- **Refresh/reconnect contract (user-mandated):**
  - Client keeps `lastEventId` + `sinceTs` in sessionStorage.
  - On any reconnect/refresh: `GET /api/cas/all?since=<sinceTs>` returns the gap ticks from the persisted store → chart rebuilds seamlessly; then SSE resumes.
  - Return-next-day: `/api/state` gives yesterday's settled outcomes + today's ladder; history page + IndexedDB cache fill the rest.
  - Battery/tab-hidden: SSE pauses client-side rendering (not the connection); on visible, one snapshot fetch re-syncs. Server connection cap: idle SSE dropped after 10 min of hidden-tab.
- **Tick backfill from DB, not just RAM:** `?since=` older than ring-buffer horizon reads `cas_ticks` — so a user who closed the tab at 15:05 and returns at 15:38 gets the full day's line.

---

## 3. Data model (Supabase Postgres)

```sql
-- profiles extends auth.users
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null,                -- public identity for leaderboards/profile pages
  email text not null,
  balance integer not null default 1000 check (balance >= 0),
  xp integer not null default 0,
  streak_days integer not null default 0,
  last_bet_date date,                         -- for streak computation at settlement
  created_at timestamptz default now()
);

create table daily_sessions (
  id serial primary key,
  trade_date date unique not null,            -- IST date
  status text check (status in ('open','locked','settling','settled')) default 'open',
  cutoff_at timestamptz not null,             -- 15:20:00 IST
  created_at timestamptz default now()
);

create table bets (
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
create index bets_session_idx on bets (session_id);
create index bets_user_created on bets (user_id, created_at desc);

-- append-only tick archive (all scraped data retained)
create table cas_ticks (
  trade_date date not null,
  underlying text not null,
  ts timestamptz not null,
  value numeric(12,2) not null,
  change_pts numeric(10,2),
  change_pct numeric(8,4),
  primary key (trade_date, underlying, ts)
) partition by range (trade_date);            -- monthly partitions; drop/archive old ones freely

create table index_closes (
  trade_date date not null,
  underlying text not null,
  close numeric(12,2) not null,
  source text not null,                       -- 'official' | 'live_approx'
  primary key (trade_date, underlying)
);

-- platform-wide money counters (user-mandated "total bets + fake money used")
-- maintained transactionally at bet write/settlement; never computed by SUM over bets at read time
create table daily_pots (
  trade_date date primary key,
  total_bets integer not null default 0,
  total_staked bigint not null default 0,
  total_paid_out bigint not null default 0,
  players_count integer not null default 0,
  updated_at timestamptz default now()
);

-- all-time aggregates for profile pages (per-user view is one row lookup, not a scan)
create table user_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bets_placed integer not null default 0,
  bets_won integer not null default 0,
  total_staked bigint not null default 0,
  total_won bigint not null default 0,
  best_payout integer not null default 0,
  updated_at timestamptz default now()
);

create table ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('signup_bonus','bet_stake','payout','refund')),
  amount integer not null,                    -- signed: stakes negative, payouts positive
  ref_bet_id uuid references bets(id),
  balance_after integer not null,
  created_at timestamptz default now()
);
create unique index ledger_payout_once on ledger (ref_bet_id) where kind = 'payout';
```

- **RLS:** users SELECT/INSERT own rows only. All money mutations go through service-role server transactions; the client can never touch settled columns or counters.
- **Counter updates are transactional with bet writes** (`UPDATE daily_pots ... ` in the same tx as the bet upsert) — cheap row updates, exact at any scale, no expensive aggregates.
- **Wallet invariant:** stake deducts immediately at placement; edits/cancels are ledger entries (refund + re-stake), never mutations. `SELECT ... FOR UPDATE` on the profile row serializes concurrent ops.

---

## 4. UI layout plan (user-mandated deliverable)

Design language: dark casino-floor aesthetic — near-black zinc background, neon amber/gold accents for money, emerald/red for up/down, big numeric displays, chip-stack motifs. Every screen has three fixed anchors: **balance chip (top-right), live pot ticker (top bar), bottom nav (mobile only)**.

### Desktop (≥1024px) — game page `/`

```
┌──────────────────────────────────────────────────────────────────────┐
│ NiftyCasino logo   ⏱ Cutoff 15:20:00   🪙 POT: 4,82,150 NC · 3,214 bets   [balance: 1,000 NC] [avatar] │
├──────────────────────────────────────────────────────────────────────┤
│  STREAK 🔥 5 days   ·   Rank: High Roller (L7)   ·   XP bar          │
├───────────────────────────────┬──────────────────────────────────────┤
│  NIFTY 50      25,012 ▲+12    │  BANKNIFTY     56,240 ▼−80           │
│  [ladder chips ±50…±200]      │  [ladder chips ±100…±400]            │
│  stake [____] [10][50][100]   │  stake [____] [quick chips]          │
│  [PLACE BET] (modal confirm)  │  [PLACE BET]                         │
├───────────────────────────────┼──────────────────────────────────────┤
│  SENSEX        82,110 ▲+45    │  YOUR BETS TODAY (strip: 3 legs or   │
│  [ladder chips] [stake]       │  empty-state "place your first bet") │
│  [PLACE BET]                  │  projected payout if-close-now       │
├───────────────────────────────┴──────────────────────────────────────┤
│  LIVE CHARTS (auction mode 15:13:30+) — 3 wide cards, target lines   │
│  drawn on-chart, payout-preview strip under each                     │
├──────────────────────────────────────────────────────────────────────┤
│ footer: disclaimers · leaderboard · history · rules                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Mobile (<768px) — same page, vertical

```
┌──────────────────────────┐
│ logo      🪙 1,000 NC    │  ← sticky top bar, pot ticker scrolling beneath
│ ⏱ 00:04:31 to cutoff     │  ← always-visible countdown pill
├──────────────────────────┤
│ [NIFTY card — full width]│  ← one index card per screen-section,
│  chips → stake → BET     │     accordion-collapse others while betting
├──────────────────────────┤
│ [BANKNIFTY card]         │
├──────────────────────────┤
│ [SENSEX card]            │
├──────────────────────────┤
│ Your bets (swipe strip)  │
├──────────────────────────┤
│ 🎰 Game  🏆 Board  👤 Me │  ← fixed bottom nav (3 tabs)
└──────────────────────────┘
```

Auction mode (both breakpoints): cards collapse into charts; charts stack full-width on mobile; each chart carries its dashed target lines + "if closed now: 💀 MISS −100" strip. Confirmation modal + result reveal (confetti on HIT) are shared components.

Other screens: `/leaderboard` (top balances, today's best calls), `/history` (own bet log), `/u/<handle>` (public per-user page: balance, streak, win rate, recent bets — user-mandated per-user view), `/auth/*`.

Mobile-first rules: all tap targets ≥44px; stake entry uses numeric keypad pattern; charts render ≥320px wide (lightweight-charts handles this); countdown + balance persist in sticky bars on every screen.

---

## 5. Step-by-step plan

> Each task sized for one subagent dispatch. Loop: failing test → implement → green → commit.

### Task 1: Scaffold app + shared config

SvelteKit TS skeleton (adapter-node, Tailwind, Vitest, ESLint/Prettier). `src/lib/config/app.ts`:

```typescript
export const APP_TIMEZONE_OFFSET_MIN = 330; // IST = UTC+5:30, no DST
export const CUTOFF_HMS = { h: 15, m: 20, s: 0 };
export const AUCTION_START_HMS = { h: 15, m: 13, s: 30 };
export const AUCTION_END_HMS = { h: 15, m: 42, s: 0 };
export const SIGNUP_BONUS = 1000;
export const POLL_MS = 4000;
export const SSE_IDLE_TIMEOUT_MS = 10 * 60_000;
```

`src/lib/time/ist.ts` pure helpers (`istDateStr`, `secOfDayIst`, `isBetweenHMS`, `isWeekend`) per v1 design. Verify: dev renders, vitest passes, git init + commit.

### Task 2: Time/window logic TDD

`src/lib/time/ist.test.ts`: boundary inclusivity, auction window, weekend, IST-vs-UTC edges. Green → commit.

### Task 3: Port CAS fetch layer (server-side only)

Copy-adapt `nse-session.ts`, `nse-api.ts` (trimmed to E1+E3), `bse-api.ts`, types + extractors. Routes `/api/nse/cas`, `/api/bse/cas`, `/api/nse/health` — **all server-only, never exposed raw to clients**. Expose normalized `CasTickPayload`. Parser tests from M.OI fixtures. Commit.

### Task 4: Tick store — RAM ring buffer + Postgres archive

`src/lib/server/cas-store.ts` (hot ring buffer, cap 720) + `cas_ticks` writes (batched insert every poll; partition management script). Server poller started from `hooks.server.ts`. SSE endpoint `/api/stream` with Last-Event-ID resume + heartbeat every 15s; snapshot endpoint `/api/cas/all?since=` reading RAM first, `cas_ticks` for older. Tests: stale-skip, cap-trim, since-cursor math, backfill-from-DB path. Commit.

### Task 5: Supabase project + schema migration (§3)

Manual: create project, keys in `.env` (never committed), `.env.example` provided. Run migrations 0001 schema, 0002 `handle_new_user()` trigger (profile + 1,000 NC + signup ledger row). `supabaseAdmin.ts` (service role, server files only) + `supabaseBrowser.ts`. SMTP note: built-in provider rate-limits; configure Resend free tier for production before launch. Commit `.env.example` + README setup.

### Task 6: Auth flows + handles

Signup (email+handle), verify (OTP link), login/logout/forgot/reset pages. Handle uniqueness enforced; auto-generated handle `trader<4rand>` if skipped. Manual verification checklist in README. Commit.

### Task 7: Bet placement API — the money path (heavy tests)

`src/lib/server/bets.ts` `placeBet`/`editBet`/`cancelBet` in one transaction each:

1. Session `status='open'` AND `now < cutoff_at` (both checked).
2. `(targetKind, deltaPoints)` must exist in today's ladder; `odds` copied from ladder, not client.
3. Balance check with `SELECT ... FOR UPDATE`.
4. Edit = refund ledger + new stake ledger; cancel = full refund (pre-cutoff only).
5. Same transaction updates `daily_pots` (total_bets, total_staked, players_count) and `user_stats` (bets_placed, total_staked).

Routes `POST /api/bets`, `DELETE /api/bets/:id`. In-memory db-interface stub tests: cutoff boundary, insufficient funds, invalid target, edit-refund math, idempotent double-submit, counter consistency. Commit.

### Task 8: Ladder generation + odds table

Per v1 §0.2/0.1 + v2 §0.2 odds column. `generateLadder(prevCloses)` with ±3% clamp; odds from config, validated by Task 15 simulation before launch. Tests: clamp, carryover across weekends/holidays, odds round-trip. Commit.

### Task 9: Official-close capture + settlement engine (TDD-heavy)

`src/lib/server/settle.ts`:

- `captureOfficialCloses(date)` ~15:43 (with post-15:42 re-check loop for auction extensions; never fires blindly).
- `settleSession(date)`: per bet `Δ = close(today) − prevClose` → `computeTier(bet, prevClose, close, cfg)` → `'hit'|'flat'|'miss'` → payout = `hit ? stake × odds : flat ? stake : 0`; one transaction credits wallets, writes ledger (partial-unique index blocks double-pay), marks bets settled, updates `daily_pots.total_paid_out`, `user_stats` (bets_won, total_won, best_payout), XP (+10/bet, +100/hit), streak (`last_bet_date` continuity), session → `'settled'`. Idempotent re-runs.
- `computeTier` pure tests: exact hit, tolerance band edges, dead-zone flat, wrong-direction miss = full loss, prev=0 guard. Commit.

### Task 10: Totals endpoints + profile pages (user-mandated)

- `GET /api/pot` → today's `daily_pots` row (+ yesterday's for comparison). Rendered in the always-on pot ticker.
- `/u/<handle>` public profile: user_stats + streak + recent settled bets + rank title. Private data (email) never exposed.
- `/api/state` consolidated load payload: session status, my bets, my balance, my stats, pot, ladder, `serverNow`. This is THE refresh-recovery payload — one request rebuilds any screen. Commit.

### Task 11: Game page — pre-auction betting UI

Per §4 desktop/mobile layout. Server-load from `/api/state`; `serverNow` drift-corrected countdown; confirmation modal with miss-warning copy ("wrong call = stake lost"). Read-only states outside window. Commit.

### Task 12: Auction mode — live charts + SSE client

Port `CasChart.svelte` (dedupe, incremental update, #f8fafc/#1e293b tooltip). Client SSE subscription + snapshot-first hydration (`/api/cas/all?since=sessionStart` then SSE deltas) — this IS the refresh handling. Target price-lines overlaid; payout-preview strip via `computeTier`; connection/staleness banner; post-auction freeze + 30s settle-poll. Mobile: charts stack full-width. Commit.

### Task 13: Gamification layer

Streak flame + XP bar + rank titles (titles from XP thresholds, config); confetti on HIT reveal (canvas-confetti dep); pot ticker with rolling number animation; empty/loading skeletons; toasts; countdown-to-next-session widget; dark casino theme (§4 palette). All settlement-side writes, zero extra runtime cost. Commit.

### Task 14: Leaderboard + history pages

`/leaderboard`: top balance (all-time/weekly), today's biggest wins, longest streaks — all read from `user_stats`/`profiles` (indexed), cap 100, cache 30s. `/history`: own bets with outcomes. Commit.

### Task 15: House-edge simulation & tuning (launch gate)

`scripts/simulate-ev.ts` Monte Carlo over plausible move distributions → per-option EV; tune odds/tolerances/dead-zone until all EVs ∈ [0.85, 0.95]; write provenance comments into ladder config. **Blocker: no launch until green.** Commit.

### Task 16: Deploy + cost-tiered hosting (see §7 for the full ladder)

- Tier 1 launch shape: app on EC2 (t3.small or the existing VM), Supabase free, Caddy TLS. systemd unit + EnvironmentFile.
- **Critical pre-deploy spike:** NSE/BSE from a datacenter IP may 403 (residential-Mac privilege). Spike FIRST (Task 3.5): curl from the target VM; if blocked → residential relay agent on the always-on Mac or home-hosted app behind Cloudflare Tunnel. Decide before Task 16, not after.
- Watchdog cron on `/api/nse/health`. Commit infra files + `docs/RUNBOOK.md` (restarts, blocked-feed triage, manual settle, stuck-session force, scale-tier promotion checklist).

### Task 17: Smoke-test + load-test scripts

`scripts/dry-run-day.ts` (fake day: bets → settle → balance arc → re-settle no-op). `scripts/load-sim.ts` — k6 or a plain Node script: N virtual clients hitting `/api/state` + `/api/cas/all` + opening SSE; verify p95 latency and fan-out cost at 10k simulated conns. Commit.

---

## 6. Risks, tradeoffs, open questions

**Risks**

1. **NSE/BSE blocking datacenter IPs** (highest). Mitigations: home-Mac relay agent, Cloudflare-Tunnel home hosting, or paid feed (Dhan exposes live index LTP but CAS indicatives unverified — needs spike). Decide via Task 3.5 spike.
2. **CAS timing drift / auction extensions** — settle job re-checks, never blind-fires; idempotent.
3. **Clock skew** — cutoff by server clock; clients render from `serverNow`.
4. **Wallet concurrency** — FOR UPDATE + exhaustive service-layer tests; ledger append-only.
5. **SSE at scale** — Tier 1 fine in-process; Tier 2+ moves to Redis pub/sub fan-out; Tier 3 falls back to CDN-cached 4s polling (Cloudflare caches `/api/cas/all` per second-bucket), which scales to lakhs of users with near-zero origin cost.
6. **Casino branding legality** — play-money disclaimers, ToS checkbox, no license imagery, no SEBI claims.
7. **Settlement burst** — 10 lakh users × 3 bets = 30 lakh rows settled once daily; batched transaction chunks (5k bets/tx) keep it under a minute on Tier 2 hardware.

**Scale tiers (cost-efficiency plan, user-mandated):**

| Tier           | Users/day | Infra                                                                                                                                | ~Monthly cost                   |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1 — launch     | 10k       | 1× EC2 t3.small (or existing VM) + Supabase FREE + Caddy                                                                             | ~$15–20 (EC2 only; Supabase ₹0) |
| 2 — growth     | 1 lakh    | 2× app nodes behind ALB/Cloudflare + Supabase Pro ($25) + Redis (Upstash free/low tier) + Cloudflare free CDN                        | ~$60–80                         |
| 3 — worst case | 10 lakh   | 4–6 app nodes + Supabase→ self-hosted Postgres on 2× EC2 (or Supabase scale tier) + Redis + Cloudflare cached polling instead of SSE | ~$250–400                       |

Key cost decisions baked in: Cloudflare in front of everything from day 1 (free TLS/CDN/DDoS); SSE (not WS) so no sticky-session infrastructure; counters precomputed (no aggregate queries); tick archive on cheap Postgres partitions with 90-day retention policy; zero paid third-party services until Tier 3.

**Open questions for Prayush**

1. Deployment reality for the feed: EC2 + relay vs home-hosted? (Task 3.5 spike answers this empirically.) Is there a domain?
2. Ladder steps/odds: static config (v1 assumption) or volatility-derived? v2 ships static + simulator-tuned.
3. Referral bonuses — v2 roadmap?
4. Admin UI for balance adjustments — API escape hatch only in v1; full admin page v2?
5. Sub-4s chart interpolation — cosmetic smoothing in v1 Task 12, yes/no?

---

## 7. Testing & validation strategy

- Pure functions TDD-first: `ist.ts`, `ladder.ts`, `computeTier`, tick append/dedupe/since-cursor, ledger + counter math.
- Service-layer state machine tests against in-memory db-interface (bets, settlement, idempotency).
- `dry-run-day.ts` end-to-end balance arc; `load-sim.ts` fan-out check.
- Auth flows manual checklist (README).
- Gates per task: `npm run check && npm run lint && npm run test && npm run build`.

## 8. Verification checklist (launch gate)

- [ ] Signup → verify → 1,000 NC + ledger row; handle assigned
- [ ] Place/edit/cancel all 3 indices pre-cutoff; rejected at 15:20:01; pot counters match placed bets exactly
- [ ] Real CAS window: all charts tick ≤8s fresh via SSE; kill network mid-auction → refresh → chart backfills seamlessly from `?since=` (user-mandated refresh test)
- [ ] Miss = 0 credited, stake gone; HIT pays stake×odds; FLAT dead-zone refunds; re-settle is a no-op
- [ ] Pot ticker (total bets + NC staked) matches DB aggregates; `/u/<handle>` shows correct per-user totals
- [ ] Settlement credits consistent: sum(ledger) == balance − 1000 for sampled users
- [ ] Leaderboards + streaks + XP update at settlement
- [ ] Load sim: 10k concurrent SSE + snapshot p95 < 500ms on Tier 1 hardware
- [ ] Production feed unblocked (or relay active); watchdog alerting works
- [ ] Mobile layout verified at 360px width; all interactions thumb-reachable
