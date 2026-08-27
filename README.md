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
