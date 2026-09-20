# VNEdge dashboard

Local trading-terminal UI for the VNEdge paper-trading bot (42 Pine scanners on Delta India).
Vite 7 + React 19 + TypeScript. Charts: `@luxalgo/vela` (+ `@luxalgo/vela-pinets` for
on-chart Pine scripts) and `recharts` for equity/PnL. Data via the REST + SSE contract in
`../docs/API.md`.

## Run

```bash
# from the repo root (workspaces) or from this folder
cd dashboard
npm install            # add --workspaces=false if hoisting misbehaves

# development — http://localhost:5173, proxies /api (incl. SSE) to http://localhost:8787
npm run dev

# production — emits dashboard/dist, which the server serves at http://localhost:8787
npm run build

npm run lint           # eslint
npm run preview        # serve the built dist locally (no API proxy)
```

Set `VNEDGE_API=http://host:port` before `npm run dev` to point the proxy elsewhere.

## Pages

| Route            | What                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `/`              | Ticker tape, KPI tiles, global equity curve, PnL by scanner, live alerts feed, open positions |
| `/scanners`      | All 42 scanners as category-filtered cards or a sortable table; inline enable / symbols / timeframes / exit mode; run now; bulk enable/disable |
| `/scanners/:id`  | Stats + backtest, Vela chart with "Show script on chart", signals, trades, per-scanner equity, source viewer (original / patched / patches), run backtest |
| `/signals`       | Live feed table with filters; score → grade (A+/A/B/C); new rows flash               |
| `/trades`        | Open positions (live unrealized PnL, close button), closed trades with filters, orders/fills |
| `/chart`         | Full-height Vela chart, symbol/timeframe pickers, overlay any enabled scanners' scripts, latest signals for the symbol |
| `/settings`      | Form bound to `GET/PUT /api/config` with validation                                  |
| `/logs`          | Tail of `/api/logs` + live `log` events, level/scope/text filters, auto-scroll       |

The top bar shows SSE / feed status, last-tick age, mode, equity, day PnL, open positions,
worker queue and the paper-account reset. A red banner appears when `/api/health` is
unreachable; every page still renders.

## Structure

```
src/
  api/        types.ts (API.md mirror) · client.ts (typed fetch) · queries.ts (React Query hooks)
  sse/        bus.ts (typed event bus) · SSEProvider.tsx (EventSource + backoff + cache updates)
  chart/      deltaProvider.ts (Vela DataProvider over /api/candles + SSE) · VelaChart.tsx · FallbackChart.tsx
  components/ Layout, DataTable, PositionsTable, TickerTape, AlertsFeed, charts (recharts), ui primitives, Icons
  pages/      Overview, Scanners, ScannerDetail, Signals, Trades, ChartPage, Settings, Logs
  lib/        format.ts, timeframes.ts, categories.ts, toast.tsx, theme.tsx, useNow.ts
  app.css     design tokens + all styling (dark default, light via toggle)
```

## Charting notes

- Vela is created with `symbol: 'delta:BTCUSD'`; the `delta` provider is registered right
  after construction (Vela parks the load until a provider resolves the prefix).
- Timeframes are mapped Delta ⇄ Vela (`15m ⇄ 15`, `1h ⇄ 60`, `4h ⇄ 240`, `1d ⇄ D`).
- Live bars come from the SSE `candle` event; `tick` events nudge the forming bar's close.
- Scripts are added with `chart.addIndicator(patchedSource, { language: 'pine', overlay, id })`
  and removed with `handle.remove()`. Every Vela call is wrapped in try/catch and surfaces a
  toast; if Vela fails to initialise the page swaps to a canvas candlestick fallback.
- The provider's `getSymbolInfo` returns a full pinets-style `ISymbolInfo` (`tickerid`,
  `main_tickerid`, `root`, `prefix`, `mintick`, …). vela-pinets forwards it verbatim as
  `syminfo.*`; without `tickerid`, `request.security(syminfo.tickerid, …)` fails with
  "Invalid timeframe" because pinets shifts the positional arguments.
- In dev builds the live chart instance is exposed as `window.__vnChart` for debugging
  (`__vnChart.runScript(src)`, `__vnChart.market`, `__vnChart.indicators()`).
