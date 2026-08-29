# Tier 1 install — one EC2 VM, Caddy, systemd

The exact bring-up for **PLAN §6 Tier 1**: 1× EC2 `t3.small` (or the existing VM),
Supabase free tier, Caddy for TLS, systemd for the app, a systemd timer for the feed
watchdog. Budget ~40 minutes, most of it waiting for DNS.

Everything here is copy-pasteable except the five placeholders:

| placeholder                | what it is                                        | where you get it              |
| -------------------------- | ------------------------------------------------- | ----------------------------- |
| `<project-ref>`            | Supabase project ref (`abc` in `https://abc.supabase.co`) | Supabase dashboard     |
| `<db-password>`            | the Postgres password you set at project creation  | Supabase → Project Settings → Database |
| `<cas.example.com>`        | the domain                                         | your DNS provider             |
| `<vm-ip>`                  | the VM's public IP                                 | EC2 console                   |
| `<relay-host>:<port>`      | only if the feed spike fails                       | docs/RUNBOOK.md → R1          |

**Before you start, run the Task 3.5 spike** (step 8 below, or from your laptop against
the VM over SSH). If the VM's IP is blocked by NSE, stop after step 5 and read
docs/RUNBOOK.md → "Blocked-feed triage (R1)" — the fix is an env var, not a rebuild.

---

## 0. Assumptions

