# VNEdge Server API (contract)

Base URL: `http://localhost:8787` (configurable via `PORT`). All responses are JSON.
The server also serves the built dashboard from `/` (files in `dashboard/dist`).

Time values are **epoch milliseconds** unless the field name ends in `Sec`.
Prices are numbers in USD. `side` is `"long" | "short"`. Timeframes use Delta
resolution strings: `1m 3m 5m 15m 30m 1h 2h 4h 6h 1d`.

## Health / config

`GET /api/health`
```json
{ "status": "ok", "uptimeSec": 123, "mode": "paper", "now": 1789902184652,
  "feed": { "connected": true, "lastTickAt": 1789902184652, "subscriptions": ["BTCUSD:15m","BTCUSD:1m"] },
  "scanners": { "total": 42, "runnable": 36, "enabled": 30 },
  "worker": { "size": 4, "queued": 0, "busy": 1 },
  "lastError": null,
  "integrity": { "gapsFound": 2, "gapsFilled": 2, "gapsUnfillable": 0, "barsBackfilled": 2, "backfillErrors": 0,
                 "driftMs": 412, "driftCheckedAt": 1789902184652, "driftWarnings": 0, "delisted": [], "tickSizeChanges": 0,
                 "symbolsCheckedAt": 1789902184652, "lastEvent": { "at": 1, "type": "gap-filled", "symbol": "BTCUSD", "tf": "15m", "filled": 2, "detail": "…" } },
  "alerts": { "configured": true, "channel": "telegram", "sent": 3, "suppressed": 0, "failed": 0,
              "lastSent": { "at": 1, "key": "feed.disconnected", "text": "…", "delivered": true }, "active": [] },
  "ops": { "backup": { "dir": "…/data/backups", "lastAt": 1, "lastFile": "…", "lastBytes": 86016, "lastMs": 2, "lastError": null, "count": 1, "failures": 0, "nextAt": 1, "running": false },
           "log": { "file": "…/data/logs/vnedge.log", "bytes": 1223, "rotations": 0, "writeErrors": 0, "format": "text" },
           "db": { "bytes": 245760, "errors": 0, "lastError": null },
           "workers": { "spawns": 4, "respawns": 0, "respawnsLast5m": 0 },
           "monitor": { "feedDownSince": null, "queueDeepSince": null, "equityPeak": 100000, "drawdownPct": 0, "dbErrorsSeen": 0, "diskFreeMb": 210000, "lastEvalAt": 1, "lastSummaryDay": null, "evaluations": 12 },
           "shuttingDown": false } }
```
`candles` entries carry `lastBarTime`, `lastClosedAt` and `loadedAt` (ms) for staleness checks. `integrity.driftMs` is local clock minus exchange time (positive = local clock ahead).

`GET /api/config` → current config (shape below). `PUT /api/config` with a partial
object merges and persists it; returns the full config. Changing `symbols`/`timeframes`
re-subscribes the feed and re-warms scanners.
```json
{ "symbols": ["BTCUSD", "ETHUSD"],
  "universe": { "mode": "list", "top": 20, "exclude": [] },   // list | top | all; GET adds "resolvedSymbols"
  "timeframes": ["15m"],
  "historyBars": 1000,
  "paper": { "initialEquity": 100000, "riskPerTradePct": 1, "maxLeverage": 10,
             "sizingMode": "risk", "minLeverage": 5, "liquidation": true, "maintenanceMarginPct": 0.5,
             "feeRatePct": 0.05, "makerFeeRatePct": 0.02, "slippageBps": 2, "tpSplit": [0.4, 0.3, 0.3],
             "breakEvenAfterTp1": true, "allowReversal": true, "fallbackAtrSl": 1.5,
             "fallbackRR": [1, 2, 3], "maxOpenPositions": 20 },
  "execution": { "mode": "paper" },
  "ops": { "backupHourUtc": 2, "backupKeepDays": 14, "logMaxBytes": 10485760, "logMaxFiles": 5, "queueDepthAlert": 200, "diskLowMb": 500, "driftWarnMs": 2000, "shutdownTimeoutMs": 20000 },
  "alerts": { "telegram": { "botToken": "", "chatId": "" }, "drawdownPct": 10, "onTrade": false, "dailySummaryHourUtc": 0, "repeatMinutes": 60, "maxPerHour": 30 },
  "scanners": { "<scannerId>": { "enabled": true, "symbols": null, "timeframes": null, "exitMode": "both" } } }
```
`alerts.telegram` is returned as stored; set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in the environment instead to keep the token out of the config file and this endpoint.

