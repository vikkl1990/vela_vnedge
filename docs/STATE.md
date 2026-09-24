# State

Generated 2026-09-24 02:27 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 35 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
| Structure-Anchored VWAP | BTCUSD | 15m | 0 | 0.00 | — |
| Liquidity Trail Matrix | ETHUSD | 15m | 0 | 0.00 | — |
| Mirage Liquidity Sweep Pro | FILUSD | 15m | 0 | 0.00 | — |
| Pulse Trend Radar | SOLUSD | 15m | 0 | 0.00 | — |
| Dynamic Trend Bands & Anchored VWAP Signals | FILUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | PIEVERSEUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | UNIUSD | 15m | 0 | 0.00 | — |
| Session Killzones & Breakouts | AKEUSD | 15m | 0 | 0.00 | — |
| Pivot Channel Breaks | ZECUSD | 15m | 0 | 0.00 | — |
| High Volume Breakout Targets | ZECUSD | 15m | 0 | 0.00 | — |
| Smart Money Breakout Signals | AKEUSD | 15m | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | AKEUSD | 15m | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | EVAAUSD | 15m | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | LINKUSD | 15m | 0 | 0.00 | — |
| Machine Learning RSI | AI Classification & Ranking (Zeiierman) | AVAXUSD | 15m | 0 | 0.00 | — |
| Machine Learning RSI | AI Classification & Ranking (Zeiierman) | DOGEUSD | 15m | 0 | 0.00 | — |
| Machine Learning RSI | AI Classification & Ranking (Zeiierman) | MUBARAKUSD | 15m | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | UNIUSD | 15m | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | BTCUSD | 15m | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | ETHUSD | 15m | 0 | 0.00 | — |
| Dynamic RSI Regression Bands (Zeiierman) | BNBUSD | 15m | 0 | 0.00 | — |
| Dynamic RSI Regression Bands (Zeiierman) | LINKUSD | 15m | 0 | 0.00 | — |
| Dynamic RSI Regression Bands (Zeiierman) | SAGAUSD | 15m | 0 | 0.00 | — |
| Adaptive Moving Average (AMA) Signals (Zeiierman) | ETHUSD | 15m | 0 | 0.00 | — |
| Adaptive Moving Average (AMA) Signals (Zeiierman) | UNIUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | AAVEUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | AVAXUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | BNBUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | DOGEUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | LINKUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | NEARUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | XRPUSD | 15m | 0 | 0.00 | — |
| Volume SuperTrend AI (Expo) | ZECUSD | 15m | 0 | 0.00 | — |
| Adaptive ATR% Extension Scanner | SOLUSD | 15m | 0 | 0.00 | — |
| FIA Trend + Momentum 10/20/50 | BTCUSD | 15m | 0 | 0.00 | — |

## Trading rules in force

| rule | value |
|---|---|
| stop when the script gives none | 1.5 × ATR(14) |
| targets when the script gives none | 2 / 4 / 6 R, split 0% / 0% / 100% |
| profit floor | at +1R the stop moves to +0.5R |
| trail | from +1.5R keep 60% of the peak |
| reversal on opposite signal | yes, above 0R |
| trend exit | off |
| sizing | quality, risk 1% of equity, stop loss capped at 3% |
| entry filter | stop ≥ 4× round-trip fee; signal younger than 300s |
| fees | 0.05% taker + 18% GST; Scalper Offer on (30m majors / 15m others) |
| fills | candles, crossing the quoted spread, slippage 2 bps |
| open positions | max 20 |
| exchange mirroring | paper (nothing is sent to an exchange) |
| auto-tune | off |

## Paper account

- 4 closed trades, 0 open, since the reset on 2026-09-23 02:56 UTC
- net 153.94 on 1000 starting equity · 50% winners
- 4 of them came from pairs no longer in the fleet: BCHUSD -0.14, ETHUSD 90.26, ETHUSD 63.82
- exits: tp3 2, reversal 1, sl 1

## Signals — last 7 days

| outcome | count | share |
|---|---:|---:|
| dropped as stale (the scan finished too late to trade) | 86 | 39% |
| exit signal with no position to close | 71 | 32% |
| reset | 33 | 15% |
| rejected: margin or leverage cap exhausted | 11 | 5% |
| info | 10 | 5% |
| opened | 3 | 1% |
| rejected: stop too wide for the 2% max stop-loss cap | 3 | 1% |
| rejected: stop too tight for fees | 2 | 1% |
| rejected: risk regime: ATR 0.28% < 0.3% | 1 | 0% |
| rejected: risk regime: ATR 0.29% < 0.3% | 1 | 0% |
| reversed | 1 | 0% |

**39% of signals never became trades because the scan finished after the signal went stale.** This is a throughput problem, not a strategy one.

## Incubator

- stages: candidate 69 · live 9 · retired 4 · shadow 100
- shadow book: 100/100 slots, oldest 1.37 days
- shadow trades: 42 closed at 0.36 per market-day
- gate (pooled per scanner × timeframe): ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade, ≥50% of judgeable markets positive
- retired unproven after 45 days (1h: 60, 4h: 90); cohorts of default 5, 1h 8, 4h 12 markets
- promotion: at most 2 per week, fleet capped at 40 pairs, owner approves each one

| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |
|---|---:|---:|---:|---:|---:|
| 15m | 35 | 23 | 37 | 0.90 | 7 |
| 1h | 31 | 7 | 5 | 0.14 | 28 |
| 4h | 34 | 9 | 0 | 0.00 | no trades yet |

- last screen: 2026-09-23 01:09 UTC, slice 6, 209 scripts × 35 markets, 3507 runs, 68 passed, 143 min

## Library

- 2588 scripts, 1614 runnable, 974 not
- proposals waiting for you: 0 promotion, 0 demotion
