# State

Generated 2026-10-08 02:18 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 26 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
| Structure-Anchored VWAP | ZECUSD | 1h | 0 | 0.00 | — |
| Liquidity Trail Matrix | EVAAUSD | 1h | 0 | 0.00 | — |
| Pulse Trend Radar | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Pulse Trend Radar | ZECUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | ETHUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | FILUSD | 1h | 1 | -9.50 | 2026-10-05 19:05 UTC |
| Kinetic Momentum Vectors | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | UNIUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | ETHUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Session Killzones & Breakouts | ZECUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | LINKUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | SAGAUSD | 1h | 0 | 0.00 | — |
| Pivot Channel Breaks | UNIUSD | 1h | 0 | 0.00 | — |
| Smart Money Breakout Signals | ETHUSD | 1h | 0 | 0.00 | — |
| Smart Money Breakout Signals | FILUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | SAGAUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | UNIUSD | 1h | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | AKEUSD | 15m | 2 | 3.94 | 2026-10-07 17:34 UTC |
| AI Predictive Flow (Zeiierman) | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | ZECUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | UNIUSD | 15m | 1 | 2.16 | 2026-10-08 00:50 UTC |
| SuperTrend Cluster (Zeiierman) | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | SAGAUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | ZECUSD | 1h | 1 | -8.21 | 2026-10-07 13:52 UTC |

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
| entry filter | stop ≥ 4× round-trip fee; signal younger than 300s |
| fees | 0.05% taker + 18% GST; Scalper Offer on (30m majors / 15m others) |
| fills | candles, crossing the quoted spread, slippage 2 bps |
| open positions | max 20 |
| exchange mirroring | paper (nothing is sent to an exchange) |
| auto-tune | off |

## Paper account

- 5 closed trades, 0 open, since the reset on 2026-10-05 03:39 UTC
- net -11.60 on 1000 starting equity · 60% winners
- exits: sl 2, trail 3

## Signals — last 7 days

| outcome | count | share |
|---|---:|---:|
| rejected: stop too tight for fees | 83 | 40% |
| exit signal with no position to close | 33 | 16% |
| rejected: risk market: not paying: PF 0.85 over 9 trades in 14d | 14 | 7% |
| reset | 10 | 5% |
| rejected: risk market: not paying: PF 0.90 over 9 trades in 14d | 7 | 3% |
| info | 6 | 3% |
| opened | 5 | 2% |
| rejected: risk regime: choppy | 5 | 2% |
| rejected: risk market: not paying: PF 0.72 over 6 trades in 14d | 3 | 1% |
| rejected: risk market: costly book: 0.254% round trip for $2.5k | 2 | 1% |
| rejected: risk market: dead: $0.23M 24h turnover < $0.25M; costly book: 0.308% round trip for $2.5k | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.55% < 0.61% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.58% < 0.60% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.59% < 1.00% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.73% < 0.84% | 2 | 1% |
| rejected: risk max 1 positions on MUBARAKUSD | 2 | 1% |
| rejected: margin or leverage cap exhausted | 1 | 0% |
| rejected: risk market: costly book: 0.277% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.290% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.298% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.300% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.308% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.311% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.315% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.320% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.325% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.326% round trip for $2.5k | 1 | 0% |
| rejected: risk market: dead: $0.05M 24h turnover < $0.25M; too quiet: 15m ATR 0.24% < 0.67% | 1 | 0% |
| rejected: risk market: dead: $0.10M 24h turnover < $0.25M | 1 | 0% |
| rejected: risk market: dead: $0.15M 24h turnover < $0.25M; too quiet: 15m ATR 0.47% < 0.61% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.23% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.28% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.31% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.32% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.33% < 0.51% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.47% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.65% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.45% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.49% < 0.64% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.50% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.64% < 0.79% | 1 | 0% |
| rejected: risk max 1 positions on ZECUSD | 1 | 0% |

## Incubator

- stages: candidate 190 · live 26 · retired 186 · shadow 245
- shadow book: 245/150 slots, oldest 15.37 days
- shadow trades: 1024 closed at 0.52 per market-day
- gate (pooled per scanner × timeframe): ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade, ≥50% of judgeable markets positive
- retired unproven after 45 days (1h: 60, 4h: 90); cohorts of default 5, 1h 8, 4h 12 markets
- promotion: at most 2 per week, fleet capped at 40 pairs, owner approves each one

| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |
|---|---:|---:|---:|---:|---:|
| 15m | 94 | 35 | 681 | 1.24 | 5 |
| 1h | 77 | 23 | 105 | 0.21 | 18 |
| 4h | 74 | 38 | 238 | 0.26 | 10 |

- last screen: 2026-09-29 01:06 UTC, slice 5, 247 scripts × 39 markets, 3945 runs, 49 passed, 140 min

## Library

- 3034 scripts, 2090 runnable, 944 not
- proposals waiting for you: 0 promotion, 0 demotion
