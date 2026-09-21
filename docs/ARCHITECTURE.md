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

## Data & persistence

`data/vnedge.db` (WAL) holds signals, positions, orders, equity curve, last runs and backtests.
`data/config.json` holds user settings. Delete the DB to start clean, or use *Reset paper account*.
