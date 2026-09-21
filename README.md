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
* **Honest validation** (`docs/ARCHITECTURE.md` → Validation loop): a SQLite **candle cache** pages
  60–90 days of history from Delta (4,000-bar chunks), **walk-forward validation** replays every
  scanner × pair over rolling train/test windows and reports in-sample vs out-of-sample stats and
  positive weeks (`GET /api/validation`, `POST /api/validation/run`), and auto-tune can be switched
  to the **out-of-sample rule** (`autoTune.oos`) with per-decision reporting (`provisional` when a
  pair has no walk-forward data yet). Two **shadow paper accounts** (`ungated` vs `ml-gated`) run
  beside the live one on the same signals and fills (`GET /api/validation/shadow`). Optional
  **consensus** entry filter (`validation.consensus`).
* **Scanner quality**: per-script Pine **input overrides** (`GET/PUT /api/scanners/:id/inputs`),
  generic **trailing-stop** and **oscillator** derivation rules for silent scripts
  (`PUT /api/scanners/:id/rule`), per-scanner **timeframe tuning** (`autoTune.tuneTimeframes`), and
  ML **probability calibration** (Platt), reliability buckets and live **feature-drift** monitoring
  in `GET /api/ml`.
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
    "fallbackAtrSl": 1.5, "fallbackRR": [1, 2, 3], "maxOpenPositions": 20,
    "fillSource": "candles",          // "tape": fill on Delta's trade stream with latency, resting TP limits, mark-price liquidation
    "limitFill": "through", "depthUsdPerBp": 0, "latencyMs": 1500, "tapeFallbackMs": 5000, "fundingCharges": true
  },
  "execution": { "mode": "paper", "bracket": true, "reconcileSec": 60, "allowProduction": false },   // paper | dry-run | testnet
  "risk": {                           // portfolio risk layer, see docs/calculations.md
    "enabled": true, "maxDailyLossPct": 15, "maxWeeklyLossPct": 30, "closeAllOnKill": false,
    "maxPositionsTotal": 8, "maxPositionsPerSymbol": 2, "perScannerMaxPositions": 4, "perScannerDailyLossPct": 0,
    "maxBetaExposurePct": 0, "corrBars": 20, "cooldownAfterLosses": 0, "cooldownMinutes": 120,
    "ddScale": [{ "ddPct": 10, "leverageMult": 0.5 }],
    "regime": { "enabled": true, "minAtrPct": 0.30, "noWeekend": true, "exempt": [] }
  },
  "execution": { "mode": "paper" },
  "autoTune": { "enabled": true, "minTrades": 3, "minProfitFactor": 1, "intervalHours": 6,
                "oos": { "enabled": false, "minTrades": 10, "minProfitFactor": 1.1, "minPositiveWeeks": 2 }, "tuneTimeframes": false },
  "validation": {
    "history": { "enabled": true, "days": 60, "chunkBars": 4000, "delayMs": 250, "backtestBars": 0 },
    "walkForward": { "days": 60, "trainDays": 10, "testDays": 3, "stepDays": 1, "autoRun": false },
    "consensus": { "enabled": false, "minScanners": 2, "windowBars": 1 },
    "shadow": { "enabled": true, "minProb": 0.55 }
  },
  "scanners": { "reactive-trail-system": { "enabled": true, "symbols": null, "timeframes": null, "exitMode": "both",
                                           "rule": null, "inputs": { "maLenInput": 34 } } }
}
```

Validation keys: `history.backtestBars` (> `historyBars`) runs warm backtests over the cached deep
history while live runs keep the in-memory bars; `walkForward.autoRun` re-validates every
`autoTune.intervalHours`; `autoTune.oos.enabled` switches auto-tune to the out-of-sample rule;
`autoTune.tuneTimeframes` tunes each scanner's timeframe list too; `scanners.<id>.rule` selects a
generic derivation rule (`trailing` | `oscillator`); `scanners.<id>.inputs` overrides Pine inputs.
All new keys default to the previous behaviour.

Environment variables: `PORT` (8787), `HOST` (127.0.0.1), `VNEDGE_WORKERS` (worker threads),
`VNEDGE_SYMBOLS`, `VNEDGE_TIMEFRAMES`, `LOG_LEVEL`, `VNEDGE_DATA_DIR`.

### Execution realism (phase 2)

`paper.fillSource: "tape"` fills on Delta's `all_trades` stream instead of 1-minute candles: an entry
fills at the first print `latencyMs` after the signal, stops trigger on the last trade, TP legs rest as
limit orders (`limitFill: through` needs a print beyond the level), liquidation is checked on the
exchange **mark price**, funding is charged every 8 h (`reason: "funding"` fills) and market slippage
grows with size against `depthUsdPerBp`. Candles take over automatically when the tape is silent for
`tapeFallbackMs`. The default `candles` mode is byte-for-byte the previous behaviour. `GET /api/marks`
shows mark price, funding schedule, tape status and pending entries.

### Portfolio risk layer (phase 3)

On by default: daily (15 %) and weekly (30 %) max-loss kill switches, 8 positions total / 2 per symbol /
4 per scanner, drawdown-scaled sizing (half size beyond −10 % from the equity peak) and the regime filter
learned from the trade data (no entries when ATR % < 0.30, no weekend entries). Optional: per-scanner daily
loss budget, cooldown after N consecutive losses, BTC-beta exposure cap from a rolling 20-bar correlation.
Every veto is recorded on the signal as `rejected:risk <reason>`. `GET /api/risk`, `POST /api/risk/kill`
(manual halt, optional close-all), `POST /api/risk/reset`.

### Optional: mirror paper fills to the Delta India demo account (phase 5)

Create API keys on the **demo** site (<https://demo-india.delta.exchange>), then:

```bash
DELTA_API_KEY=… DELTA_API_SECRET=… npm start
```

and set `"execution": { "mode": "testnet" }` (or `"dry-run"` to only log the exact order payloads,
no keys needed). Entries go out as market orders; each paper position gets exchange-side **reduce-only**
stop-loss (mark-price trigger) and take-profit limit orders that are re-placed on break-even and
cancelled on close, the demo account is reconciled with the paper book every `reconcileSec` seconds
(drift is logged and shown under `GET /api/execution`), and `POST /api/execution/close-all`
`{ "confirm": true }` flattens the demo account with reduce-only market orders.

The production host is unreachable unless **both** `"execution": { "allowProduction": true }` and the
environment variable `DELTA_LIVE=1` are set, and even then the client sends nothing but market orders
with reduce-only exits (no resting orders). Production keys are never needed for anything in this
repository; keep them out of the environment.

## Repository layout

```
server/      Node/TypeScript bot: feed, PineTS workers, scanners, paper engine, REST+SSE API
dashboard/   Vite + React dashboard (Vela chart)
scripts/     Pine sources (scripts/pine/*.pine), manifest.json, compat-report.json
docs/        API.md (contract), ARCHITECTURE.md, SCANNERS.md
data/        runtime: vnedge.db, config.json, logs/   (git-ignored)
```

## Notes & limitations

* Default paper fills are bar-based (1-minute resolution) and resolve SL before TP on ambiguous
  bars — conservative versus TradingView's tick-level fills. `paper.fillSource: "tape"` uses the
  trade stream instead (see above); backtests always use candles.
* PineTS is a re-implementation of Pine; a handful of built-ins behave differently. The
  patches in `server/src/pine/patches.ts` document every deviation VNEdge works around.
* This is a research/paper-trading tool, not investment advice. Nothing here places real
  orders unless you deliberately enable the demo-account mirror.
