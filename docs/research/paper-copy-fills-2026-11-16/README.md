# Paper-copy signal and fill audit — 16 November 2026

Read-only VM snapshot: 2026-11-16T16:27:26.853000+00:00. Membership is the 57 cells reported eligible after `2010740`. A cell is a scanner × symbol × timeframe. Eligibility today does not imply it passed the evidence/market checks throughout the historical window.

## Observed flow

- All 57 registry entries are healthy and have successful scans: 26 on 15m, 25 on 1h, 6 on 4h.
- In the rolling 24-hour window, these cells produced 74 account entry decisions, 19 actual paper fills across 10 cells, and 56 shadow fills. In seven days they produced 95 account fills across 23 cells.
- The 74 account outcomes were: 19 fills, 19 same-symbol exposure refusals, 11 chop refusals, 7 cost refusals, 6 burst refusals, 6 already-held signals, 3 native-stop refusals, 2 stop-cooldown refusals and 1 stale-depth cancellation.
- 145 copy attempts were held by the old $2M turnover floor before the previous deployment. That floor has already been aligned to $50k; none of the initial post-deployment attempts hit it.
- At the first post-deployment check (16:23 UTC), the 15m cells had completed the 16:15 close. Two entry signals reached paper and both failed the unchanged chop rule. There were no new account fills at that point. The 1h/4h latest scans belonged to the 16:00 close, before deployment; their next closes were not overdue.

## Confirmed execution defect

Accepted pending orders were permanently cancelled when the depth observation was temporarily stale. The seven-day journal contains five accepted maker orders with this outcome: UNI Doji (signal 15137), DOGE Breaker Block (14927), SOL Liquidity Trail maker (15257), SOL Trend Impulse maker (14845), and UNI Swing S/R (13433). Two are in this frozen group. These are missed opportunities, not demonstrated profitable counterfactual trades.

The correction keeps an already-accepted paper order pending only for stale/missing depth. The existing scheduler refreshes its book. Its original price, reservation, deadline, sizing and policy stay fixed. A new price observation must qualify; a failed trade print or a candle spanning the failed observation cannot be reused after refresh. Expensive, insufficient, crossed or malformed books still refuse; risk and fee checks still run. The wait boundary persists for resting-order recovery. No historical fill or signal is replayed, and no real-money executor uses this recovery.

## Per-cell audit

Counts below are observed over the rolling 24 hours, not projected frequencies. A zero does not mean the scanner failed. Complete action and shadow-funnel breakdowns, qualification counts and latest successful scans are in `assessment.json`.