## Markets & candles

`GET /api/markets` → `[{ "symbol": "BTCUSD", "description": "Bitcoin Perpetual", "tickSize": 0.5, "contractValue": 0.001, "markPrice": 80273.5, "change24hPct": -1.2 }]`

`GET /api/candles?symbol=BTCUSD&tf=15m&limit=1000&from=<ms>&to=<ms>` → ascending
`[{ "time": 1789901100000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1 }]`
(the last bar is the forming bar). `from`/`to` optional; `limit` default 1000, max 4000.

`GET /api/ticker?symbol=BTCUSD` → `{ "symbol": "BTCUSD", "price": 80273.5, "markPrice": 80273.5, "time": 1789902184652 }`

## Scanners

`GET /api/scanners` →
```json
[{ "id": "reactive-trail-system", "name": "Reactive Trail System", "file": "73fIFFEV-Reactive-Trail-System-WillyAlgoTrader.pine",
   "url": "https://in.tradingview.com/script/...", "status": "ok", "reason": null,
   "enabled": true, "overlay": true, "pineVersion": "6", "lines": 1128,
   "symbols": ["BTCUSD","ETHUSD"], "timeframes": ["15m"], "exitMode": "both",
   "lastRun": { "at": 1789902184652, "ms": 612, "symbol": "BTCUSD", "tf": "15m", "error": null },
   "stats": { "signals": 12, "trades": 9, "open": 1, "wins": 5, "losses": 4, "winRatePct": 55.6,
              "pnl": 812.4, "pnlPct": 0.81, "avgR": 0.42, "profitFactor": 1.6, "maxDrawdownPct": 1.2,
              "backtest": { "trades": 40, "winRatePct": 48, "pnl": 1200, "profitFactor": 1.3 } } }]
```
`status` is `"ok" | "incompatible" | "unavailable"`; only `ok` scanners can be enabled.

`POST /api/scanners/:id` body `{ "enabled": true, "symbols": ["BTCUSD"], "timeframes": ["15m"], "exitMode": "levels", "hidden": false }` (all optional; `hidden: true` also disables) → updated scanner. Scanner objects carry `hidden`; the dashboard lists hidden ones only behind a "show removed" toggle.

`POST /api/scanners/auto-tune` body `{ "minTrades": 3, "minProfitFactor": 1 }` → restricts every enabled scanner to the symbols where its backtest is profitable (pnl > 0, PF ≥ min, trades ≥ min); scanners with no qualifying symbol are disabled. Returns `{ tuned, disabled, report: [{ id, name, before, after, disabled, dropped: [{symbol, trades, pnl}] }] }`.

`POST /api/scanners/:id/run` → runs now on all its symbols/timeframes; returns `{ "queued": 2 }`.

`GET /api/scanners/:id/source` → `{ "id", "source": "<original pine>", "patched": "<pine actually executed>", "patches": ["label.all-size"] }`

`GET /api/scanners/:id/overlay?symbol=BTCUSD&tf=15m` → last run's plot data for charting:
```json
{ "at": 1789902184652, "plots": [{ "title": "Trail", "style": "line", "overlay": true, "data": [{ "time": 1, "value": 2, "color": "#f00" }] }],
  "shapes": [{ "title": "Long", "time": 1, "shape": "label_up", "location": "belowbar", "color": "#0f0" }],
  "labels": [{ "time": 1, "y": 80000, "text": "TP1 81021", "color": "#fff" }] }
```

## Signals, positions, trades

`GET /api/signals?limit=200&scanner=<id>&symbol=BTCUSD&kind=entry&since=<ms>` → newest first
```json
[{ "id": 91, "at": 1789902184652, "barTime": 1789901100000, "scannerId": "reactive-trail-system", "scannerName": "Reactive Trail System",
   "symbol": "BTCUSD", "tf": "15m", "kind": "entry", "side": "long", "price": 78777.5,
   "sl": 78402, "tp": [79152.2, 79527, 79901], "score": 77.9, "label": "LONG", "message": "🟢 LONG | DELTA:BTCUSD | ...",
   "source": "alert", "levelsSource": "script", "action": "opened", "positionId": 12 }]
```
`kind` is `entry | exit | info`. `action` is what the paper engine did: `opened | closed | reduced | ignored | rejected:<reason>`.

