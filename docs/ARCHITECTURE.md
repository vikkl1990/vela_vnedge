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
| `api/server.ts` | HTTP router, SSE broadcaster, static dashboard hosting. |

## Signal semantics

* Scripts run on **closed bars only**; the forming bar is never fed to a script, so a signal is
  emitted once, right after the bar that produced it closes (TradingView "once per bar close").
* Alerts are parsed generically: a leading 🟢/🔴 plus LONG/BUY/SHORT/SELL words → entry; `SL:`,
  `TP1..3:` (or `TP:`) → levels; `TP1 HIT`, `SL HIT`, `BE STOP-OUT`, `REVERSAL`, SATS `flip_exit` → exits.
* Scripts that only draw `plotshape(Buy/Sell)` fall back to shape hits; missing levels use
  ATR(14): SL = 1.5×ATR, TP = 1R/2R/3R (configurable).
* One position per scanner×symbol×timeframe; an opposite signal reverses when `allowReversal`.

## Paper fills

* Entry at signal price (or bar close) ± slippage; taker fee (0.05 % default) on every fill.
* Every 1-minute candle update of the symbol is applied to open positions: SL first (worst case),
  then sequential TP legs (40/30/30 % default), SL → entry after TP1 when `breakEvenAfterTp1`.
* Script exits are honoured according to the scanner's `exitMode` (`levels`, `script`, `both`).

## Data & persistence

`data/vnedge.db` (WAL) holds signals, positions, orders, equity curve, last runs and backtests.
`data/config.json` holds user settings. Delete the DB to start clean, or use *Reset paper account*.
