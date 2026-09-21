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
  "lastError": null }
```

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
  "autoTune": { "enabled": true, "minTrades": 3, "minProfitFactor": 1, "intervalHours": 6,
                "oos": { "enabled": false, "minTrades": 10, "minProfitFactor": 1.1, "minPositiveWeeks": 2 },   // walk-forward OOS gate
                "tuneTimeframes": false },                                                                   // also tune per-scanner timeframe lists
  "validation": {
    "history":     { "enabled": true, "days": 60, "chunkBars": 4000, "delayMs": 250, "backtestBars": 0 },  // SQLite candle cache; backtestBars > historyBars = deeper warm backtests
    "walkForward": { "days": 60, "trainDays": 10, "testDays": 3, "stepDays": 1, "autoRun": false },
    "consensus":   { "enabled": false, "minScanners": 2, "windowBars": 1 },
    "shadow":      { "enabled": true, "minProb": 0.55 } },
  "scanners": { "<scannerId>": { "enabled": true, "symbols": null, "timeframes": null, "exitMode": "both",
                                 "rule": null,                      // "trailing" | "oscillator" | null (generic derivation rule)
                                 "inputs": { "maLenInput": 34 } } } } // per-script Pine input overrides (PUT /api/scanners/:id/inputs)
```

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

`POST /api/scanners/auto-tune` body `{ "minTrades": 3, "minProfitFactor": 1 }` → restricts every enabled scanner to the symbols where its backtest is profitable (pnl > 0, PF ≥ min, trades ≥ min); scanners with no qualifying symbol are disabled. Returns `{ tuned, disabled, report: [{ id, name, before, after, disabled, dropped: [{symbol, trades, pnl}] }] }`. Report entries also carry `rule`, `provisional`, `beforeTimeframes`, `afterTimeframes` and `decisions` (see `POST /api/validation/auto-tune`, which is the OOS-aware form).

`GET /api/scanners/:id/inputs` → the script's `input.*` declarations and the current overrides:
```json
{ "id": "reactive-trail-system", "name": "...", "overrides": { "maLenInput": 34 }, "errors": [],
  "declarations": [{ "name": "maLenInput", "title": "Baseline Length", "type": "int", "default": 21, "min": 5, "max": 200, "step": 1, "group": "Baseline", "tooltip": "...", "line": 12 },
                   { "name": "maTypeInput", "title": "Baseline MA Type", "type": "string", "default": "ALMA", "options": ["SMA","EMA","ALMA"], "line": 11 }] }
```
`type` is `int | float | bool | string | source | color | timeframe | session | symbol | text_area | price | time | enum`. `errors` lists stored overrides that no longer validate against the source.

`PUT /api/scanners/:id/inputs` body `{ "inputs": { "<name or title>": value } }` → validates (unknown names, types, minval/maxval, options), stores the coerced map as `scanners.<id>.inputs` (an empty object clears all overrides) and re-runs the scanner (backtest + live) with the new values. Returns `{ ok: true, overrides, queued }` or `{ ok: false, errors: ["maLenInput: 999 is above maxval 200", "unknown input \"nope\""], overrides }` (HTTP 200). PineTS validates again at run time; a rejected override makes the run fail with `lastRun.error = "input overrides rejected: …"` instead of silently using the default.

`GET /api/scanners/:id/rule` → `{ id, rule: "trailing"|"oscillator"|null, available: ["trailing","oscillator"], candidates: { trailing: { title, flips, merged } | null, oscillator: { title, mode: "zero"|"obos", ob, os, crosses } | null }, sampled: { symbol, tf, plots: [{ title, style, overlay }] } | null }` — which plot each generic rule would pick from the last overlay run.

`PUT /api/scanners/:id/rule` body `{ "rule": "trailing" | "oscillator" | null }` → sets the generic derivation rule (replaces any per-script rule) and re-runs the scanner. `trailing`: entries when the close flips to the other side of the trailing-stop/SuperTrend overlay, the trail is the stop. `oscillator`: zero-line crosses, or leaving oversold (long) / overbought (short) on the pane oscillator; stops/targets from ATR.

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

