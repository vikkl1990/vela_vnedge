# Paper calculation model

This is a linear-contract paper simulator, not an exchange margin calculator. Quantity is integer contracts; underlying quantity is contracts × contract value.

## Sizing and margin

Risk sizing budgets the expected loss at the stop, including adverse entry/stop slippage and both taker fees. Quantity is rounded down and capped by account notional exposure and available wallet cash. Quality sizing targets equity × selected leverage, subject to the same caps. Entry fees are reserved alongside initial margin.

`leverage` remains notional / account equity for account exposure. `marginLeverage` is the selected isolated leverage: maxLeverage in risk mode and the score-derived leverage in quality mode. Initial position margin is filled entry notional / marginLeverage. Existing margin is reserved before another entry, and unrealized gains do not create available wallet cash. Partial exits release margin proportionally; realized P&L and fees update the wallet. The position table shows isolated leverage.

Existing persisted positions retain their historical leverage, margin assumptions, and liquidation levels. New entries use the corrected model. Simulation cache version 3 forces historical simulations and ML models to rebuild.

## Liquidation

For the simplified fixed maintenance-on-entry-notional model, with entry E, isolated leverage L and maintenance fraction m:

- Long trigger: E × (1 − 1/L + m).
- Short trigger: E × (1 + 1/L − m).
- A nonpositive long trigger is unreachable and represented as null.
- New positions require initial margin fraction 1/L > m.

The first adverse threshold is evaluated before profit targets. When a liquidation threshold is crossed, the entire remainder closes, including when the crossing is observed in a script exit. Modeled liquidation slippage is bounded by bankruptcy price; liquidation exit fees are capped at the remaining allocated margin. Entry fees were charged separately at entry.

These are approximations. Delta uses mark-price triggers, contract-specific maintenance tiers, liquidation charges, netting and possible incremental liquidation. This application uses a configured fixed maintenance rate and full liquidation. In `candles` mode the trigger is the candle extreme; in `tape` mode it is the exchange mark price from the `mark_price` channel (the last print when no mark is known yet). Taxes and exchange liquidation charges are not modeled. A candle gap cannot establish the exact order or executable price of stop and liquidation triggers.