| Scanner | Pair | TF | Paper entry decisions | Paper fills | Shadow fills |
|---|---|---|---:|---:|---:|
| trend-impulse-channels-zeiierman | AINUSD | 15m | 0 | 0 | 0 |
| dynamic-rsi-regression-bands-zeiierman | LINKUSD | 15m | 0 | 0 | 0 |
| dca-grid-15-orders-1-1-step-1-8-tp | AKEUSD | 15m | 0 | 0 | 0 |
| quant-synthesis-strategy | SOLUSD | 15m | 0 | 0 | 0 |
| rsi-signals-entries | ARIAUSD | 15m | 2 | 1 | 2 |
| smart-money-breakout-signals | AINUSD | 15m | 0 | 0 | 0 |
| elliott-wave | ARIAUSD | 15m | 2 | 2 | 2 |
| trend-impulse-channels-zeiierman | INITUSD | 15m | 0 | 0 | 0 |
| trend-impulse-channels-zeiierman | MUSD | 15m | 0 | 0 | 0 |
| money-flow-divergence-zones | SOPHUSD | 15m | 12 | 0 | 0 |
| crypto-directional-score-oscillator | AIOTUSD | 15m | 0 | 0 | 6 |
| kaufman-moving-average-adaptive-strategy-by-mkb | INITUSD | 15m | 1 | 0 | 0 |
| standard-error-bands | INITUSD | 15m | 9 | 0 | 6 |
| donchian-channels | INITUSD | 15m | 6 | 4 | 5 |
| standardized-psar-oscillator | SOLVUSD | 15m | 0 | 0 | 1 |
| kinetic-trailing-stop-targets | BTWUSD | 15m | 0 | 0 | 0 |
| horns-pattern-identifier | AKEUSD | 15m | 1 | 1 | 1 |
| role-reversal | AKEUSD | 15m | 1 | 1 | 1 |
| liquidity-sweep-follow-through-guard | BTWUSD | 15m | 0 | 0 | 0 |
| re-accumulation | AKEUSD | 15m | 2 | 2 | 2 |
| smart-money-engine | MUSD | 1h | 0 | 0 | 2 |
| indicatorneo-support-resistance-alerts | WLDUSD | 1h | 0 | 0 | 1 |
| gradient-boosting | GRIFFAINUSD | 1h | 0 | 0 | 0 |
| woodie-pivots | BTWUSD | 15m | 1 | 0 | 1 |
| mgc-wyckoff-second-breakout-v3-candle-rr | LABUSD | 1h | 0 | 0 | 1 |
| structure-trend-dashboard | GRIFFAINUSD | 1h | 0 | 0 | 1 |
| rsi-with-self-adjusting-linear-regression-bands-expo | ETHUSD | 4h | 1 | 1 | 2 |
| linear-regression-channel-visible-range-volume-profile | ETHUSD | 4h | 3 | 0 | 0 |
| half-trend-channel | BNBUSD | 4h | 1 | 0 | 1 |
| half-trend-channel | AVAXUSD | 4h | 0 | 0 | 0 |
| half-trend-channel | BCHUSD | 4h | 0 | 0 | 0 |
| structure-trend-dashboard | EVAAUSD | 1h | 1 | 0 | 1 |
| half-trend-channel | LINKUSD | 4h | 0 | 0 | 0 |
| nse-elite-strategy-v6-full-system | ZECUSD | 1h | 5 | 2 | 1 |
| uhl-adaptive-ma | AAVEUSD | 1h | 1 | 0 | 0 |
| bollinger-bands | AAVEUSD | 1h | 0 | 0 | 0 |
| fearzone-expo-contrarian-indicator | VVVUSD | 1h | 0 | 0 | 0 |
| breaker-block-detector | DOGEUSD | 1h | 0 | 0 | 0 |
| slope-ma-cross-acc-range-filter | ZECUSD | 1h | 3 | 0 | 1 |
| vwap-z-score-oscillator | ETHUSD | 1h | 3 | 0 | 0 |
| optimized-doji-breakout-strategy-short-only-v6 | UNIUSD | 1h | 4 | 1 | 1 |
| twiggs-money-flow | ARIAUSD | 1h | 0 | 0 | 0 |
| mitigation-blocks | ETHUSD | 1h | 2 | 0 | 1 |
| mitigation-blocks | ZECUSD | 1h | 2 | 0 | 1 |
| reverse-rsi-signals | UNIUSD | 1h | 1 | 0 | 0 |
| standardized-orderflow | BEATUSD | 1h | 0 | 0 | 2 |
| quant-synthesis-strategy | ETHUSD | 1h | 0 | 0 | 0 |
| quant-synthesis-strategy | SOLUSD | 1h | 0 | 0 | 0 |
| aroon-oscillator | BTCUSD | 1h | 1 | 0 | 0 |
| key-level-sweep-breakout | ETHUSD | 1h | 1 | 0 | 0 |
| market-regime-engine | AAVEUSD | 1h | 0 | 0 | 2 |
| bessel-filter | SKYAIUSD | 1h | 0 | 0 | 0 |
| machine-learning-rsi-ai-classification-ranking-zeiierman | ARIAUSD | 15m | 6 | 4 | 4 |
| session-killzones-breakouts-all-sessions | BTWUSD | 15m | 0 | 0 | 1 |
| scalping-ichimoku | AINUSD | 15m | 0 | 0 | 1 |
| structure-trend-dashboard | AIOTUSD | 15m | 0 | 0 | 0 |
| ema-crossx | AAVEUSD | 15m | 2 | 0 | 5 |

## Validation

Regression tests reproduce the old cancellation. They verify future-only fills, original expiry, risk/cost refusal, restart continuity, no evidence or fees before filling, equivalent fee/quantity/policy on recovery, disabled pilots and executor isolation. Full-suite and deployment results are recorded in the change review.

Paper mode, capital, risk caps, evidence criteria, scanner contracts and market/fee thresholds are unchanged. No profitability increase is inferred from these tests.
