# VNEdge architecture

```
Delta Exchange India ──REST (history, products, tickers)──┐
   wss://socket.india.delta.exchange ──candlestick_*/ticker─┤
        (all_trades / mark_price / funding_rate ───────────┼──► MarkStore + PaperEngine tape path)
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
                              RiskManager (kill switches, caps, cooldown, regime, dd scaling, beta cap)
                                          │ gate() / exposureCheck()
                                          ▼
                    PaperEngine (live, SQLite)   ←── tape prints (or 1m candles) ──  fills: liq(mark) → SL → TP1/2/3 → BE, funding
                    Backtester (in-memory, same logic.ts)
                                          │ order / position events
                                          ├──► ExchangeExecutor (dry-run | demo): market mirror, reduce-only brackets, reconciliation
                                          ▼
                              ApiServer (REST + SSE) ──► dashboard (Vite/React + Vela chart)
```

## Components (server/src)

| Module | Responsibility |
|---|---|
| `config.ts` | Defaults, validation, persisted `data/config.json`, timeframe maps (Delta ↔ Pine). |
| `delta/rest.ts` | Dependency-free REST client (public + HMAC-signed), candle paging. |
| `delta/ws.ts` | Websocket feed with reconnect, subscription replay, heartbeat watchdog. Channels: `candlestick_*`, `v2/ticker`, `all_trades` (tape → `trade`), `mark_price` (`MARK:` symbols → `mark`), `funding_rate` (→ `funding`). |
| `data/marks.ts` | `MarkStore`: exchange mark price and funding state per symbol; `dueFunding()` hands out one charge per 8 h realization slot. |
| `data/candleStore.ts` | Backfill + live merge; emits `bar` (forming) and `closed` exactly once per bar. |
| `pine/patches.ts` | Source-level compatibility rewrites for PineTS (listed per scanner in the API). |
| `pine/provider.ts` | PineTS `IProvider` over Delta candles incl. `request.security()` timeframes (monthly aggregated from daily). |
| `pine/worker.ts` / `pool.ts` | Isolated script execution with timeouts and crash recovery. |
| `scanners/registry.ts` | Loads `scripts/manifest.json` + Pine sources, categories, patch application. |
| `scanners/extractor.ts` | Parses the scripts' structured `alert()` messages and plotshapes into events. |
| `scanners/engine.ts` | Orchestrates runs on bar close, dedupes signals, warm-up backtests, overlays. |
| `paper/logic.ts` | Pure fill logic: levels, sizing, TP legs, break-even, stats. |
| `paper/engine.ts` | Live paper account persisted to SQLite (`node:sqlite`). `fillSource: tape` adds pending entries (latency), print-driven stops/targets, mark-price liquidation, funding charges and the 1m-candle fallback. |
| `risk/manager.ts` | Portfolio risk layer (phase 3): daily/weekly kill switch, manual halt, position caps, per-scanner budget, cooldown, drawdown-scaled sizing, regime filter, BTC-beta exposure cap (`risk/correlation.ts`). State in the kv table. |
| `risk/routes.ts` | `/api/risk*`, `/api/execution*`, `/api/marks` (registered through `api/extensions.ts`). |
| `execution/client.ts` | Exchange transports: `RestTransport` (demo host; production only via `allowProduction` + `DELTA_LIVE=1`, then market orders / reduce-only exits only) and `DryRunTransport` (records payloads). |
| `execution/wiring.ts` | Feed → engine wiring for the tape/mark/funding channels and the 5 s scheduler (funding charges, pending-entry expiry, risk ticks). |
| `paper/backtest.ts` | Deterministic bar-level replay with the same logic. |
| `execution/testnet.ts` | `ExchangeExecutor` (phase 5): mirrors entries/discretionary exits as market orders, places reduce-only stop + take-profit brackets per paper position (replaced on break-even / partial fills), reconciles exchange positions and open orders on a timer, emergency close-all. Off in `paper` mode. |
| `api/server.ts` | HTTP router, SSE broadcaster, static dashboard hosting. |
| `api/extensions.ts` | One-line registration of feature-module routes (`validation/routes.ts`). |
| `data/candleCache.ts` | SQLite candle cache (`candles` table): pages Delta REST in 4,000-bar chunks, sequential per symbol with delays, serves 60–90 days without refetching; deep source for warm backtests (`validation.history.backtestBars`). |
| `validation/walkForward.ts` | Rolling train/test windows over a long history, each replayed with `runBacktest`; in-sample selection → out-of-sample aggregation, positive weeks, de-duplicated trades. |
| `validation/service.ts` | Runs walk-forward for every scanner×symbol×tf, persists `walk_forward`, feeds OOS summaries to the engine's auto-tune. |
| `validation/shadow.ts` | Two in-memory paper ledgers (`ungated`, `ml-gated`) fed by the engine's `signal` events and 1m bars through the same `logic.ts` fills. |
| `validation/consensus.ts` | Optional entry filter: N distinct scanners must agree on side/symbol/tf within a window. |
| `pine/inputs.ts` | Parses `input.*()` declarations from Pine; validates per-scanner overrides that the worker applies through PineTS's `Indicator.input`. |
| `ml/model.ts` / `ml/service.ts` | Logistic regression with a time-ordered holdout, Platt calibration, reliability buckets, and live feature-drift monitoring. |
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
* **Tape mode** (`paper.fillSource: "tape"`): an entry becomes *pending* and fills at the first `all_trades` print after signal time + `latencyMs`; stops trigger on the last trade and fill at that print (a stop-market can fill through a gap); TP legs are resting limits that fill at their level once a print goes beyond it (`limitFill: through`) or touches it (`touch`); liquidation is checked against the exchange **mark price**; funding (`rate × notional`, sign by side) is charged at every 8 h realization; market fills add `notional / depthUsdPerBp` bps of impact. When no print arrives for `tapeFallbackMs` the 1m candle path takes over (only movement since the last print counts). `candles` (default) reproduces the legacy behaviour exactly.

