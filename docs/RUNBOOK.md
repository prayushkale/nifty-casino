# NiftyCasino RUNBOOK

The operational brain. If you are awake at 15:15 IST and something looks wrong, start
at [§2 the daily loop](#2-the-daily-loop-what-runs-when), then [§4 R1 triage](#4-blocked-feed-triage-r1--the-critical-one).

| file                                      | what it is                                          |
| ----------------------------------------- | --------------------------------------------------- |
| `deploy/install.md`                       | first-time bring-up (Tier 1)                        |
| `deploy/Caddyfile`                        | TLS + SSE-safe proxy + security headers             |
| `deploy/niftycasino.service`              | the app under systemd                               |
| `deploy/niftycasino.env.example`          | every env var, with where it comes from             |
| `deploy/watchdog.{sh,service,timer}`      | feed watchdog, every 5 min                          |
| `scripts/settle-manual.ts`                | manual settle (§5)                                  |
| `scripts/session-admin.ts`                | stuck-session force (§6)                            |
| `scripts/partitions.ts`                   | monthly `cas_ticks` partitions + retention          |

---

## 1. The one-page mental model

```
NSE E1/E3 ─┐
           ├─ [cas-poller, 4s, 15:13:30–15:42 IST] ─► cas-store (RAM ring buffer)
BSE SENSEX ┘            │                                     │
                        ├─► cas_ticks (Postgres, monthly partitions)      │
                        └─► SSE /api/stream  ◄────────────────────────────┘
                                    │            (REST /api/cas/all is the fallback)
bets 15:00–15:20 IST ─► bets/daily_pots/ledger (one tx each, service-role)
15:43–17:00 IST ─► capture official closes ─► settleSession (idempotent, chunked)
```

Three invariants to keep in your head while operating this:

1. **The server is the only scraper and the only writer of money.** Browsers never touch
   NSE/BSE; no client can write a settled column or a counter. So "the data is wrong"
   is always a server-side question.
2. **Never settle on a guess.** A missing official close leaves the day unsettled, the
   session `open`, and the bets unpaid. An unsettled day is visible and fixable; a
   wrongly-settled day is neither. That is why §5–§6 exist and why they are fussy.
3. **One egress IP per feed.** The poller, the settle capture, the health probe and any
   relay must all look like the same caller to Akamai. Mixed IPs is how you get blocked
   (see §4).

## 2. The daily loop — what runs when

All times IST (UTC+5:30, no DST). Weekends: nothing runs, no session, no settle.

| IST time       | what happens                                                                 | where to look                                    |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| 15:00:00       | betting opens (`BETTING_START_HMS`) — ladder is served from the prev close    | `GET /api/state`, `[db]` log                     |
| 15:13:30       | auction window opens — **the poller wakes** and hits NSE E1 + BSE every 4s    | `[cas-poller] window open (<date>)`              |
| 15:13:30+      | charts switch to live auction mode; clients ride SSE                          | `/api/stream` frames, `[cas-poller] polled N`    |
| 15:20:00       | **cutoff** — bets rejected from 15:20:01 (`CutoffPassedError` → 409/422)      | `[db]`, `POST /api/bets`                         |
| 15:42:00       | auction nominal end — poller stops, `cas_ticks` for the day is complete       | `[cas-poller] window closed`                     |
| 15:43:00       | **settle window opens** — capture official closes, then settle when all 3 are in | `[settle] <date>: official closes not ready…` |
| 15:43–17:00    | re-check every 60s until every close lands; then settle in 5k-bet chunks      | `[settle] … status=settled`                      |
| 17:00:00       | window closes. A day still unsettled is **given up on loudly** and left `open` | `[settle] GIVING UP on <date>`                  |
| 17:00 → 15:00  | idle. Poller re-checks every 30s, settle every 30s. No upstream traffic.       | nothing — silence is correct                     |
| every 5 min    | watchdog probes `/api/nse/health`                                             | `/var/log/niftycasino/watchdog.log`              |
| 1st of month   | `scripts/partitions.ts` creates/drops `cas_ticks` partitions                   | `/var/log/niftycasino/partitions.log`            |

### Where the logs are and what the tags mean

```bash
journalctl -u niftycasino -f                     # live
journalctl -u niftycasino --since '15:00' --until '18:00'
journalctl -u niftycasino -g '\[settle\]' -n 200  # grep by tag
tail -f /var/log/niftycasino/watchdog.log        # the feed watchdog
```

| tag                | who                             | normal line                                      | failure meaning                                                                                                   |
| ------------------ | ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `[db]`             | the store driver pick           | `driver=postgres postgres://…***`                | `driver=memory` at boot = **DATABASE_URL did not reach the process** — bets will be lost on the next restart. Fix now. |
| `[cas-poller]`     | the 4s scraper loop             | `polled 3 payload(s), kept 3, persisted 3`       | `NSE E1 failed: BLOCKED/AUTH` = R1 (§4). `cas_ticks insert failed` = DB/partition problem — the tick is still in RAM, the archive retries in 4s. `prev-close anchor write failed` = the ladder/settle anchor is missing → check `index_closes`. |
| `[settle]`         | the 15:43–17:00 settle loop     | `<date>: status=settled` (via `settle-manual`)   | `official closes not ready (nifty…)` every 60s is *normal until 16:00* and a problem after. `GIVING UP on <date>` = nobody settled today: run §5. |
| `[settle-manual]`  | `scripts/settle-manual.ts`      | `status=settled settled=N paidOut=M`             | `INCOMPLETE` = some close was unusable; nothing was paid for those bets. Fix the feed and re-run.                   |
| `[session-admin]`  | `scripts/session-admin.ts`      | `FORCING <date> … settling → open`               | `the write did not land` = the row moved first; re-read before doing anything else.                                 |

Also worth grepping for once a day in season: `grep -c 'GIVING UP'`, `grep -c 'INCOMPLETE'`,
`grep 'BLOCKED\|AUTH'` (more than a couple outside 15:13–15:42 means Akamai is warming to your IP).

## 3. Restart / upgrade (zero-drama)

In-flight bets are rows in Postgres, and SSE clients reconnect on their own with
`Last-Event-ID` resumption — so a restart costs one 4s poll, not a lost bet.

```bash
cd /opt/niftycasino
sudo -u niftycasino git pull --ff-only
sudo -u niftycasino npm ci --include=dev
sudo -u niftycasino npm run build
sudo -u niftycasino npm run sim:ev -- --quiet      # launch gate; never skip before a season
sudo systemctl restart niftycasino
journalctl -u niftycasino -n 30 --no-pager          # look for driver=postgres + both schedulers
```

Rules of thumb:

- **Never restart between 15:40 and 17:10 IST unless the site is down.** The settle
  engine is idempotent and restarts are safe, but a restart mid-window burns a 60s
  re-check and you do not want to be reading logs while the closes are landing.
- Restarting is safe at 15:30 (mid-auction): the first poll fires immediately on boot
  (`startCasPoller` schedules a cycle at delay 0), and the ring buffer refills in 4s.
- `SHUTDOWN_TIMEOUT=30` (adapter) + `TimeoutStopSec=45` (unit) means a restart drains
  SSE clients for up to 30s. If you need it *gone now*: `systemctl kill -s SIGKILL` —
  the store is Postgres, nothing is lost.
- Schema changes: run the migration **before** the deploy, since the old process must
  tolerate the new tables/columns (additive migrations only).
- Check `systemctl --failed` after any restart; a red watchdog unit is information.

## 4. Blocked-feed triage (R1) — THE critical one

**R1:** NSE and BSE front their public APIs with Akamai, which scores the *calling IP*.
A residential IP (your Mac) sails through; a datacenter IP (EC2) is routinely served a
403 / `Access Denied` HTML challenge instead of JSON. This is the single most likely
reason a production deploy shows no live charts.

### Symptoms

- `/api/nse/health` → `{"ok":false,…,"detail":"BLOCKED: NSE blocked this request (Akamai)…"}`
  or `AUTH: NSE session expired — HTML challenge returned instead of JSON`.
- Watchdog log lines `FAIL body={"ok":false,…}` every 5 minutes.
- `[cas-poller] NSE E1 failed: BLOCKED…` / `BSE SENSEX failed: BLOCKED…` in the 15:13–15:42
  window; charts flat, `FeedStatusBanner` shows stale.
- `/api/nse/cas` and `/api/bse/cas` (debug probes) return the same codes.
- Crucially: **the game still works, bets still take, but nothing settles** — 15:43
  finds no official closes and the day ends with `GIVING UP`. A blocked feed is a
  *money* problem, not just a cosmetic one.

### First checks (2 minutes)

1. Is it really the feed? `curl -s http://127.0.0.1:3000/api/nse/health?deep=1 | jq .detail`
   (`ok:true` here while the site is broken means the problem is elsewhere).
2. Is it the *hour* and not the IP? Outside 09:00–16:00 IST NSE's indicatives are empty
   and E1 may legitimately have nothing — that is not a block. Probe in the window.
3. One failure is not a block. `classifyNseFailure` retries once after a session reset by
   design; a single `AUTH` followed by `ok` is Akamai being Akamai.
4. Did anything change on the VM? A new outbound proxy, a package upgrade that swapped
   the TLS stack, a second app on the same IP now hammering NSE — Akamai reacts to
   volume *per IP*.
5. Run the spike curls from **the VM** (deploy/install.md §8) to see the raw response,
   then the decision tree.

### The decision tree

```
Is the VM's IP blocked?  (spike curls, install.md §8)
│
├─ NO  → nothing to do. Leave NSE_BASE_URL / BSE_BASE_URL unset.
│
├─ YES → can you run an always-on Mac at home?
│        │
│        ├─ YES → OPTION A: residential relay agent (§4.1)   ← recommended
│        │        set NSE_BASE_URL / BSE_BASE_URL, restart, re-probe.
│        │
│        └─ NO  → is home internet + a domain acceptable for the whole app?
│                 │
│                 ├─ YES → OPTION B: Cloudflare Tunnel home-hosting (§4.2)
│                 └─ NO  → OPTION C: paid feed (§4.3) — spike it FIRST
│
└─ Only BSE is blocked (or only NSE)?  → the overrides are per-feed: set only the
   one you need. One relay can front both (it just forwards two prefixes).
```

### 4.1 Option A — residential relay agent on the always-on Mac (recommended)

The app keeps running on the VM; only the two upstream calls are forwarded through a
tiny agent on the Mac, whose residential IP is what Akamai sees.

**Design sketch** (~60 lines of Node, no dependencies, runs on the Mac):

```js
// relay.mjs — run on the Mac. Forwards feed paths to the real upstreams.
// node relay.mjs   # listens on 127.0.0.1:8081
import http from 'node:http';

const TARGETS = [
	['/api/', 'https://www.nseindia.com'],                       // NSE E1 + E3 (+ the warm-up '/')
	['/RealTimeBseIndiaAPI/', 'https://api.bseindia.com']        // BSE SENSEX
];

http.createServer(async (req, res) => {
	const target = TARGETS.find(([prefix]) => req.url.startsWith(prefix));
	if (!target) {
		res.writeHead(404).end('not a feed path');
		return;
	}
	const url = target[1] + req.url;
	const upstream = await fetch(url, {
		method: 'GET',
		headers: {
			// Forward the app's headers verbatim: UA, Accept, Accept-Language,
			// Referer (and Origin for BSE). The pinned Referer/Origin naming the
			// real site is exactly what Akamai expects, and the relay does NOT
			// rewrite Host itself — fetch does, from the target.
			...(req.headers.origin ? { origin: req.headers.origin } : {}),
			referer: req.headers.referer,
			'user-agent': req.headers['user-agent'],
			accept: req.headers.accept,
			'accept-language': req.headers['accept-language']
		},
		// Never forward cookies from the app; the Mac's own Akamai handshake is
		// the app's warm-up now.
		redirect: 'manual'
	});
	const body = Buffer.from(await upstream.arrayBuffer());
	res.writeHead(upstream.status, {
		'content-type': upstream.headers.get('content-type') ?? 'application/json',
		'content-length': body.length,
		'cache-control': 'no-store'
	});
	res.end(body);
}).listen(8081, '127.0.0.1', () => console.log('feed relay on 127.0.0.1:8081'));
```

Notes on the sketch, so nobody "fixes" it into a bug:

- It is a **fixed-path forwarder, not an open proxy**. Only the two upstream prefixes
  are allowed, GET only, and it binds to loopback. That is what makes it safe to exist.
- The Akamai warm-up (`GET https://www.nseindia.com/`) goes through it too, because
  `NSE_BASE_URL` re-points the warm-up along with the API calls — the handshake warms
  the reputation of the calling IP, and the calling IP is now the Mac's.
- Session/cookie logic stays in the app; the relay is stateless.

**Getting to it from the VM — use Tailscale (or any WireGuard). Never expose the relay
publicly.** The relay has no auth on it: on the public internet it becomes a free NSE
scraper for strangers and burns the Mac's IP reputation in a day.

```bash
# Mac + VM:  curl -fsSL https://tailscale.com/install.sh | sh   &&  tailscale up
tailscale ip -4                                   # on the Mac → 100.x.y.z
# VM:
curl -sS http://100.x.y.z:8081/api/marketStatus | head -c 120; echo
```

Then on the VM:

```bash
sudo -e /opt/niftycasino/deploy/niftycasino.env   # uncomment + set:
#   NSE_BASE_URL=http://100.x.y.z:8081
#   BSE_BASE_URL=http://100.x.y.z:8081
sudo systemctl restart niftycasino
curl -s http://127.0.0.1:3000/api/nse/health?deep=1        # expect "ok":true
```

Verify the override actually took effect — the log line and the probe are the proof:

- `journalctl -u niftycasino -n 20 | grep cas-poller` shows normal `polled N` lines
  (it will not name the relay; the *absence* of `BLOCKED` is the signal), and
- the Mac sees requests arriving on `:8081` during 15:13:30–15:42 IST.

Failure modes to expect:

| symptom                                                       | cause                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| app logs `NSE_BASE_URL must be an http:// or https:// origin`  | typo in the env var. Nothing was sent anywhere — that is the loud failure you want |
| probe `NETWORK`/`TIMEOUT`                                      | relay down, Tailscale down, wrong IP:port                              |
| probe `BLOCKED` **through** the relay                          | the Mac's own IP is now blocked (or the relay is forwarding to the wrong host). Check from the Mac directly |
| works at 15:20, blocked at 15:35                               | the Mac slept / the relay died mid-auction. Set `caffeinate -dis` and add a launchd KeepAlive for the relay |

**Single point of failure, said plainly:** the Mac is now in the trading path. An
always-on Mac with autologin disabled, sleep disabled on power, and a `launchd` job
(`KeepAlive=true`, `RunAtLoad=true`) is the minimum. If that is not acceptable, use
Option B or C.

### 4.2 Option B — Cloudflare Tunnel, whole app at home

Skip the VM: run the app on the Mac (or a home box), `cloudflared tunnel` for ingress,
no open ports, and the feed is called from a residential IP by construction. The
`deploy/Caddyfile` TLS story is replaced by Cloudflare; `deploy/niftycasino.service`
stays as-is.

- Pros: R1 disappears entirely; no VM cost; no relay to babysit (Cloudflare's daemon
  reconnects itself).
- Cons: your home internet is now the production path (upload bandwidth for SSE, power
  cuts, ISP CGNAT — a Tunnel fixes inbound, not an outage); a residential IP that gets
  blocked has *no* second option; and `cas_ticks` writes now sit behind the same home
  uplink.
- Do it properly: same Postgres (Supabase), same systemd unit, `cloudflared` in its own
  unit, and keep the watchdog pointed at the public URL (`WATCHDOG_BASE_URL=https://…`)
  so it measures the whole path.

### 4.3 Option C — paid feed

Last resort, and **spike before you pay**. Requirements the feed must meet: NIFTY 50 +
NIFTY BANK + SENSEX **indicative (auction) close** values, not just LTP, at ≥ every 4s
during 15:13–15:42 IST, plus the *previous day's official close* as the anchor.

- Broker websocket APIs (Dhan, Upstox, Zerodha Kite) give live index LTP cheaply.
  **CAS indicatives are unverified on these** — PLAN §6 R1's exact caveat. If they turn
  out to carry the indicative close only after 15:42, the feed is useless for charts and
  dangerous for settlement.
- Official-close data vendors (e.g. exchange data feeds) are correct but priced for
  institutions.
- Interim fallback if only LTP is available: charts can run on LTP, but **settlement may
  not** — `index_closes.source = 'official'` is written by `captureOfficialCloses` and
  nowhere else. Hand-inserting closes is a §6 emergency procedure with an audit trail,
  not a feed strategy.

Whatever you pick: set it, restart, and watch one full auction window end to end before
you consider R1 closed.

## 5. Manual settle — the escape hatch

The settle loop only runs 15:43–17:00 IST. Outside it (17:01, next morning, after you
fixed the feed), use `scripts/settle-manual.ts`. It calls the **same** `settleNow` the
scheduler calls; it re-implements nothing.

```bash
cd /opt/niftycasino && set -a && . deploy/niftycasino.env && set +a

./node_modules/.bin/tsx scripts/settle-manual.ts --dry-run     # what does the day look like?
./node_modules/.bin/tsx scripts/settle-manual.ts               # today's IST date, capture + settle
./node_modules/.bin/tsx scripts/settle-manual.ts --date 2026-08-28   # a stuck past day
./node_modules/.bin/tsx scripts/settle-manual.ts --no-capture  # closes already in place, feed is down
```

Interface:

| flag            | meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `--date YYYY-MM-DD` | IST trade date (default: today). Future dates are refused.               |
| `--no-capture`  | skip the official-close attempt; settle against `index_closes` as it stands |
| `--dry-run`     | print the day's status + closes, write nothing                              |
| `--help`        | usage                                                                       |

Exit codes: `0` = settled (or already settled). `1` = refused or incomplete — treat as
an alert, the day is **not** done.

Rehearse the whole day — bets → settle → balance arc → re-settle no-op — without a feed
or real players with `scripts/dry-run-day.ts` (README → "Simulation & load"); on a real
Postgres it needs `--yes` and a free `--date`.

Honesty rules it will not break for you:

- **It never invents a close.** A missing NIFTY/BANKNIFTY/SENSEX official close returns
  `INCOMPLETE`, the session goes back to `open`, and nothing is paid for those bets.
- **It only captures for today's IST date, after 15:42 IST.** A past date settles against
  what `index_closes` already holds and is never back-filled with today's feed.
- **It is idempotent.** Re-running a settled day is a no-op; `ledger_payout_once` makes
  double-payment impossible.
- It refuses when the session is `settling` (another run owns the day) and when
  `DATABASE_URL` is unset (settling the in-memory store would report success and change
  nothing).

Sample output:

```
[settle-manual] 2026-08-28 session=open cutoff=2026-08-28T09:50:00.000Z closes=nifty:25012.35(official), banknifty:56240.10(official), sensex:82110.55(official)
[settle-manual] status=settled settled=412 skipped=0 tiers={"hit":37,"flat":120,"miss":255} paidOut=183400 xp=6120 chunks=1
[settle-manual] done. Verify with:
  select trade_date, status from daily_sessions where trade_date = '2026-08-28';
  select settlement_tier, count(*), sum(payout) from bets where session_id = 42 group by 1;
```

## 6. Stuck session — forcing a day back to `open`

The failure: a settle run was killed (OOM, `SIGKILL`, a deploy at 15:55) and the session
row is stuck in `settling`. The scheduler will not claim it again — its claim is a
conditional `open → settling` update — so the day sits there unsettled and every player
sees "awaiting official close" forever.

```bash
cd /opt/niftycasino && set -a && . deploy/niftycasino.env && set +a

./node_modules/.bin/tsx scripts/session-admin.ts --date 2026-08-28 --show
./node_modules/.bin/tsx scripts/session-admin.ts --date 2026-08-28 --to open --expect settling --dry-run
./node_modules/.bin/tsx scripts/session-admin.ts --date 2026-08-28 --to open --expect settling --confirm-no-live-run
./node_modules/.bin/tsx scripts/settle-manual.ts --date 2026-08-28
```

`scripts/session-admin.ts` interface:

| flag                     | meaning                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `--show`                 | print the session row + a bet summary (`N bet(s), X NC staked, Y NC paid — {…}`). No write |
| `--to open`              | **the only status this script writes** — put a stuck day back in `open`              |
| `--expect STATUS`        | compare-and-set guard: write only if the row is still in `STATUS`. Strongly recommended |
| `--dry-run`              | say what would happen, write nothing                                                 |
| `--confirm-no-live-run`  | required to move a day out of `settling`                                             |
| `--allow-reopen-settled` | required to move a day out of `settled`. Almost always wrong                         |

### The SQL equivalent (when the script is not enough)

```sql
-- 1. Look before you leap: what state is the day in, and how much money is involved?
select id, trade_date, status, cutoff_at from daily_sessions where trade_date = '2026-08-28';
select settlement_tier, count(*), sum(stake) staked, sum(payout) paid
  from bets where session_id = <id> group by 1;

-- 2. The same conditional write the script does (compare-and-set, so a run that
--    already moved the row cannot be trampled):
update daily_sessions set status = 'open'
 where id = <id> and status in ('locked','settling')
returning id, status;
-- zero rows = it moved first. STOP and re-read.
```

### What NOT to do

- **Never `insert`/`update` `index_closes` while a settle run might be live.**
  `captureOfficialCloses` is the only writer of `source = 'official'` rows, and it never
  overwrites one. A hand-written close that lands mid-run becomes the number money moves
  against, and `upsertIndexClose` will not save you. Sequence is always: confirm the run
  is dead → fix/close the session → then, and only then, consider the close.
- **Never write a close you are not sure of.** If you must hand-insert an official close
  (feed dead, exchange numbers published elsewhere), insert `source = 'official'` with
  the exchange's published value, note where it came from in the ticket, and expect to
  be asked. A `live_approx` value cannot settle a day — the engine only anchors on
  `official`.
- **Never `update bets set payout = …` / `update profiles set balance = …` by hand.**
  The ledger is the money. Hand-editing a balance desynchronises `sum(ledger)` from
  `balance`, and that invariant is what §8 checks.
- **Never reopen a `settled` day.** The bets are paid; reopening makes the UI lie until
  something settles it again. If a settled day is *wrong*, that is a new migration +
  an explicit ledger-correction plan, not a status flip.
- **Never run the settle/settle-manual pair on two nodes at once.** Tier 1 is one node;
  if you are at Tier 2, the settle loop must be pinned to exactly one of them
  (`SETTLE_DISABLED=1` on the others).

## 7. Backups and restore

Supabase backs up the database for you (free tier: daily, 7-day retention — check
Project Settings → Database → Backups). That is the whole money story; it is enough for
Tier 1. Verify once, not never:

```bash
# what would we lose? (rows that only exist in the last 24h)
psql "$DATABASE_URL" -c "select max(created_at) from ledger;"
```

Optional, cheap, and independent of Supabase — a nightly logical dump to the VM:

```bash
# /etc/cron.d/niftycasino-backup  (root; pg_dump is in the postgresql-client package)
45 18 * * * root set -a && . /opt/niftycasino/deploy/niftycasino.env && set +a && \
  umask 077 && pg_dump --role=postgres --no-owner --format=custom \
    "$(echo "$DATABASE_URL" | sed 's|postgresql://postgres\.[^@]*@|postgresql://postgres@|')" \
    > /var/backups/niftycasino-$(date +\%u).dump
```

(Seven rotating dumps, one per weekday. `--format=custom` → `pg_restore --list
<file>` to inspect, `pg_restore --clean --dbname=<new> <file>` to restore into an empty
database.)

`cas_ticks` is append-only archival data — the one table you may let a restore lose, and
the one you can also re-export per partition if you want it elsewhere:

```bash
psql "$DATABASE_URL" -c "\copy (select * from cas_ticks_p202608) to 'cas_ticks_p202608.csv' csv header"
```

**Restore drill (do it once before launch, 10 minutes):** create a throwaway Supabase
project → `pg_restore` the dump into it → point a staging `.env` at it → `npm run dev` →
signup, place a bet, `/api/state` looks right. A backup that has never been restored is
a rumour.

## 8. Scale-tier promotion checklist (PLAN §6, condensed)

Promote on **evidence**, not anxiety: p95 latency from `scripts/load-sim.ts` (T17),
Supabase dashboards, and Caddy's access log.

### Tier 1 → Tier 2 (10k → 1 lakh DAU)

| trigger                                                    | action                                                                                                                                   | exact seam in code                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| leaderboard reads + DB CPU climbing                        | move the leaderboard cache to Redis, same TTL                             | `src/lib/server/cache.ts` — `cached(fn, ttlMs, { now, cache, key })` is the whole contract; swap the backing `Map` for Redis, keep `LEADERBOARD_CACHE_TTL_MS` |
| two app nodes behind an ALB / Cloudflare                   | second node, same image, same env                                         | `deploy/niftycasino.service` ×2; set `CAS_POLLER_DISABLED=1` and `SETTLE_DISABLED=1` on exactly one of them — **the scraper and the settle loop must be singletons** |
| SSE fan-out across nodes                                   | Redis pub/sub for the tick bus, **or** sticky sessions                    | `src/lib/server/cas-store.ts` — `subscribe()`/ingest bus is in-process. Plain limit: **a client connected to node A never sees ticks ingested by node B.** Redis pub/sub on the `StreamEvent` shape fixes it properly; sticky sessions (ALB `target_group` by `SourceIp`) is the shortcut that keeps the bus untouched |
| Postgres connection pressure (Supabase pooler saturation)  | Supabase Pro ($25) or a pgbouncer sidecar                                 | `src/lib/server/db/postgres.ts` — one pool per process (`buildPoolOptions`)                                                                           |
| DDoS / abusive crawlers                                    | Cloudflare in front                                                       | `deploy/Caddyfile` — commented `trusted_proxies` + `client_ip_headers CF-Connecting-IP` block; do this before you need it                             |
| build-on-VM is the slow part of a deploy                   | build in CI, ship `build/` + production `node_modules`                    | `.github/workflows/ci.yml` already builds; add a job that artifacts `build/` and `npm ci --omit=dev` on the VM                                        |

### Tier 2 → Tier 3 (1 lakh → 10 lakh)

- 4–6 app nodes; move Postgres off Supabase onto 2× EC2 (or Supabase's scale tier).
- **Replace SSE with CDN-cached polling** (PLAN §6 R5): Cloudflare caches
  `GET /api/cas/all` per second-bucket, so lakhs of clients cost the origin almost
  nothing. Seam: `CAS_FALLBACK_POLL_MS` in `src/lib/config/app.ts` already exists and the
  client already falls back to it — flipping the default is the migration.
- Settle burst (30 lakh rows/day): `SETTLE_CHUNK` (5,000) is the knob; shard by
  `underlying` if one day still takes minutes. Never settle two days concurrently.
- Retention: `scripts/partitions.ts --retention-days` is the lever (PLAN §6: 90 days).

## 9. Pre-launch verification checklist (PLAN §8)

Fill this in on the live deploy. Not from your laptop alone — the marked ⛳ items need
the real auction window.

- [ ] Signup → verify → 1,000 NC + ledger row; handle assigned
      (`select * from profiles;` / `select * from ledger where kind='signup_bonus';`)
- [ ] Place/edit/cancel on all 3 indices pre-cutoff; rejected at 15:20:01; pot counters
      match placed bets exactly (`select * from daily_pots order by trade_date desc limit 1;`) ⛳
- [ ] Real CAS window: all charts tick ≤8s fresh via SSE; kill the network mid-auction →
      refresh → the chart backfills seamlessly from `?since=` ⛳
- [ ] Miss = 0 credited, stake gone; HIT pays stake × odds; FLAT dead-zone refunds;
      re-settle is a no-op (`scripts/settle-manual.ts` twice; the second run is a no-op) ⛳
- [ ] Pot ticker (total bets + NC staked) matches DB aggregates; `/u/<handle>` shows the
      correct per-user totals
- [ ] Settlement credits consistent: `sum(ledger)` == `balance − 1000` for sampled users:
      ```sql
      select p.user_id, p.balance - 1000 as expected, coalesce(sum(l.amount),0) as ledger_sum
        from profiles p left join ledger l on l.user_id = p.user_id
       group by 1 having p.balance - 1000 <> coalesce(sum(l.amount),0);   -- expect 0 rows
      ```
- [ ] Leaderboards + streaks + XP update at settlement ⛳
- [ ] Load sim: 10k concurrent SSE + snapshot p95 < 500ms on Tier 1 hardware
      (`scripts/load-sim.ts --conns 10000 --duration 120 --ramp 30`; raise the fd limit on
      the generator AND the server first — README → "Simulation & load")
- [ ] Production feed unblocked (or the relay is live and `deep=1` says `ok:true`);
      watchdog alerting proven by forcing a failure (stop the app for one probe)
- [ ] Mobile layout verified at 360px width; all interactions thumb-reachable
- [ ] Restore drill done (§7) — a backup that has never been restored is a rumour
- [ ] `docs/RUNBOOK.md` §2 timeline observed on one real day, logs grepped once ⛳

Signed off by / date: ________________
