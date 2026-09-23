vnedge.err
vnedge.log
vnedge.out
# State

Generated 2026-09-23 18:13 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 9 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
| Structure-Anchored VWAP | BTCUSD | 15m | 0 | 0.00 | — |
| Mirage Liquidity Sweep Pro | FILUSD | 15m | 0 | 0.00 | — |
| Pulse Trend Radar | SOLUSD | 15m | 0 | 0.00 | — |
| Dynamic Trend Bands & Anchored VWAP Signals | FILUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | UNIUSD | 15m | 0 | 0.00 | — |
| Kinetic Momentum Vectors | PIEVERSEUSD | 15m | 0 | 0.00 | — |
| High Volume Breakout Targets | ZECUSD | 15m | 0 | 0.00 | — |
| Smart Money Breakout Signals | AKEUSD | 15m | 0 | 0.00 | — |
| Smart Swing VWAP (Zeiierman) | AKEUSD | 15m | 0 | 0.00 | — |

## Trading rules in force

| rule | value |
|---|---|
| stop when the script gives none | 1.5 × ATR(14) |
| targets when the script gives none | 2 / 4 / 6 R, split 0% / 0% / 100% |
| profit floor | at +1R the stop moves to +0.5R |
| trail | from +1.5R keep 60% of the peak |
| reversal on opposite signal | yes, above 0R |
| trend exit | off |
| sizing | quality, risk 1% of equity, stop loss capped at 2% |
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

## Incubator

- stages: candidate 54 · live 9 · retired 1 · shadow 100
- shadow book: 100/100 slots, oldest 1.03 days
- shadow trades: 29 closed at 0.35 per market-day
- gate (pooled per scanner × timeframe): ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade, ≥50% of judgeable markets positive
- retired unproven after 45 days (1h: 60, 4h: 90); cohorts of default 5, 1h 8, 4h 12 markets
- promotion: at most 2 per week, fleet capped at 20 pairs, owner approves each one

| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |
|---|---:|---:|---:|---:|---:|
| 15m | 35 | 23 | 25 | 0.86 | 7 |
| 1h | 31 | 7 | 4 | 0.15 | 24 |
| 4h | 34 | 9 | 0 | 0.00 | no trades yet |

- last screen: 2026-09-23 01:09 UTC, slice 6, 209 scripts × 35 markets, 3507 runs, 68 passed, 143 min

## Library

- 2588 scripts, 1614 runnable, 974 not
- proposals waiting for you: 0 promotion, 0 demotion