`GET /api/positions` → open positions
```json
[{ "id": 12, "scannerId": "reactive-trail-system", "scannerName": "...", "symbol": "BTCUSD", "tf": "15m", "side": "long",
   "qty": 12, "qtyOpen": 8, "contractValue": 0.001, "entryPrice": 78777.5, "entryAt": 1, "sl": 78777.5, "slOriginal": 78402,
   "tp": [79152.2, 79527, 79901], "tpHit": [true, false, false], "breakEven": true,
   "markPrice": 79000, "unrealizedPnl": 1.78, "realizedPnl": 1.5, "fees": 0.6, "riskAmount": 1000, "rMultiple": 0.6 }]
```
`POST /api/positions/:id/close` → closes at market (paper). `POST /api/paper/close-all`.

`GET /api/trades?limit=200&scanner=<id>&symbol=` → closed trades newest first
```json
[{ "id": 7, "positionId": 12, "scannerId": "...", "scannerName": "...", "symbol": "BTCUSD", "tf": "15m", "side": "long",
   "qty": 12, "entryPrice": 1, "exitPrice": 1, "entryAt": 1, "exitAt": 1, "pnl": 12.3, "pnlPct": 0.4, "fees": 0.6,
   "rMultiple": 1.2, "exitReason": "tp3 | sl | be | script_exit | reversal | manual | tp_partial",
   "fills": [{ "at": 1, "price": 1, "qty": 4, "reason": "tp1" }] }]
```

`GET /api/orders?limit=200` → fills/executions log `[{ "id", "at", "positionId", "scannerId", "symbol", "side": "buy|sell", "qty", "price", "fee", "reason" }]`

`GET /api/stats` →
```json
{ "equity": 101234.5, "initialEquity": 100000, "realizedPnl": 1100, "unrealizedPnl": 134.5, "fees": 22.1,
  "openPositions": 3, "trades": 52, "wins": 28, "losses": 24, "winRatePct": 53.8, "profitFactor": 1.4,
  "maxDrawdownPct": 2.1, "todayPnl": 210.3, "byScanner": { "<id>": { "...same stats fields as scanner.stats..." } },
  "bySymbol": { "BTCUSD": { "trades": 30, "pnl": 800 } } }
```

`GET /api/equity?scanner=<id>&limit=2000` → `[{ "at": 1, "equity": 100000, "realized": 0, "unrealized": 0 }]` (global when no scanner).

`POST /api/paper/reset` → wipes positions/trades/equity (keeps signals) and restarts at `initialEquity`.

`GET /api/backtest?scanner=<id>&symbol=BTCUSD&tf=15m` → last warm-backtest result for that scanner
`{ "at", "bars", "trades": [ ...trade objects... ], "stats": { ... }, "equity": [ {at, equity} ] }`

`POST /api/backtest/run` body `{ "scanner": id, "symbol", "tf" }` → re-runs and returns the same shape.

`GET /api/analytics` → `{ at, symbols: [{ symbol, backtest: Agg, live: Agg, scannersOn, profitableScanners, openPositions, unrealized }], scanners: [{ id, name, author, symbols, backtest: Agg, live: Agg, openPositions }], matrix: [{ scannerId, scannerName, symbol, backtest: Agg, live: Agg|null }], exits: [{ reason, ...Agg }], hours: [{ hour, live, backtest }], weekdays: [{ dow, live, backtest }], totals }` where `Agg = { trades, wins, winRatePct, pnl, fees, profitFactor }`. Backtest figures cover enabled scanners on their configured symbols only.

`GET /api/ml` → `{ trainedAt, samples, liveSamples, scannersWithModel, global: { model: {holdout, accuracy, auc, logLoss, baseWinRate}, importance: [{feature,label,weight}], rules: [...], baseline }, scanners: [{ scannerId, scannerName, samples, liveSamples, baseline, model, importance, rules }], counts, config }`
`POST /api/ml/train` → trains now, returns the same shape. `GET /api/ml/scanner/:id`, `GET /api/ml/samples?scanner=&limit=`.
Rule shape: `{ feature, label, kind: "prefer"|"avoid", condition, n, coverage, winRate, avgR, baselineAvgR, lift, text }`. Signals carry `mlProb`; config has `ml: { minProb, useAsScore }`.