`GET /api/ml` → `{ trainedAt, samples, liveSamples, scannersWithModel, global: { model: Metrics, calibration: { a, b } | null, importance: [{feature,label,weight}], rules: [...], baseline }, scanners: [{ scannerId, scannerName, samples, liveSamples, baseline, model: Metrics, calibration, importance, rules }], drift, counts, config }`
`POST /api/ml/train` → trains now, returns the same shape. `GET /api/ml/scanner/:id`, `GET /api/ml/samples?scanner=&limit=`.
Rule shape: `{ feature, label, kind: "prefer"|"avoid", condition, n, coverage, winRate, avgR, baselineAvgR, lift, text }`. Signals carry `mlProb` (calibrated); config has `ml: { minProb, useAsScore }`.

`Metrics` (walk-forward: the model is fitted on the oldest 80 % of samples and every number below comes from the newest 20 %):
```json
{ "holdout": 60, "accuracy": 0.62, "auc": 0.71, "logLoss": 0.66, "baseWinRate": 0.48,
  "walkForward": { "trainN": 240, "testN": 60, "trainTo": 1789900000000, "testFrom": 1789901000000, "testTo": 1789950000000 },
  "brier": 0.24, "brierCalibrated": 0.23, "logLossCalibrated": 0.65,
  "reliability":           [{ "lo": 0, "hi": 0.2, "n": 4, "predicted": 0.15, "observed": 0.25 }, "… 5 buckets"],
  "reliabilityCalibrated": [{ "lo": 0, "hi": 0.2, "n": 3, "predicted": 0.17, "observed": 0.33 }, "…"] }
```
`calibration` is a Platt scaling `p' = sigmoid(a·logit(p) + b)` fitted on the holdout and applied by every live score.

