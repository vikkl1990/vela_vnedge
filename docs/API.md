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
  "timeframes": ["15m"],
  "historyBars": 1000,
  "paper": { "initialEquity": 100000, "riskPerTradePct": 1, "maxLeverage": 10,
             "sizingMode": "risk", "minLeverage": 5, "liquidation": true, "maintenanceMarginPct": 0.5,
             "feeRatePct": 0.05, "makerFeeRatePct": 0.02, "slippageBps": 2, "tpSplit": [0.4, 0.3, 0.3],
             "breakEvenAfterTp1": true, "allowReversal": true, "fallbackAtrSl": 1.5,
             "fallbackRR": [1, 2, 3], "maxOpenPositions": 20 },
  "execution": { "mode": "paper" },
  "scanners": { "<scannerId>": { "enabled": true, "symbols": null, "timeframes": null, "exitMode": "both" } } }
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
