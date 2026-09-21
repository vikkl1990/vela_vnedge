# VNEdge — Pine-script scanner bot for Delta Exchange India (paper trading)

VNEdge runs **WillyAlgoTrader's published TradingView Pine scripts** as independent scanners
on live **Delta Exchange India** perpetual-futures data, turns their buy/sell alerts with
SL / TP1–TP3 into **paper trades**, and shows everything on a local **Vela**-powered
dashboard.

* Pine execution: [PineTS](https://github.com/LuxAlgo/PineTS) (LuxAlgo's open-source Pine runtime, Node.js)
* Charts: [Vela](https://docs.luxalgo.com/vela) + [Vela-PineTS](https://github.com/LuxAlgo/Vela-pinets) (same scripts rendered on the chart)
* Market data: Delta India REST + websocket (`api.india.delta.exchange`, `socket.india.delta.exchange`)
* Storage: SQLite via Node's built-in `node:sqlite` — **no native build steps**

## Requirements

* Node.js ≥ 22.18 (tested on 25.x; TypeScript runs natively, no compile step)
* Internet access to Delta Exchange India and (for the first dashboard build) npm

## Quick start

```bash
npm install                # installs server + dashboard workspaces
npm run build              # builds the dashboard into dashboard/dist
npm start                  # server + dashboard on http://localhost:8787
```

Development (hot reload on both sides):

```bash
npm run dev                # server on :8787 (node --watch)
npm run dev:dashboard      # Vite on :5173, proxies /api → :8787
```

Other commands:

| Command | What it does |
|---|---|
| `npm test` | unit + integration tests (alert parser, fill logic, ops: gap detection, alerts, backups, metrics, a full recorded-feed replay through `App`) |
| `npm run compat -- BTCUSD 15m 1000` | runs every script through PineTS and rewrites `scripts/compat-report.json` |
| `npm run backtest -- <scanner-id> BTCUSD 15m 1500` | standalone backtest of one scanner |

## What you get

* **451 scanners**: 42 from <https://in.tradingview.com/u/WillyAlgoTrader/#published-scripts>
  (40 open-source, all 40 execute under PineTS with small compatibility patches listed per
  scanner in the UI) and 409 from <https://in.tradingview.com/u/LuxAlgo/#published-scripts>
  (395 open-source; the share that PineTS can execute is recorded in
  `scripts/compat-report.json` and shown as the scanner status). Import more authors with
  `node server/src/cli/import-scripts.ts <author> <list.json>` (the list comes from
  `https://in.tradingview.com/api/v1/scripts/?by=<user>&per_page=100&page=N`).
* **Symbol universe**: a fixed list, the top-N Delta perpetuals by 24h turnover, or all live
  perpetuals (Settings → Symbol universe). Every enabled scanner runs on every symbol on each
  bar close, so mind the product: 300 scanners × 20 symbols is ~6000 script runs per 15m bar.
* Each scanner runs on every **closed bar** for each configured symbol × timeframe
  (default `BTCUSD`, `ETHUSD` on `15m`), in isolated worker threads.
* Signals come from the scripts' own `alert()` messages, directional `alertcondition()`
  titles ("Bullish Internal OB Breakout", "Upward Breakout") and directional plotshapes, (`🟢 LONG … SL: … TP1: … TP2: … TP3: …`,
  `🛑 SL HIT`, `🎯 TP1 HIT`, `🔄 REVERSAL`, SATS `buy LONG @ …`, …) with `plotshape`
  and ATR-based fallbacks for scripts that don't publish levels.
* Scripts that only publish market structure (pivot CHoCH, squeeze fires, the volume-profile
  80% rule, fib entry zones, S/R breakout labels, VWAP HL/LH structure, Elliott projections,
  AMD distribution calls) are turned into entries by per-scanner **derivation rules**
  (`server/src/scanners/rules.ts`); such signals are tagged *derived* and use the script's
  levels where published, otherwise ATR stops/targets.
* Two sizing modes: `risk` (each trade risks a % of equity at its stop) or `quality`
  (notional = equity × leverage, with leverage scaled from `minLeverage` for unscored/weak
  signals to `maxLeverage` for score 100). Exchange-style liquidation is modelled
  (`liquidation`, `maintenanceMarginPct`). `npm run verdict` backtests the whole fleet under
  any override, e.g. `npm run verdict -- BTCUSD,ETHUSD 15m 1500 '{"initialEquity":1000,"sizingMode":"quality","minLeverage":5,"maxLeverage":50}'`.
* **Auto-tune** (on by default): after every warm-up and every 6 hours (re-backtest first) each
  enabled scanner is restricted to the symbols where its backtest is profitable (≥ 3 trades,
  PF ≥ 1); a scanner with no qualifying symbol is disabled. Settings → Auto-tune, or the
  "Auto-tune symbols" button / `POST /api/scanners/auto-tune`.
* **Fee-aware entries**: a signal is skipped when its stop is closer than `minRiskFeeRatio`
  (default 4) × the round-trip taker fee, so fees cannot eat the risk budget on tight stops.
* The **paper engine** sizes by risk % of equity, fills SL/TP legs on 1-minute candles,
  moves SL to break-even after TP1, charges Delta taker fees + slippage, and keeps a full
  audit trail (signals → positions → fills → trades → equity curve).
* On start-up every scanner is **backtested over the loaded history** so the dashboard
  shows win-rate / profit-factor / expectancy immediately.
* **Trade learning** (`server/src/ml`): every backtest and live trade is stored with its
  entry-time features (direction, script score, hour/weekday, ATR %, stop distance in ATR,
  TP1 reward:risk, 5/20-bar returns, trend vs EMA50/200, volume ratio, range position, level
  and signal source, leverage). A dependency-free logistic regression per scanner (≥ 40 trades)
  and globally gives every new signal a win probability; bucket analysis produces rules such as
  "avoid ATR % ≤ 0.30" or "prefer weekdays". Settings → Machine learning can gate entries below
  a probability and use the probability as the leverage score. Dashboard page: **Learn**.
* Dashboard pages: Overview, Scanners, Scanner detail (chart with the script overlaid),
  Signals, Positions & Trades, Chart, Analytics (pair and scanner leaderboards, scanner × pair
  heatmap, hour/weekday PnL, exit reasons; backtest vs live), Learn, Settings, Logs — live via
  Server-Sent Events.

## Configuration

Everything is editable in the dashboard (**Settings**) or `data/config.json`:

```jsonc
{
  "symbols": ["BTCUSD", "ETHUSD"],
  "timeframes": ["15m"],            // 1m 3m 5m 15m 30m 1h 2h 4h 6h 1d
  "historyBars": 1000,              // bars fed to each script (also the backtest window)
  "paper": {
    "initialEquity": 100000, "riskPerTradePct": 1, "maxLeverage": 10, "sizingMode": "risk", "minLeverage": 5,
    "liquidation": true, "maintenanceMarginPct": 0.5,
    "feeRatePct": 0.05, "makerFeeRatePct": 0.02, "slippageBps": 2, "tpSplit": [0.4, 0.3, 0.3],
    "breakEvenAfterTp1": true, "allowReversal": true,
    "fallbackAtrSl": 1.5, "fallbackRR": [1, 2, 3], "maxOpenPositions": 20
  },
  "execution": { "mode": "paper" },
  "scanners": { "reactive-trail-system": { "enabled": true, "symbols": null, "timeframes": null, "exitMode": "both" } }
}
```

Environment variables: `PORT` (8787), `HOST` (127.0.0.1), `VNEDGE_WORKERS` (worker threads),
`VNEDGE_SYMBOLS`, `VNEDGE_TIMEFRAMES`, `LOG_LEVEL`, `LOG_FORMAT` (`text` | `json`), `VNEDGE_DATA_DIR`,
`VNEDGE_LOG_FILE=0` (disable the rotated log file), `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (alerts).

Operations settings (`ops`, `alerts`) live in the same file; defaults:

```jsonc
{
  "ops": { "backupHourUtc": 2, "backupKeepDays": 14, "logMaxBytes": 10485760, "logMaxFiles": 5,
           "queueDepthAlert": 200, "diskLowMb": 500, "driftWarnMs": 2000, "shutdownTimeoutMs": 20000 },
  "alerts": { "telegram": { "botToken": "", "chatId": "" },   // prefer the env vars: keeps the token out of config.json
              "drawdownPct": 10, "onTrade": false, "dailySummaryHourUtc": 0, "repeatMinutes": 60, "maxPerHour": 30 }
}
```

### Optional: mirror paper fills to the Delta India demo account

Create API keys on the **demo** site (<https://demo-india.delta.exchange>), then:

```bash
DELTA_API_KEY=… DELTA_API_SECRET=… npm start
```

and set `"execution": { "mode": "testnet" }`. Fills are sent as market orders to the
testnet host only (`cdn-ind.testnet.deltaex.org`); production keys are never used.

## Running it unattended (Phase 4 operations)

### Process supervision

**launchd (macOS, recommended):** starts at login, restarts on any exit (crash loop throttled to
one start per 10 s), sends SIGTERM for a graceful stop and waits 45 s before SIGKILL.

```bash
ops/install-launchd.sh              # writes ~/Library/LaunchAgents/com.vnedge.server.plist and starts it
ops/install-launchd.sh --status     # state / pid / last exit code
ops/install-launchd.sh --restart    # e.g. after a pull
ops/uninstall-launchd.sh            # stop and remove
PORT=8790 TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… ops/install-launchd.sh   # optional overrides baked into the plist (mode 600)
tail -f data/logs/vnedge.log        # the app's own rotated log; launchd's stdout/stderr: data/logs/launchd.{out,err}.log
```

**pm2 (any OS):** `npm i -g pm2 && pm2 start ops/pm2.config.cjs`, then `pm2 logs vnedge`,
`pm2 restart vnedge`, `pm2 stop vnedge`; `pm2 save && pm2 startup` to survive reboots.

Both send SIGTERM; the server then stops timers, waits up to `ops.shutdownTimeoutMs` for in-flight
script runs, stops the worker pool and flushes the log before exiting.

### Alerts (Telegram)

Create a bot with @BotFather, open a chat with it and read your chat id from
`https://api.telegram.org/bot<token>/getUpdates`. Set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
(or `alerts.telegram` in `data/config.json`) and restart. `POST /api/ops/alerts/test` sends a test
message. Without a target nothing changes: conditions are still evaluated and logged.

Conditions (evaluated every 15 s, one message when raised, one when resolved, repeats at most every
`alerts.repeatMinutes`, hard cap `alerts.maxPerHour`): feed disconnected > 60 s; Pine worker crash
loop (≥ 3 respawns in 5 min); worker queue deeper than `ops.queueDepthAlert` for > 5 min; equity
drawdown from its peak ≥ `alerts.drawdownPct`; no bar close for 2× the timeframe on a tracked
series; free disk below `ops.diskLowMb`; SQLite errors. Plus a daily summary at
`alerts.dailySummaryHourUtc` (equity, 24 h pnl, trades, top scanners) and, with `alerts.onTrade`,
a line for every closed live trade. The token is never logged.

### Candle integrity

On every bar close and after every reconnect the store checks for missing bars between consecutive
candles, backfills them from REST and reports `integrity` events (`gap`, `gap-filled`,
`gap-unfillable` when the exchange simply had no trades, `clock-drift`, `delisted`, `tick-size`).
When a backfilled bar is the newest closed bar it is announced once so the scanners re-run on it;
`closed` is still emitted exactly once per bar. The local clock is compared with exchange
timestamps (warning above `ops.driftWarnMs`), and tracked symbols are checked against
`/v2/products` every 10 minutes. `GET /api/ops/integrity`, `POST /api/ops/integrity/check`.

### Backups, logs, metrics

* Nightly SQLite snapshot (`VACUUM INTO`) at `ops.backupHourUtc` into `data/backups/`
  (`vnedge-YYYYMMDD-HHMMSS.db`, kept `ops.backupKeepDays` days); `POST /api/ops/backup` any time,
  `GET /api/ops/backups` to list. Restore = stop the server, copy a snapshot over `data/vnedge.db`
  (delete `-wal`/`-shm`), start.
* `data/logs/vnedge.log` rotates at `ops.logMaxBytes` keeping `ops.logMaxFiles` generations
  (`vnedge.log.1` …); `LOG_FORMAT=json` writes one JSON object per line (console and file);
  `POST /api/ops/logs/rotate`.
* `GET /api/metrics` is Prometheus text (feed, tick age, queue depth, busy workers, respawns, bars
  closed, script runs/errors and per-minute rates, signals, positions, equity, pnl, backtests,
  memory, CPU, event-loop lag, gaps, drift, alerts, backups). Scrape config:

  ```yaml
  scrape_configs:
    - job_name: vnedge
      metrics_path: /api/metrics
      static_configs: [{ targets: ['127.0.0.1:8787'] }]
  ```

* `GET /api/health` now carries `integrity`, `alerts` (last sent, active conditions) and `ops`
  (last backup, log size, db size/errors, worker respawns, monitor state).

### CI

`.github/workflows/ci.yml` runs on every push and pull request: `npm ci`, `tsc --noEmit`, the
server unit + integration tests on Node 22 and 24, the dashboard lint + build, and validates the
launchd/pm2 files.

## Repository layout

```
server/      Node/TypeScript bot: feed, PineTS workers, scanners, paper engine, REST+SSE API
dashboard/   Vite + React dashboard (Vela chart)
scripts/     Pine sources (scripts/pine/*.pine), manifest.json, compat-report.json
docs/        API.md (contract), ARCHITECTURE.md, SCANNERS.md, ROADMAP.md
ops/         launchd plist + install scripts, pm2 config
data/        runtime: vnedge.db, config.json, logs/, backups/   (ignored by version control)
```

## Notes & limitations

* Paper fills are bar-based (1-minute resolution) and resolve SL before TP on ambiguous
  bars — conservative versus TradingView's tick-level fills.
* PineTS is a re-implementation of Pine; a handful of built-ins behave differently. The
  patches in `server/src/pine/patches.ts` document every deviation VNEdge works around.
* This is a research/paper-trading tool, not investment advice. Nothing here places real
  orders unless you deliberately enable the demo-account mirror.