## Risk layer

Every entry passes `RiskManager.gate()` inside `PaperEngine.onEntry` (after level/fee checks, before sizing) and `exposureCheck()` after sizing. Rejections are written to the signal as `rejected:risk <reason>` and listed under `GET /api/risk`. The layer never touches open positions except when `closeAllOnKill` or a manual kill with `closeAll` flattens the book.

## Execution path

`paper` → nothing leaves the process. `dry-run` → the executor runs with a transport that logs every payload (`GET /api/execution` shows them) and, if demo keys are present, still reads positions/orders for reconciliation. `testnet` → orders go to the demo host. The production host is unreachable unless `execution.allowProduction: true` **and** `DELTA_LIVE=1`; the transport then refuses any order that is not a plain market order and any non-entry order that is not reduce-only, so the bot can never leave resting orders on a real account.

## Validation loop (Phase 1)

```
CandleCache (SQLite, 60–90 d)  ──bars──▶  PinePool (one run per scanner×symbol×tf over the whole history)
                                             │ events (alerts, shapes, derived rules)
                                             ▼
                        walkForward(): windows [train 10 d | test 3 d] rolled daily
                                             │ per window: runBacktest(train) → selected?  runBacktest(test)
                                             ▼
                 walk_forward table ──▶ ScannerEngine.autoTune({ oos })  ──▶ scanners.<id>.symbols / timeframes
```

* **Honest numbers**: `outOfSample` only counts test windows whose preceding training window the tuner would have selected, so it is the return of *following the tuner*, not of the script. `outOfSampleAll` is the unconditional figure. Overlapping test windows are de-duplicated by entry time.
* **Auto-tune skips unmeasured scanners**: a scanner with no backtest for any of its pairs is reported as `skipped` and left untouched. Enabling a scanner starts a background warm-up and then a tune; without this, a tune triggered by a later enable would see the earlier one at zero trades and disable it.
* **Auto-tune rules**: in-sample (default, unchanged behaviour) or OOS (`autoTune.oos.enabled`): keep a pair when OOS trades ≥ min, PF ≥ min, positive weeks ≥ min and pnl > 0. Missing walk-forward data → in-sample fallback marked `provisional` in the report. `autoTune.tuneTimeframes` evaluates every (symbol, tf) pair and tunes both lists.
* **Deep warm backtests**: `validation.history.backtestBars` > `historyBars` makes the engine run the *backtest* over cached history; the live run always uses the in-memory bars (a second, short script run when both are needed in one warm-up).
* **Shadow accounts** subscribe to the engine's `signal` events and the candle store's 1m `bar`/`closed` events; nothing is written to the live tables (the ledger is snapshotted in `kv`).
* **Consensus** is an `EntryFilter` the engine calls before the ML gate and the paper engine; off by default.

## Scanner quality (Phase 6)

* **ML**: `trainLogReg` fits on the oldest 80 % of samples by time and reports every metric on the newest 20 %, fits Platt scaling on that holdout and stores reliability buckets before/after; `MlService.score()` returns the calibrated probability and records the feature vector in a 200-sample ring used by `drift()` (per-feature mean/std vs. the training distribution).
* **Script inputs**: `scanners.<id>.inputs` travels in the `WorkerJob`; the worker builds a PineTS `Indicator`, writes each override through `indicator.input[name|title]` (validated by PineTS) and runs it. Invalid overrides fail the run loudly.
* **Generic rules** (`scanners.<id>.rule`): `trailing` picks the overlay series that behaves like a trailing stop (title hint, else the one the close crosses least often; complementary up/down plots are merged) and enters on flips with the trail as the stop; `oscillator` picks the pane series and uses zero-line crosses or OB/OS exits based on its range. Plot data is requested for the whole history when a generic rule is configured.

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

`data/vnedge.db` (WAL) holds signals, positions, orders, equity curve, last runs, backtests, the candle cache (`candles`), walk-forward results (`walk_forward`), ML samples and, in `kv`, the ML models, live feature ring and shadow ledgers.
`data/config.json` holds user settings. Delete the DB to start clean, or use *Reset paper account*.
`data/vnedge.db` (WAL) holds signals, positions, orders, equity curve, last runs and backtests.
`data/config.json` holds user settings (including `ops` and `alerts`). Delete the DB to start clean, or use *Reset paper account*.
`data/backups/` holds nightly snapshots, `data/logs/` the rotated application log (and supervisor stdout/stderr).
