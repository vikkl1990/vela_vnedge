# State

Generated 2026-10-05 03:30 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 26 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
| Structure-Anchored VWAP | ZECUSD | 1h | 0 | 0.00 | — |
| Liquidity Trail Matrix | EVAAUSD | 1h | 1 | 1.40 | 2026-10-03 06:35 UTC |
| Pulse Trend Radar | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Pulse Trend Radar | ZECUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | ETHUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | FILUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| Kinetic Momentum Vectors | UNIUSD | 1h | 3 | 7.71 | 2026-10-02 04:31 UTC |
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
| Smart Swing VWAP (Zeiierman) | AKEUSD | 15m | 5 | 21.81 | 2026-09-29 08:46 UTC |
| AI Predictive Flow (Zeiierman) | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | ZECUSD | 1h | 0 | 0.00 | — |
| AI Predictive Flow (Zeiierman) | UNIUSD | 15m | 26 | 76.45 | 2026-10-03 02:10 UTC |
| SuperTrend Cluster (Zeiierman) | PIEVERSEUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | SAGAUSD | 1h | 0 | 0.00 | — |
| SuperTrend Cluster (Zeiierman) | ZECUSD | 1h | 0 | 0.00 | — |

## Trading rules in force

| rule | value |
|---|---|
| stop when the script gives none | 1 × ATR(14) |
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

- 80 closed trades, 0 open, since the reset on 2026-09-27 18:12 UTC
- net -134.52 on 1000 starting equity · 63% winners
- 45 of them came from pairs no longer in the fleet: SOLUSD -71.89, FILUSD 10.27, ZECUSD -18.53, ETHUSD -3.33, AVAXUSD -0.89, DOGEUSD 2.09, MUBARAKUSD -20.79, FILUSD -31.26, ZECUSD 8.47, AKEUSD -7.53, AKEUSD -26.56, EVAAUSD -29.68, LINKUSD -0.75, ETHUSD -26.57, MUBARAKUSD -4.30, AAVEUSD -12.53, AVAXUSD 0.08, DOGEUSD -14.70, LINKUSD -13.22, NEARUSD 38.80, XRPUSD -24.53, ZECUSD 5.46
- exits: be 2, sl 29, trail 48, reversal 1

## Signals — last 7 days

| outcome | count | share |
|---|---:|---:|
| rejected: stop too tight for fees | 127 | 37% |
| opened | 58 | 17% |
| exit signal with no position to close | 44 | 13% |
| info | 19 | 6% |
| rejected: risk market: not paying: PF 0.85 over 9 trades in 14d | 19 | 6% |
| rejected: risk market: not paying: PF 0.23 over 27 trades in 14d | 3 | 1% |
| rejected: risk market: not paying: PF 0.72 over 6 trades in 14d | 3 | 1% |
| rejected: risk market: not paying: PF 0.90 over 9 trades in 14d | 3 | 1% |
| rejected: risk max 1 positions on UNIUSD | 3 | 1% |
| rejected: risk regime: choppy | 3 | 1% |
| rejected: margin funds only 26% of the intended size | 2 | 1% |
| rejected: margin or leverage cap exhausted | 2 | 1% |
| rejected: risk market: costly book: 0.254% round trip for $2.5k | 2 | 1% |
| rejected: risk market: costly book: 0.290% round trip for $2.5k | 2 | 1% |
| rejected: risk market: not paying: PF 0.00 over 5 trades in 14d | 2 | 1% |
| rejected: risk market: not paying: PF 0.81 over 15 trades in 14d | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.55% < 0.61% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.59% < 1.00% | 2 | 1% |
| rejected: risk market: too quiet: 15m ATR 0.73% < 0.84% | 2 | 1% |
| rejected: risk max 1 positions on MUBARAKUSD | 2 | 1% |
| rejected: margin funds only 3% of the intended size | 1 | 0% |
| rejected: margin funds only 4% of the intended size | 1 | 0% |
| rejected: risk market: costly book: 0.277% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.287% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.315% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.320% round trip for $2.5k | 1 | 0% |
| rejected: risk market: costly book: 0.325% round trip for $2.5k | 1 | 0% |
| rejected: risk market: illiquid: $0.1M 24h turnover < $1.0M; too quiet: 15m ATR 0.45% < 0.47% | 1 | 0% |
| rejected: risk market: not paying: PF 0.26 over 26 trades in 14d | 1 | 0% |
| rejected: risk market: not paying: PF 0.31 over 12 trades in 14d | 1 | 0% |
| rejected: risk market: not paying: PF 0.33 over 14 trades in 14d | 1 | 0% |
| rejected: risk market: not paying: PF 0.55 over 16 trades in 14d | 1 | 0% |
| rejected: risk market: not paying: PF 0.64 over 30 trades in 14d | 1 | 0% |
| rejected: risk market: not paying: PF 0.70 over 29 trades in 14d | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.23% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.26% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.28% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.32% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.33% < 0.51% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.35% < 0.47% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.36% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.37% < 0.47% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.37% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.47% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.51% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.39% < 0.65% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.45% < 0.48% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.46% < 0.51% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.49% < 0.51% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.50% < 0.53% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.56% < 0.59% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.56% < 0.60% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.56% < 0.61% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.58% < 0.59% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.64% < 0.66% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.64% < 0.79% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.68% < 0.94% | 1 | 0% |
| rejected: risk market: too quiet: 15m ATR 0.72% < 0.77% | 1 | 0% |
| rejected: risk max 1 positions on AKEUSD | 1 | 0% |
| rejected: risk max 1 positions on FILUSD | 1 | 0% |
| rejected: risk max 1 positions on ZECUSD | 1 | 0% |
| reversed | 1 | 0% |

## Incubator

- stages: candidate 106 · live 26 · retired 188 · shadow 167
- shadow book: 167/150 slots, oldest 12.42 days
- shadow trades: 667 closed at 0.45 per market-day
- gate (pooled per scanner × timeframe): ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade, ≥50% of judgeable markets positive
- retired unproven after 45 days (1h: 60, 4h: 90); cohorts of default 5, 1h 8, 4h 12 markets
- promotion: at most 2 per week, fleet capped at 40 pairs, owner approves each one

| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |
|---|---:|---:|---:|---:|---:|
| 15m | 58 | 34 | 461 | 1.22 | 5 |
| 1h | 35 | 13 | 61 | 0.15 | 24 |
| 4h | 74 | 38 | 145 | 0.21 | 12 |

- last screen: 2026-09-29 01:06 UTC, slice 5, 247 scripts × 39 markets, 3945 runs, 49 passed, 140 min

## Library

- 3034 scripts, 2090 runnable, 944 not
- proposals waiting for you: 0 promotion, 0 demotion
