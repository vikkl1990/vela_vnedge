# State

Generated 2026-10-09 03:20 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 40 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
| Structure-Anchored VWAP | ZECUSD | 1h | 0 | 0.00 | — |
| Structure-Anchored VWAP | BTCUSD | 1h | 0 | 0.00 | — |
| Liquidity Trail Matrix | MUBARAKUSD | 1h | 0 | 0.00 | — |
| Liquidity Trail Matrix | ETHUSD | 4h | 0 | 0.00 | — |
| Pulse Trend Radar | ZECUSD | 1h | 0 | 0.00 | — |
| Pulse Trend Radar | STRKUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | ETHUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | FILUSD | 1h | 1 | -9.50 | 2026-10-05 19:05 UTC |
| Kinetic Momentum Vectors | UNIUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | MUBARAKUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | MUBARAKUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | API3USD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | STRKUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | BCHUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | VVVUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | ETHUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | ZECUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | MUBARAKUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | LINKUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | SAGAUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | UNIUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | AINUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | API3USD | 15m | 0 | 0.00 | — |
| Smart Money Breakout Signals | ETHUSD | 1h | 0 | 0.00 | — |
| Smart Money Breakout Signals | FILUSD | 1h | 0 | 0.00 | — |
| Smart Money Breakout Signals | ETHUSD | 4h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | SAGAUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | UNIUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | AKEUSD | 15m | 2 | 3.94 | 2026-10-07 17:34 UTC |
| AI Predictive Flow (Zeiierman) | ZECUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | UNIUSD | 15m | 1 | 2.16 | 2026-10-08 00:50 UTC |
| AI Predictive Flow (Zeiierman) | MUBARAKUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | GRIFFAINUSD | 15m | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | NEARUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | BTCUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | SAGAUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | ZECUSD | 1h | 1 | -8.21 | 2026-10-07 13:52 UTC |
| SuperTrend Cluster (Zeiierman) | STRKUSD | 15m | 2 | 6.39 | 2026-10-09 03:01 UTC |
| SuperTrend Cluster (Zeiierman) | GRIFFAINUSD | 15m | 2 | 6.95 | 2026-10-08 12:57 UTC |
| SuperTrend Cluster (Zeiierman) | STRKUSD | 1h | 0 | 0.00 | — |

## Trading rules in force

| rule | value |
|---|---|
| stop when the script gives none | 1.5 × ATR(14) |
| targets when the script gives none | 2 / 4 / 6 R, split 0% / 0% / 100% |
| profit floor | at +0.5R the stop moves to +0.25R |
| trail | from +0.5R keep 60% of the peak |
| reversal on opposite signal | yes, above 0R |
| trend exit | off |
| sizing | risk, risk 1% of equity, stop loss capped at 3% |
| entry filter | stop ≥ 2× round-trip fee; signal younger than 300s |
| fees | 0.05% taker + 18% GST; Scalper Offer on (30m majors / 15m others) |
| fills | candles, crossing the quoted spread, slippage 2 bps |
| open positions | max 20 |
| exchange mirroring | paper (nothing is sent to an exchange) |
| auto-tune | off |

## Paper account

- 9 closed trades, 0 open, since the reset on 2026-10-05 03:39 UTC
- net 1.74 on 1000 starting equity · 67% winners
- exits: sl 3, trail 6

## Signals — last 7 days

| outcome | count | share |
|---|---:|---:|
| rejected: stop too tight for fees | 67 | 32% |
| exit signal with no position to close | 32 | 15% |
| rejected: risk market: not paying: PF 0.85 over 9 trades in 14d | 12 | 6% |
| rejected: risk regime: choppy | 11 | 5% |
| opened | 9 | 4% |
| rejected: risk market: not paying: PF 0.90 over 9 trades in 14d | 7 | 3% |
| reset | 7 | 3% |
| info | 6 | 3% |
| rejected: risk market: dead: $0.02M 24h turnover < $0.25M | 4 | 2% |
| rejected: risk market: dead: $0.19M 24h turnover < $0.25M; costly book: 0.282% round trip for $2.5k | 3 | 1% |
| rejected: risk market: costly book: 0.254% round trip for $2.5k | 2 | 1% |
| rejected: risk market: costly book: 0.280% round trip for $2.5k | 2 | 1% |
| rejected: risk market: dead: $0.17M 24h turnover < $0.25M | 2 | 1% |
| rejected: risk market: dead: $0.22M 24h turnover < $0.25M | 2 | 1% |
| rejected: risk market: dead: $0.23M 24h turnover < $0.25M; costly book: 0.308% round trip for $2.5k | 2 | 1% |
| rejected: risk market: dead: $0.24M 24h turnover < $0.25M | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.58% < 0.60% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.59% < 1.00% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.73% < 0.84% | 2 | 1% |
| rejected: risk max 1 positions on MUBARAKUSD | 2 | 1% |
| rejected: risk regime: ATR 0.26% < 0.3% | 2 | 1% |
| rejected: margin or leverage cap exhausted | 1 | 0% |
| rejected: risk budget too small for one contract | 1 | 0% |
| rejected: risk market: costly book: 0.277% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.290% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.291% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.298% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.300% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.308% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.311% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.315% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.320% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.325% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.326% round trip for $2.5k | 1 | 0% |
| rejected: risk market: dead: $0.03M 24h turnover < $0.25M | 1 | 0% |
| rejected: risk market: dead: $0.04M 24h turnover < $0.25M | 1 | 0% |
| rejected: risk market: dead: $0.05M 24h turnover < $0.25M; too quiet: 15m ATR 0.24% < 0.67% | 1 | 0% |
| rejected: risk market: dead: $0.06M 24h turnover < $0.25M | 1 | 0% |
| rejected: risk market: dead: $0.10M 24h turnover < $0.25M | 1 | 0% |
| rejected: risk market: dead: $0.15M 24h turnover < $0.25M; too quiet: 15m ATR 0.47% < 0.61% | 1 | 0% |
| rejected: risk market: dead: $0.22M 24h turnover < $0.25M; costly book: 0.283% round trip for $2.5k | 1 | 0% |
| rejected: risk market: not paying: PF 0.72 over 6 trades in 14d | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.28% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.31% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.32% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.47% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.65% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.45% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.49% < 0.64% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.64% < 0.79% | 1 | 0% |
| rejected: risk max 1 positions on STRKUSD | 1 | 0% |
| rejected: risk max 1 positions on ZECUSD | 1 | 0% |

## Incubator

- stages: candidate 208 · live 40 · retired 199 · shadow 235
- shadow book: 235/150 slots, oldest 16.41 days
- shadow trades: 1213 closed at 0.55 per market-day
- gate (pooled per scanner × timeframe): ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade, ≥50% of judgeable markets positive
- retired unproven after 45 days (1h: 60, 4h: 90); cohorts of default 5, 1h 8, 4h 12 markets
- promotion: at most 2 per week, fleet capped at 40 pairs, owner approves each one

| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |
|---|---:|---:|---:|---:|---:|
| 15m | 86 | 35 | 822 | 1.30 | 5 |
| 4h | 78 | 41 | 265 | 0.27 | 9 |
| 1h | 71 | 22 | 126 | 0.22 | 17 |

- last screen: 2026-09-29 01:06 UTC, slice 5, 247 scripts × 39 markets, 3945 runs, 49 passed, 140 min

## Library

- 3034 scripts, 2090 runnable, 944 not
- proposals waiting for you: 0 promotion, 0 demotion
