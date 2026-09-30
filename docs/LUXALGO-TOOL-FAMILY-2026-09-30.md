# The LuxAlgo tool family for this bot — 2026-09-30

LuxAlgo ships a library of 806 indicators and an open-source family (PineTS, Vela, Edge Stats,
Prop Firm Sim, Trade Journal, Trade Relay, Broker SDK, an MCP server). Checked against what the
bot needs in its next phase (evidence-first fleet), this is the family worth using, ranked by
what each one fixes, and what to leave alone.

## Tier 1 — the evidence engine

| tool | what it is (verified) | what it fixes here |
|---|---|---|
| **Edge Stats** (open source, MIT) | `P(outcome \| conditions)` over your own 1-minute bars in DuckDB, every answer with N, a 95% CI, halves stability ("halves agree ✓") and per-year breakdown. Adapters: CSV, Binance, Coinbase, Hyperliquid, Dukascopy; CLI, dashboard and MCP. No Delta adapter, but the CSV adapter takes any export. | The verdict engine the phase needs: run every screen and shadow pair through the same question shape — P(+1R before −1R \| scanner fired, market gate state, hour, timeframe) — with the CI and the halves check attached. Replaces the lab's ad hoc "both halves positive" with one reproducible envelope. Feed it Delta candles by CSV; its session features (gap, opening range, day of week) come free. |
| **Prop Firm Sim** (open source) | Monte Carlo over a trade series or trading stats: 10,000 paths through a ruleset; pass probability with CI, max drawdown p50/p95, stagnation, risk of blowing up. Rulesets can be passed inline, offline. | The go-live rule with numbers: feed the live journal's R series, define our own "challenge" (10% daily halt, 20% weekly, 10% drawdown alert) and read P(halt within 30 days), expected drawdown and its 95th percentile before any key goes in. Also the right way to size: the risk per trade that keeps P(ruin) under a chosen bound. |
| **Library — Validation and Statistics** (58 scripts already imported) | Walk-forward and Monte Carlo projections, CUSUM change-point detection, Hurst exponent, volatility cones and estimators (Yang-Zhang, Garman-Klass, Parkinson, Rogers-Satchell), GARCH-style clustering, jump detection, matrix profile, ensemble voting, logistic signal calibration, model stacking, bagging. | Features for the market gate and the screen: Hurst and CUSUM say whether a market is trending or mean-reverting today; volatility estimators give a better ATR than Wilder's for the "too quiet" rule; the calibration scripts show how to turn a scanner's score into a probability. Read as components, not as scanners. |

## Tier 2 — exits and regime, to test in the exit lab

| tool | what it is | what it fixes |
|---|---|---|
| **Risk & Exits family** (9): Statistical, Sigmoid-transition, Market-structure, Volume-delta, Fibonacci, Neighboring trailing stops; ATR-based stop distance; Stop placement vs liquidity pools; Targets for overlay indicators | Trailing-stop and target designs with a stated rationale each. | The book gives back half of every peak (decision 63). These are the candidate trail rules to replay through `exitlab` against the stored price paths, beside the current lock-and-trail. |
| **Regime family**: Market Regime Engine (ER branch), RSI Regime Filter, Volatility Regime Switches, VWAP Mean-Reversion vs Trend Regimes, Choppiness Index | Per-market state: trending / ranging / volatile. | A strategy router: which scanners may fire in which regime. Decision 56b judges the market's cost; these judge its behaviour. Market Regime Engine's last-bar re-clustering must be removed first (verified in the combinations check). |
| **Elder SafeZone Stop, Chandelier Exit, Chande Kroll Stop** (imported) | Classic trails with parameters that mean something. | Same exit-lab candidates, cheaper to reason about than the SMC ones. |

## Tier 3 — plumbing worth adopting

| tool | verified | use |
|---|---|---|
| **LuxAlgo MCP** (hosted, keyless) | `library_search`, `library_get_source_code` and friends. | Keeps the library current without scraping: a nightly job can diff the library index and import new entries. `claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp` for the operator's own use. |
| **PineTS 0.10.0 and pinets-cli** | Adopted (decision 61a); the CLI runs `.pine` files from the terminal. | Already the runtime. The CLI is a quick parity check for a single script outside the bot. |
| **Vela** | Open-source charting, already used by the dashboard. | Stay current with it; its Pine overlay is how the operator sees what the scanner saw. |
| **Trade Journal** (open source) | Broker sync, P&L calendar, breakdowns, AI reflection; imports TradingView CSV fills; hosted version free. | Only as a second opinion: export the account's fills as CSV and load them to compare its Edge Score and breakdowns with the Learning section. Our journal carries peak R, give-back and stop anatomy that theirs does not, so it does not replace ours. |

## Not for this bot

| tool | why not |
|---|---|
| **Broker SDK, Trade Relay** | 22 brokers and exchanges, no Delta India (checked the README: Schwab, Alpaca, Robinhood Crypto, Binance, Kraken, IBKR…). Trade Relay's rails (allowlist, max size, daily loss, duplicate guard, kill switch) are the same ones the executor already has, with a ledger and recovery on top. |
| **Quant, QuantCharts, Orderflow** | A chat agent and a chart app with no API. A strategy written there is Pine that can be pasted in and screened; nothing to integrate. Orderflow needs exchange order-flow data Delta does not expose to us. |
| **Whale Options, Market Trackers, Edge Stats' hosted presets** | US equities and options; the hosted Edge Stats symbols are stocks, not Delta perpetuals. |
| **The library's 700-odd indicators as more scanners** | Already imported (decision 61). The library is not the constraint; the screen is, and it runs on its own. |

## Order of adoption

1. Edge Stats on Delta CSV exports for the fleet's markets, with one preset per scanner question
   (P(+1R first \| scanner fired)). This is item 2 of the phase (verdicts with confidence) done
   with a maintained engine instead of our own arithmetic.
2. Prop Firm Sim over the live journal to write the go-live rule in probabilities (item 6).
3. The Risk & Exits and classic trails through `exitlab` (give-back is the largest measured leak).
4. Regime scripts as typed components of the strategy layer (item 4), after the Market Regime
   Engine's last-bar fix.
5. Nightly library sync through the MCP.
