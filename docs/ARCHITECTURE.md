# VNEdge architecture

```
Delta Exchange India ──REST (history, products, tickers)──┐
   wss://socket.india.delta.exchange ──candlestick_*/ticker─┤
                                                            ▼
                                                   CandleStore (per symbol×tf ring buffer)
                                                     │ 'closed' bar events
                                                     ▼
                                      ScannerEngine (scanner × symbol × tf)
                                          │ job {patched Pine source, closed bars}
                                          ▼
                                 PinePool → worker_threads → PineTS runtime
                                          │ alerts / plotshapes / labels / plots
                                          ▼
                                     extractor.ts  (alert-message parser)
                                          │ ScanEvent {entry|exit|info, side, price, sl, tp[], score}
                                          ▼
                    PaperEngine (live, SQLite)   ←──1m candles──  fills: SL → TP1/2/3 → BE
                    Backtester (in-memory, same logic.ts)
                                          │
                                          ▼
                              ApiServer (REST + SSE) ──► dashboard (Vite/React + Vela chart)
```

## Components (server/src)

| Module | Responsibility |
|---|---|
| `config.ts` | Defaults, validation, persisted `data/config.json`, timeframe maps (Delta ↔ Pine). |
| `delta/rest.ts` | Dependency-free REST client (public + HMAC-signed), candle paging. |
| `delta/ws.ts` | Websocket feed with reconnect, subscription replay, heartbeat watchdog. |
| `data/candleStore.ts` | Backfill + live merge; emits `bar` (forming) and `closed` exactly once per bar. |
| `pine/patches.ts` | Source-level compatibility rewrites for PineTS (listed per scanner in the API). |
| `pine/provider.ts` | PineTS `IProvider` over Delta candles incl. `request.security()` timeframes (monthly aggregated from daily). |
| `pine/worker.ts` / `pool.ts` | Isolated script execution with timeouts and crash recovery. |
| `scanners/registry.ts` | Loads `scripts/manifest.json` + Pine sources, categories, patch application. |
| `scanners/extractor.ts` | Parses the scripts' structured `alert()` messages and plotshapes into events. |
| `scanners/engine.ts` | Orchestrates runs on bar close, dedupes signals, warm-up backtests, overlays. |
| `paper/logic.ts` | Pure fill logic: levels, sizing, TP legs, break-even, stats. |
| `paper/engine.ts` | Live paper account persisted to SQLite (`node:sqlite`). |
| `paper/backtest.ts` | Deterministic bar-level replay with the same logic. |
| `execution/testnet.ts` | Optional mirror of paper fills to the Delta **demo** account (off by default). |
| `api/server.ts` | HTTP router, SSE broadcaster, static dashboard hosting. `api/extensions.ts` lists route modules (one line per phase). |
| `log.ts` | Console (text or `LOG_FORMAT=json`), ring buffer for `/api/logs`, size-rotated `data/logs/vnedge.log`, per-level counters. |
| `db.ts` | SQLite schema + helpers; Phase 4 adds `backup()` (`VACUUM INTO`), retention pruning, `integrityCheck()`, statement-error counters. |
| `ops/service.ts` | Composition of the ops modules below; `status()` feeds `/api/health`; `shutdown()` drains in-flight script runs with a timeout. |
| `ops/metrics.ts` | Dependency-free Prometheus registry (counters, sampled gauges, event-loop lag, CPU). |
| `ops/alerts.ts` | Telegram transport, per-key de-duplication, repeat interval, hourly cap, "resolved" notes. Token never logged. |
| `ops/monitor.ts` | Alert conditions on a 15 s timer (feed, crash loop, queue depth, drawdown, stale bars, disk, db errors), daily summary, per-trade notes. |
| `ops/backup.ts` | Nightly snapshot scheduler with persisted last-run and on-demand runs. |
| `ops/workers.ts` | Worker factory handed to `PinePool` so respawns can be counted without touching the pool. |
| `ops/routes.ts` | `/api/metrics`, `/api/ops/*`; `attachRawMetrics` serves the text exposition ahead of the JSON router. |

## Signal semantics

* Scripts run on **closed bars only**; the forming bar is never fed to a script, so a signal is
  emitted once, right after the bar that produced it closes (TradingView "once per bar close").
* Alerts are parsed generically: a leading 🟢/🔴 plus LONG/BUY/SHORT/SELL words → entry; `SL:`,
  `TP1..3:` (or `TP:`) → levels; `TP1 HIT`, `SL HIT`, `BE STOP-OUT`, `REVERSAL`, SATS `flip_exit` → exits.