- Ubuntu 22.04/24.04 on `x86_64`, 1–2 vCPU, ≥2 GiB RAM (t3.small).
- You can SSH in as a sudo-capable user.
- Ports 22, 80 and 443 are open in the security group (80 is needed once, for the
  Let's Encrypt HTTP-01 challenge).
- The repo is at `/opt/niftycasino` and the app runs as the unprivileged user
  `niftycasino`.

## 1. Base packages + node 22

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg build-essential caddy postgresql-client

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v22.x
```

`postgresql-client` is only for running the migrations with `psql`; drop it if you use
the Supabase CLI instead.

## 2. The app's user and the code

```bash
sudo adduser --system --group --home /opt/niftycasino --shell /usr/sbin/nologin niftycasino
sudo git clone https://github.com/<you>/nifty-casino.git /opt/niftycasino
sudo chown -R niftycasino:niftycasino /opt/niftycasino
cd /opt/niftycasino
```

To upgrade later: `sudo -u niftycasino git -C /opt/niftycasino pull` (see
docs/RUNBOOK.md → "Restart / upgrade" — it is a build + a restart, nothing else).

## 3. Dependencies, then build

Build **on the VM** for v1. `vite`/`svelte`/`typescript` are devDependencies, so
`npm ci --omit=dev` cannot build; the runtime-only-image optimisation is a Tier 2
concern (build in CI, rsync `build/` + production `node_modules`).

```bash
cd /opt/niftycasino
sudo -u niftycasino npm ci --include=dev   # --include=dev: BUILD needs vite/sveltekit
sudo -u niftycasino npm run build          # → build/index.js (adapter-node)
sudo -u niftycasino npm run sim:ev -- --quiet   # launch gate: every option's EV < 1
```

Keep the devDependencies installed. They cost disk, not memory, and they are what
makes `git pull && npm ci && npm run build && sudo systemctl restart niftycasino`
the whole upgrade story.

## 4. Supabase: migrations, keys, partitions

Create the project first (Supabase → New project; note `<project-ref>` and
`<db-password>`). Then run the schema — either `psql` against the **direct** string
(DDL wants a real session, not the pooler):

```bash
cd /opt/niftycasino
psql "postgresql://postgres:<db-password>@db.<project-ref>.supabase.co:5432/postgres" \
     -f supabase/migrations/0001_init.sql
psql "postgresql://postgres:<db-password>@db.<project-ref>.supabase.co:5432/postgres" \
     -f supabase/migrations/0002_handle_new_user.sql
```

…or `supabase link --project-ref <project-ref> && supabase db push`.

Then the tick partitions. `cas_ticks` is `PARTITION BY RANGE (trade_date)` and Postgres
refuses to insert into a partitioned table with no matching partition, so this is **not
optional**:

```bash
cd /opt/niftycasino
export DATABASE_URL="postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
./node_modules/.bin/tsx scripts/partitions.ts --months 6 --retention-days 90
./node_modules/.bin/tsx scripts/partitions.ts --months 6 --retention-days 90 --dry-run  # re-run: nothing to do
```

## 5. The env file + the service

```bash
cd /opt/niftycasino
sudo cp deploy/niftycasino.env.example deploy/niftycasino.env
sudo -e deploy/niftycasino.env          # fill in DATABASE_URL + the three Supabase values
sudo chmod 600 deploy/niftycasino.env
sudo chown niftycasino:niftycasino deploy/niftycasino.env

sudo cp deploy/niftycasino.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now niftycasino
journalctl -u niftycasino -n 40 --no-pager
```

What you want to see in the log:

```
[db] driver=postgres postgresql://postgres.<ref>:***@aws-0-<region>.pooler…
[cas-poller] started — every 4000ms inside 15:13:30–15:42:00 IST, re-checking every 30s outside it
[settle] scheduler started — weekdays 15:43:00–17:00:00 IST, re-checking every 60s while closes are missing
Listening on 127.0.0.1:3000
```

`driver=memory` means `DATABASE_URL` did not reach the process — stop and fix the env
file before going further (see deploy/niftycasino.env.example for the two usual causes).

## 6. Caddy + DNS

Point `<cas.example.com>`'s A record at `<vm-ip>`, then:

```bash
sudo cp /opt/niftycasino/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/cas\.example\.com/<cas.example.com>/g' /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy      # or: sudo systemctl enable --now caddy
journalctl -u caddy -n 20 --no-pager
```

Caddy provisions and renews the Let's Encrypt certificate by itself; the first hit on
the domain takes a few seconds while it does. If you would rather put Cloudflare in
front, read the commented block at the bottom of `deploy/Caddyfile` **before** you
flip the orange cloud — the client-IP header has to be configured or every player logs
as a Cloudflare edge IP.

## 7. The watchdog

```bash
sudo install -m 755 /opt/niftycasino/deploy/watchdog.sh /usr/local/bin/niftycasino-watchdog.sh
sudo install -m 644 /opt/niftycasino/deploy/watchdog.service /etc/systemd/system/
sudo install -m 644 /opt/niftycasino/deploy/watchdog.timer /etc/systemd/system/
sudo mkdir -p /var/log/niftycasino /var/lib/niftycasino-watchdog
sudo chown -R niftycasino:niftycasino /var/log/niftycasino /var/lib/niftycasino-watchdog
sudo systemctl daemon-reload
sudo systemctl enable --now niftycasino-watchdog.timer
sudo systemctl start niftycasino-watchdog.service   # first probe, right now
journalctl -u niftycasino-watchdog.service -n 5 --no-pager
tail -3 /var/log/niftycasino/watchdog.log
```

Optionally add an alert endpoint (ntfy / Slack webhook) in
`/etc/systemd/system/niftycasino-watchdog.service`, then `daemon-reload`.

## 8. The feed spike (Task 3.5) — run this BEFORE you care about anything else

From the **VM** (not your laptop — the whole point is the datacenter IP):

```bash
# --- NSE E3: the cheap probe the watchdog uses -----------------------------
curl -sS -o /tmp/e3.json -D /tmp/e3.h -m 20 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Accept-Language: en-US,en;q=0.9' \
  -H 'Referer: https://www.nseindia.com/' \
  'https://www.nseindia.com/api/marketStatus'
head -1 /tmp/e3.h; head -c 300 /tmp/e3.json; echo

# --- NSE E1: the chart feed (needs the homepage warm-up first) -------------
curl -sS -o /dev/null -c /tmp/nse.jar -m 20 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  https://www.nseindia.com/
curl -sS -o /tmp/e1.json -D /tmp/e1.h -b /tmp/nse.jar -m 20 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Referer: https://www.nseindia.com/' \
  'https://www.nseindia.com/api/NextApi/apiClient?functionName=getIndexData&&type=All'
head -1 /tmp/e1.h; head -c 300 /tmp/e1.json; echo

# --- BSE SENSEX ------------------------------------------------------------
curl -sS -o /tmp/bse.json -D /tmp/bse.h -m 20 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -H 'Accept: application/json, text/plain, */*' \
  -H 'Origin: https://www.bseindia.com' \
  -H 'Referer: https://www.bseindia.com/markets/equity/closing_auction_session' \
  'https://api.bseindia.com/RealTimeBseIndiaAPI/api/GetSensexDatanew/w'
head -1 /tmp/bse.h; head -c 300 /tmp/bse.json; echo
```

Reading it:

| result                                              | meaning                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `200` + `content-type: application/json` + real data | the IP is fine — skip R1 entirely                              |
| `403`, or an `Access Denied` HTML page               | **blocked.** Do the R1 decision tree in docs/RUNBOOK.md        |
| `200` with HTML instead of JSON                      | Akamai challenge: blocked in practice                          |
| times out from the VM but works from your laptop     | blocked (or the VM's egress is filtered)                       |

The app's own verdict is the one that counts, so after any env change also hit
`/api/nse/health?deep=1` and read `detail` — `BLOCKED` / `AUTH` mean R1 applies.

## 9. Smoke test

```bash
# through Caddy, from outside (or from the VM with the public URL)
curl -sS https://<cas.example.com>/api/nse/health | head -c 300; echo
curl -sS 'https://<cas.example.com>/api/cas/all' | head -c 300; echo
curl -sS -o /dev/null -w 'GET / -> %{http_code} in %{time_total}s\n' https://<cas.example.com>/
curl -sS -o /dev/null -w 'GET /api/state -> %{http_code}\n' https://<cas.example.com>/api/state

# SSE: this should NOT return — it should hold the connection open and print a
# frame every 15s (the heartbeat). Ctrl-C to stop. If it returns immediately, or
# prints one giant blob, the proxy is buffering /api/stream.
curl -i -N --max-time 20 https://<cas.example.com>/api/stream | head -20
```

`/api/cas/all` returns `{"byUnderlying":...}` with whatever the store holds (empty on
a brand-new install outside the auction window — that is correct, not an error). On the
first ever boot there is no `index_closes` row yet either; the first live auction window
writes the previous-day anchors the ladder and settlement hang off.

## 10. The monthly partition cron

`scripts/partitions.ts` is idempotent, so monthly is plenty (it pre-creates ±6 months,
so even a missed run cannot break tomorrow):

```bash
sudo install -m 644 /dev/null /var/log/niftycasino/partitions.log
sudo crontab -u niftycasino -e
```

```
# cas_ticks partitions: pre-create + retention, monthly, idempotent
17 3 1 * * cd /opt/niftycasino && set -a && . deploy/niftycasino.env && set +a && ./node_modules/.bin/tsx scripts/partitions.ts --months 6 --retention-days 90 >> /var/log/niftycasino/partitions.log 2>&1
```

03:17 UTC = 08:47 IST — off the auction window, off the settle window. If you would
rather not use cron, a second systemd timer is the drop-in replacement; keep the same
command.

## 11. Post-install checklist

- [ ] `journalctl -u niftycasino | grep 'driver=postgres'` — the store is really Postgres
- [ ] `/api/nse/health?deep=1` → `"ok":true` (or the R1 relay is live and says so)
- [ ] `/api/cas/all`, `/`, `/api/state` all 200 through Caddy
- [ ] `curl -iN /api/stream` holds the connection and heartbeats every 15s
- [ ] `niftycasino-watchdog.timer` active and its first log line says `ok`
- [ ] Signup → verify → `profiles.balance = 1000` + a `signup_bonus` ledger row
      (README → "Manual verification checklist")
- [ ] A bet placed at 15:19 IST appears in `bets` and moves `daily_pots`
- [ ] Supabase SMTP configured (Project Settings → Authentication → SMTP) — the built-in
      provider is rate-limited and will silently stall verifications in production
- [ ] `docs/RUNBOOK.md` §8 checklist worked through on the live deploy