`drift` (feature drift: the last 200 live-scored feature vectors versus the global model's training distribution; present even before the first training):
```json
{ "at": 1, "n": 120, "window": 200, "threshold": 0.5, "drifted": 1,
  "features": [{ "feature": "atr_pct", "label": "ATR % of price", "trainMean": 0.42, "trainStd": 0.2, "liveMean": 0.9, "liveStd": 0.3, "shift": 2.4, "drifted": true }, "…"] }
```
`shift` is `(liveMean − trainMean) / trainStd`; a feature is `drifted` when |shift| > threshold and n ≥ 30.

## Validation (walk-forward, candle cache, shadow, consensus)

`GET /api/validation` →
```json
{ "at": 1, "status": { "running": false, "startedAt": 1, "finishedAt": 1, "total": 28, "done": 28, "failed": 0, "current": null, "errors": [{ "key": "id:BTCUSD:15m", "error": "…" }], "lastMs": 12345 },
  "config": { "history": {…}, "walkForward": {…}, "consensus": {…}, "shadow": {…}, "oos": {…}, "tuneTimeframes": false, "autoTune": { "minTrades": 3, "minProfitFactor": 1 } },
  "results": [{ "scannerId", "scannerName", "symbol", "tf", "at", "bars", "from", "to", "windows": 47, "selectedWindows": 21,
                "inSample": Stats, "outOfSample": Stats, "outOfSampleAll": Stats,
                "oosPass": false, "oosFlag": true, "inSamplePass": true, "enabled": true }],
  "history": [{ "symbol", "tf", "status": "idle|fetching|done|error", "bars", "from", "to", "chunks", "fetched", "requestedFrom", "requestedTo", "startedAt", "finishedAt", "error" }],
  "consensus": { "enabled", "minScanners", "windowBars", "votes", "recent": [...] },
  "autoTune": { "at", "reason", "scanners", "disabled", "provisional", "rule": "oos"|"in-sample" } | null }
```
`Stats = { trades, wins, losses, winRatePct, pnl, fees, grossProfit, grossLoss, profitFactor, maxDrawdownPct, avgR, weeks, positiveWeeks, negativeWeeks }`.
Semantics: the history is cut into rolling windows (`trainDays` in-sample, then `testDays` out-of-sample, advanced by `stepDays`). A window is *selected* when its in-sample result passes the auto-tune rule (trades ≥ minTrades, pnl > 0, PF ≥ minProfitFactor). `outOfSample` aggregates only the test windows that followed a selected window — what trading the tuner's picks would have produced; `outOfSampleAll` aggregates every test window. Trades are de-duplicated by entry time (test windows overlap when stepDays < testDays). `oosPass` applies the `autoTune.oos` thresholds; `oosFlag` marks OOS PF < 1; `enabled` says whether the pair is currently traded.

`GET /api/validation/:scanner` → `{ scannerId, scannerName, summaries: [...as above], results: [{ ...summary fields, opts, windows: [{ index, trainFrom, trainTo, testFrom, testTo, inSample: {trades,pnl,profitFactor,winRatePct}, selected, outOfSample: {…} }], trades: [OOS trade objects, newest first, ≤ 300], weekly: [{ week: "2026-W38", from, pnl, trades }] }] }`.

`POST /api/validation/run` body `{ "scanner"?: id, "symbol"?: "BTCUSD", "tf"?: "15m", "days"?: 60, "wait"?: false }` → runs walk-forward validation for every active scanner × symbol × timeframe (or the given subset; an explicit `scanner` runs even when disabled). Default: starts in the background and returns `{ started, jobs, status }`; poll `GET /api/validation`. With `wait: true` it returns `{ jobs, done, failed, ms, status, results }` when finished. Each pair fetches `days` of history through the candle cache (first time only), runs the script once over the whole history and replays every window with the paper engine's backtester.

`GET /api/validation/history` → `{ config, requests, series: [...history entries as above] }` — coverage of the SQLite candle cache (`candles` table) and fetch progress.
`POST /api/validation/history/fetch` body `{ "symbol"?, "tf"?, "days"? }` → pre-fetches deep history for the given (default: every tracked) series in 4,000-bar chunks, sequential per symbol; returns `{ started: [{ symbol, tf, bars }] }`.

`GET /api/validation/shadow` → the two shadow paper accounts that mirror every live signal through the same fill logic on 1m bars:
```json
{ "enabled": true, "since": 1, "initialEquity": 100000, "minProb": 0.55, "at": 1,
  "variants": { "ungated": Variant, "ml-gated": Variant },
  "comparison": { "equityDelta": -120.5, "pnlDelta": -120.5, "tradesDelta": -3, "gatedEntries": 7, "leader": "ungated"|"ml-gated"|"tie" } }
```
`Variant = { equity, realizedPnl, unrealizedPnl, openPositions, entries, gated, rejected: { reason: n }, stats: {…closed-trade stats…}, curve: [{ at, equity }], trades: [trade objects, newest first, ≤ 100], open: [{ id, scannerId, symbol, tf, side, qty, qtyOpen, entryPrice, entryAt, sl, tp, tpHit, mlProb, unrealizedPnl }] }`. `ml-gated` skips entries whose `mlProb < minProb` (signals without a probability are taken). Both variants ignore what the live account did with the signal and apply their own position limits, so the curves differ only by the gate.
`POST /api/validation/shadow/reset` → restarts both ledgers at the current `paper.initialEquity`.

`GET /api/validation/consensus` → `{ enabled, minScanners, windowBars, votes, recent: [{ scannerId, scannerName, symbol, tf, side, barTime, at }] }`. When `validation.consensus.enabled`, a live entry is rejected (`action: "rejected:consensus k/N"`) until `minScanners` distinct scanners have called the same side on the same symbol×tf within `windowBars` bars; the N-th one passes.

`GET /api/validation/auto-tune` → the last auto-tune report (any trigger): `{ at, reason: "warm-up"|"scheduled"|"refresh"|"api"|"manual", report: [{ id, name, before, after, beforeTimeframes, afterTimeframes, disabled, rule: "oos"|"in-sample", provisional, dropped, decisions: [{ symbol, tf: "15m"|null, keep, rule: "oos"|"in-sample"|"provisional", trades, pnl, profitFactor, positiveWeeks, reason }] }] }`.

`POST /api/validation/auto-tune` body `{ "oos"?: true, "tuneTimeframes"?: false, "minTrades"?, "minProfitFactor"? }` (defaults from `autoTune`) → runs auto-tune now and returns `{ tuned, disabled, provisional, rule, report }`. With the OOS rule a scanner×symbol (×timeframe when `tuneTimeframes`) is kept only when its walk-forward **out-of-sample** result has ≥ `oos.minTrades` trades, PF ≥ `oos.minProfitFactor`, ≥ `oos.minPositiveWeeks` positive weeks and pnl > 0; pairs without walk-forward data fall back to the in-sample backtest rule and are marked `provisional`. The automatic runs (after warm-up and every `intervalHours`) use the same logic when `autoTune.oos.enabled`.

`GET /api/logs?limit=200&level=info` → `[{ "at", "level": "debug|info|warn|error", "scope": "feed|scanner|paper|api", "msg", "data" }]`

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