* `scanners/rules.ts` derives entries for scripts that never phrase a trade call: AMD Po3
  (`DIST ▲/▼` with Entry/Stop/Target), Adaptive Pivot Structure (CHoCH reversals), Adaptive
  Squeeze Momentum (`SQUEEZE FIRED · Direction`), Daily Volume Profile (80% rule + target),
  Automatic Fibonacci Levels (`ENTRY ZONE`, direction/targets from TP labels), Auto S/R
  Channels (`Breakout ▲/▼` + 🎯 label), Structure-Anchored VWAP (HL/LH labels, confirmed
  5 bars after the pivot in backtests, on first appearance live), Elliott Impulse (live only:
  projection labels give stop and targets). Bitcoin Almanac (cycle timing) and Trade Strategy
  Calculator (a sizing tool) have nothing tradeable and stay informational.
* Scripts that only draw `plotshape(Buy/Sell)` fall back to shape hits; missing levels use
  ATR(14): SL = 1.5×ATR, TP = 1R/2R/3R (configurable).
* One position per scanner×symbol×timeframe; an opposite signal reverses when `allowReversal`.

## Paper fills

* Entry at signal price (or bar close) ± slippage; taker fee (0.05 % default) on every fill.
* Every 1-minute candle update of the symbol is applied to open positions: SL first (worst case),
  then sequential TP legs (40/30/30 % default), SL → entry after TP1 when `breakEvenAfterTp1`.
* Script exits are honoured according to the scanner's `exitMode` (`levels`, `script`, `both`).

## Candle integrity

* `CandleStore` keeps `lastClosedEmitted` per series; `closed` is emitted only for a bar time above
  it, which makes the event exactly-once even when REST and websocket deliver the same bar.
* A websocket bar that jumps more than one timeframe, a reconnect `resync`, the initial backfill and
  a one-minute maintenance timer all run `findGaps` (missing grid times between consecutive bars)
  and backfill from `/v2/history/candles`. Bars REST cannot supply (no trades in that period) are
  remembered as unfillable and reported once. After a fill or resync, the newest closed bar is
  announced once if it was never announced, so scanners re-run over the repaired history; inner gap
  bars are not announced (scripts always run on the full history anyway).
* Clock drift = local time minus exchange timestamps (websocket tickers continuously, REST ticker
  with half the round trip every two minutes); above `ops.driftWarnMs` an `integrity` event and a
  warning are raised (at most every 5 min).
* Symbol lifecycle: every 10 min tracked symbols are checked against `/v2/products` (confirmed with
  the single-product endpoint, since the list is paged); a missing symbol raises `delisted`, a
  changed tick size or contract value raises `tick-size` (restart to apply, `marketInfo` is cached).

## Operations

* **Supervision**: `ops/launchd/com.vnedge.server.plist` (KeepAlive, RunAtLoad, 10 s throttle,
  45 s exit timeout) via `ops/install-launchd.sh`; `ops/pm2.config.cjs` for pm2.
* **Shutdown**: SIGTERM/SIGINT → `OpsService.shutdown()`: timers off, wait ≤ `ops.shutdownTimeoutMs`
  for busy workers and the queue, `App.stop()`, log flush; a hard exit fires 10 s after the timeout.
* **Alerts**: conditions are evaluated regardless of configuration (they show in `/api/health`
  and metrics); messages go out only when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` or
  `alerts.telegram` are set. Keyed conditions send once on raise, repeat every
  `alerts.repeatMinutes`, and send one note on clear; `alerts.maxPerHour` caps everything.
* **Backups**: `VACUUM INTO data/backups/vnedge-<stamp>.db` at `ops.backupHourUtc` (a minute-level
  scheduler catches up after downtime), pruned after `ops.backupKeepDays`.
* **Metrics**: `GET /api/metrics` (text) is served by a request wrapper installed in `index.ts`
  because the route hook cannot set headers; the same path answers JSON with `?format=json`.

## Data & persistence

`data/vnedge.db` (WAL) holds signals, positions, orders, equity curve, last runs and backtests.
`data/config.json` holds user settings (including `ops` and `alerts`). Delete the DB to start clean, or use *Reset paper account*.
`data/backups/` holds nightly snapshots, `data/logs/` the rotated application log (and supervisor stdout/stderr).