`GET /api/logs?limit=200&level=info` → `[{ "at", "level": "debug|info|warn|error", "scope": "feed|scanner|paper|api", "msg", "data" }]`

## Operations

`GET /api/metrics` → Prometheus text exposition (`Content-Type: text/plain; version=0.0.4`). Also served at `/metrics`. `?format=json` returns the same values as a JSON object. Names are prefixed `vnedge_`:

| metric | type | meaning |
|---|---|---|
| `bars_closed_total{symbol,tf}` | counter | bar closes announced to scanners |
| `script_runs_total{status="ok"\|"error"}`, `script_runs_per_minute`, `script_errors_per_minute` | counter / gauge | Pine runs and failures |
| `signals_total{kind,action}`, `trades_closed_total{result}`, `fills_total` | counter | signals, closed trades, fills |
| `feed_connected`, `feed_last_tick_age_seconds`, `feed_status_changes_total{connected}` | gauge / counter | websocket state |
| `worker_queue_depth`, `worker_busy`, `worker_pool_size`, `worker_respawns` | gauge | worker pool |
| `open_positions`, `paper_equity`, `paper_realized_pnl`, `paper_unrealized_pnl`, `paper_drawdown_from_peak_pct`, `backtests_total` | gauge | account |
| `candle_gaps_found_total`, `candle_gaps_filled_total`, `candle_integrity_events_total{type}`, `clock_drift_ms` | gauge / counter | candle integrity |
| `alerts_sent_total`, `alerts_active`, `backup_last_timestamp_seconds`, `backup_failures_total`, `db_size_bytes`, `db_errors_total`, `log_file_bytes`, `log_entries_total{level}` | gauge / counter | ops |
| `process_resident_memory_bytes`, `process_heap_used_bytes`, `process_cpu_percent`, `process_uptime_seconds`, `event_loop_lag_p50_ms`, `event_loop_lag_p99_ms`, `event_loop_lag_max_ms` | gauge | process |

`GET /api/ops` → the `{ integrity, alerts, ops }` block of `/api/health`.

`GET /api/ops/integrity` → integrity counters plus `series: [{ symbol, tf, bars, loaded, lastBarTime, lastClosedAt, loadedAt, gaps: [<missing bar start ms>…] }]`.
`POST /api/ops/integrity/check` → resyncs every tracked series (gap backfill), re-measures clock drift and re-checks symbols now: `{ filled: { "BTCUSD:15m": 2 }, driftMs, symbols: { delisted, changed }, integrity }`.

`GET /api/ops/backups` → backup status plus `files: [{ file, bytes, at }]` newest first.
`POST /api/ops/backup` → snapshot now: `{ file, bytes, at, ms, pruned: [...], status }`.

`GET /api/ops/alerts` → alert status, `recent: [{ at, key, text, delivered, error? }]` (newest first, last 20) and the monitor state.
`POST /api/ops/alerts/test` body `{ "text": "hello" }` sends a message (`{ delivered, configured, lastSent }`); `{ "evaluate": true }` runs the condition evaluation immediately and returns the alert status; `{ "summary": true }` sends the daily summary now.

`POST /api/ops/logs/rotate` → rotates `data/logs/vnedge.log` now; returns the log file stats.

Alert keys used by the monitor: `feed.disconnected`, `workers.crashloop`, `workers.queue`, `paper.drawdown`, `candles.stale`, `disk.low`, `db.errors`.

## Server-Sent Events

`GET /api/events` — `text/event-stream`. Each message has `event:` name and `data:` JSON.

| event      | data                                                        |
|------------|-------------------------------------------------------------|
| `hello`    | `{ now, health }`                                           |
| `tick`     | `{ symbol, price, time }` (throttled to ~2/s per symbol)    |
| `candle`   | `{ symbol, tf, bar: {time,open,high,low,close,volume}, closed: bool }` |
| `signal`   | a signal object (see `/api/signals`)                        |
| `position` | `{ type: "opened"|"updated"|"closed", position }`           |
| `trade`    | a closed trade object                                       |
| `order`    | an order fill object                                        |
| `scanner`  | `{ id, lastRun, stats }`                                    |
| `stats`    | the `/api/stats` object (every ~5 s and after each trade)   |
| `health`   | the `/api/health` object (every ~10 s)                      |
| `log`      | a log entry                                                 |

Clients should reconnect with backoff; the server sends `: ping` comments every 15 s.
