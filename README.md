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
| `npm test` | unit tests (alert parser, paper fill logic) |
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
  Signals, Positions & Trades, Chart, Learn, Settings, Logs — live via Server-Sent Events.

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
`VNEDGE_SYMBOLS`, `VNEDGE_TIMEFRAMES`, `LOG_LEVEL`, `VNEDGE_DATA_DIR`.

### Optional: mirror paper fills to the Delta India demo account

Create API keys on the **demo** site (<https://demo-india.delta.exchange>), then:

```bash
DELTA_API_KEY=… DELTA_API_SECRET=… npm start
```

and set `"execution": { "mode": "testnet" }`. Fills are sent as market orders to the
testnet host only (`cdn-ind.testnet.deltaex.org`); production keys are never used.

## Repository layout

```
server/      Node/TypeScript bot: feed, PineTS workers, scanners, paper engine, REST+SSE API
dashboard/   Vite + React dashboard (Vela chart)
scripts/     Pine sources (scripts/pine/*.pine), manifest.json, compat-report.json
docs/        API.md (contract), ARCHITECTURE.md, SCANNERS.md
data/        runtime: vnedge.db, config.json, logs/   (git-ignored)
```

## Notes & limitations

* Paper fills are bar-based (1-minute resolution) and resolve SL before TP on ambiguous
  bars — conservative versus TradingView's tick-level fills.
* PineTS is a re-implementation of Pine; a handful of built-ins behave differently. The
  patches in `server/src/pine/patches.ts` document every deviation VNEdge works around.
* This is a research/paper-trading tool, not investment advice. Nothing here places real
  orders unless you deliberately enable the demo-account mirror.