References: [Delta isolated margin](https://guides.delta.exchange/delta-exchange-india-user-guide/trading-guide/margin-explainer/margin-explainer), [Delta liquidation process](https://www.delta.exchange/support/solutions?articleId=80001199739).

## P&L, fees and statistics

Gross P&L = (exit − filled entry) × underlying quantity for longs, with reversed sign for shorts. Net P&L subtracts the entry fee once and each exit fee. Resting TP fills use maker fees; stop, reversal and liquidation fills use taker fees. Break-even moves the stop to filled entry, so fees and slippage can still produce a net loss. R-multiple divides net P&L by the initial expected stop-loss budget.

SL and TP levels must remain positive and on the correct side after tick rounding. Zero-quantity target allocations neither fill nor activate break-even. Backtests ignore exits explicitly addressed to the opposite side.

Statistics are based on closed trades. Reported maximum drawdown is closed-trade equity drawdown, not full intratrade drawdown; backtest equity curves likewise omit open-position unrealized swings. Trade pnlPct is return on original notional, not return on margin. These definitions should be considered when comparing results to exchange reports.

## Exits

Three take-profit legs (`tpSplit`), a stop, and optionally a break-even jump after TP1
(`breakEvenAfterTp1`) or a trailing stop (`trailAfterR` / `trailDistanceR`, 0 = off, the default).
The trail arms once the trade has shown `trailAfterR` of favourable excursion and then follows the
best price `trailDistanceR` behind it, never moving against the position. It is advanced only after
the current bar's exits have been checked, so a bar can never both raise the stop and trigger it.

`npm run exits -- [BARS] [TF] [WINDOWS]` replays every enabled pair under alternative exit policies,
pooled over the whole span and separately over consecutive non-overlapping windows. An exit policy is
a fixed rule, so the same rule measured on disjoint windows is the out-of-sample test: a policy that
only wins on one window is fitted to it. The report also measures bars held and bars to the first
profit-taking fill, so a policy that captures the same money sooner is visible as such. Its
continuation figure is a maximum over a fixed horizon, so read it as evidence that movement was
available, not as profit that was reachable.

The live account runs the policy that won that test over 4000 bars of 15m across 8 windows
(1081 trades): a single target at TP3 with the trail armed at 1R and held half an R behind the peak,
and no break-even jump. It was profitable in all 8 windows, held the best profit factor, and cut
average holding time from 11.7 bars to 7.8 while raising net profit per bar held from 0.16 to 0.36.

## Entry pricing and the spread

`slippageBps` is a stand-in for the spread, used when no quote is available. When `useSpread` is on
and the top of book (from `v2/ticker`) is fresher than `quoteMaxAgeMs`, the entry fills at the ask
(buy) or bid (sell) and only depth impact is added on top; charging `slippageBps` as well would pay
the spread twice. `requireQuote` refuses an entry that cannot be priced off a fresh book. Exits never
require a quote, so a position is always closable.

Measured spreads on Delta India differ from the flat assumption by more than an order of magnitude in
both directions, so which of the two paths prices a fill changes results materially:

| symbol | quoted spread |
|---|---|
| BTCUSD | 0.12 bps |
| SOLUSD | 0.08 bps |
| FILUSD | 2.06 bps |
| AKEUSD | 3.55 bps |
| PIEVERSEUSD | 4.90 bps |
| EVAAUSD | 8.01 bps |

## Execution realism (`paper.fillSource: "tape"`)

Default `candles` keeps the 1-minute path above unchanged. `tape` switches the live engine to Delta's `all_trades` stream:

- **Latency.** A signal creates a pending entry; the fill is the first print with `time ≥ signalTime + latencyMs` (default 1500 ms) at that print's price plus slippage. Levels from the signal are absolute; if the fill print already sits beyond the stop or a target the entry is cancelled (`rejected:price moved past levels before fill`). Sizing happens at fill time. If no print arrives, the 1m close fills it once the tape has been silent for `tapeFallbackMs`; an entry unfilled 60 s after its due time expires.
- **Stops** trigger on the last trade and fill at min(print, stop) for longs (max for shorts) with slippage: a stop-market never fills better than its trigger and can fill through a gap.
- **Take-profit legs** are resting limit orders filled at their own price with the maker fee. `limitFill: "through"` (default) requires a print strictly beyond the level, standing in for the queue ahead of the order; `"touch"` fills on a print at the level (optimistic).
- **Liquidation** is checked against the mark price on every print and every mark update, before stops, exactly as Delta liquidates on mark.
- **Funding.** At each realization (every 8 h at 00:00/08:00/16:00 UTC, taken from `next_funding_realization`) every open position pays `ratePct / 100 × qtyOpen × contractValue × mark`; longs pay when the rate is positive, shorts receive it (and vice versa). Delta's `funding_rate` is a percent-per-interval figure (0.01 = 0.01 %). The charge is a zero-quantity fill with reason `funding` and flows through realized P&L (not fees). When the feed missed several slots only the most recent one is charged. `paper.fundingCharges: false` disables it.
- **Depth slippage.** Market fills (entry, stop, liquidation, reversal, manual) pay `slippageBps + notionalUsd / depthUsdPerBp` bps; `depthUsdPerBp: 0` (default) keeps the fixed slippage. Sizing still budgets the fixed slippage only, so large orders realise slightly more than `riskPerTradePct` at the stop.
- **Fallback.** With the tape silent for more than `tapeFallbackMs` (5 s) the 1m candle path runs; while the tape is live each position's candle baseline is refreshed so a later fallback only sees movement after the last print.

## Portfolio risk layer (`risk`)

Checked per entry before sizing, in this order; the first failure is recorded as `rejected:risk <reason>`:

1. Manual halt (`POST /api/risk/kill`), applied even when `risk.enabled` is false.
2. Daily / weekly kill switch: `(equity − periodStartEquity) / periodStartEquity × 100 ≤ −maxDailyLossPct` (`maxWeeklyLossPct`), equity including unrealized P&L. The day is the UTC day, the week starts Monday 00:00 UTC; a new period restarts from the current equity and clears the trip. `closeAllOnKill` flattens the book when a switch trips.
3. Position caps: open + pending entries ≥ `maxPositionsTotal`, per symbol ≥ `maxPositionsPerSymbol`, per scanner ≥ `perScannerMaxPositions`.
4. Per-scanner daily budget: the scanner's net realized P&L since the day start (closed trades plus partial exits and funding on open positions) ≤ `−perScannerDailyLossPct` % of the day-start equity.
5. Cooldown: after `cooldownAfterLosses` consecutive losing trades (net P&L < 0; a winning trade resets the count) the scanner is paused for `cooldownMinutes` from the loss.
6. Regime filter: no entries on Saturday/Sunday UTC (`noWeekend`) and none when `ATR(14) / price × 100 < minAtrPct` (skipped when no ATR is available); scanner ids in `exempt` bypass it.
7. Drawdown scaling: with drawdown `(peakEquity − equity) / peakEquity × 100`, the entry with the largest `ddPct ≤ drawdown` in `ddScale` supplies `leverageMult`, which multiplies `riskPerTradePct`, `maxLeverage` and `minLeverage` for the sizing of that entry only.
8. BTC-beta exposure cap (after sizing): `Σ side × notional × corr(symbol, BTCUSD)` over open positions plus the candidate, as % of equity, must stay within `±maxBetaExposurePct` (0 = off). `corr` is the Pearson correlation of log returns over the last `corrBars` closed bars of the entry timeframe; BTCUSD counts as 1 and an unknown correlation is treated as 1 (conservative).

State (period starts, trips, peak, cooldowns) is stored in the kv table and survives restarts; a paper reset restarts it.

## Exchange execution safety

- The exchange host is the Delta India **demo** host unless `execution.allowProduction: true` is configured **and** the process runs with `DELTA_LIVE=1`; either alone keeps the demo host.
- Even on production the transport accepts only plain market orders (no limit, stop or take-profit orders) and refuses any non-entry order that is not `reduce_only`, so brackets are demo-only and the bot can never hold resting orders on a real account.
- `execution.mode: "dry-run"` logs every payload without sending; `"testnet"` without API keys silently degrades to dry-run.
- Brackets (demo): per paper position one reduce-only stop-market (`stop_loss_order`, mark-price trigger) for the open size and one reduce-only GTC limit per unfilled TP leg. When the paper stop moves (break-even) or a leg fills, the stop is cancelled and re-placed for the remaining size; a closed position cancels the rest. Level exits (`sl`, `be`, `tp1-3`, `liquidation`) are then left to the exchange orders; script exits, reversals, manual closes and risk kills are sent as reduce-only market orders.
- Reconciliation (`reconcileSec`): exchange positions vs paper net contracts per symbol, average entry (> 25 bps drift flagged), and open-order counts vs expected bracket legs; each drift is logged as `DRIFT …` and exposed under `GET /api/execution`.

## Fee-aware entry filter

An entry is rejected when |entry − stop| < `minRiskFeeRatio` × (entry × takerFee × 2). With 0.05% taker fees and the default ratio of 4 a stop must be at least 0.4% away; tighter stops let fees consume more than a quarter of the risk budget and, on 15-minute crypto, sit inside noise. Set the ratio to 0 to disable.

## Scanner removal

Removing or disabling a scanner stops new entries only; positions already open keep running to their stop and targets, because closing them at market was measured to give back roughly 0.7R per trade.

## Hard stop-loss cap and signal freshness

`paper.maxStopLossPct` (default 2) caps the modelled loss at the stop in **every** sizing mode:
`qty ≤ equity × maxStopLossPct / 100 ÷ riskPerContract`. Quality sizing targets a notional
(`equity × leverage`) and therefore never consulted the stop distance on its own, so an
ATR-fallback stop far from entry could risk most of the account in a single trade. When even one
contract breaches the cap the entry is refused rather than silently taken. Set it to 0 to disable.

`paper.maxSignalAgeSec` (default 300) rejects an entry whose signal bar closed more than that many
seconds ago. Restarts, deep worker queues and warm-up re-runs used to replay bar-old signals
straight into the book at prices that were never available. The default accommodates real feed
lag: measured bar-close detection on Delta is median 11 s and p90 71 s, but thin symbols such as
PIEVERSEUSD can take 234 s for their candle to arrive, so a tighter gate silently drops their
signals while doing nothing about the multi-hour replays it exists to stop.

## Spread-crossing fills

With `paper.useSpread` (default on) a market-style fill uses the live top of book: entries buy at
the ask and sell at the bid, exits do the reverse. Delta's `mark_price` channel carries
`best_bid`/`best_ask`. A quote older than `paper.quoteMaxAgeMs` (10 s), a crossed book or a
missing quote falls back to the configured slippage model around the reference price. This
replaces the assumption that a market order fills at the last traded price.
