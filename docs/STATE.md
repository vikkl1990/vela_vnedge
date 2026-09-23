# State

Generated 2026-09-23 16:10 UTC from `/opt/vnedge/data`. Do not edit: run `npm run state`.

## Live fleet — 6 pairs

| scanner | market | tf | live trades | net $ | last trade |
|---|---|---|---:|---:|---|
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
- shadow book: 100/100 slots, oldest 0.94 days
- shadow trades: 26 closed at 0.35 per pair-day → a 30-trade sample takes about 86 days per pair
- gate: ≥30 trades over ≥14 days, PF ≥ 1.2, ≥60% of weeks positive, ≥0.1R per trade; retired if unproven after 45 days
- promotion: at most 2 per week, fleet capped at 20 pairs, owner approves each one

| timeframe | shadow pairs | trades | per pair-day | days to a 30-trade sample |
|---|---:|---:|---:|---:|
| 15m | 35 | 22 | 0.85 | 35 |
| 1h | 31 | 4 | 0.17 | 175 |
| 4h | 34 | 0 | 0.00 | no trades yet |

- last screen: 2026-09-23 01:09 UTC, slice 6, 209 scripts × 35 markets, 3507 runs, 68 passed, 143 min

## Library

- 2588 scripts, 1614 runnable, 974 not
- proposals waiting for you: 0 promotion, 0 demotion
