# Trades that never move and hit the stop — study of 2026-09-28

Question: many trades never make a move and hit the stop. What do they have in common?

Sample: live book since 2026-09-27 (32 closed trades) and the shadow book over the last 14 days
(394 closed trades, 332 on 15m with candle history). "Never moved" = stopped out with a peak
excursion under +0.3R. Candles are Delta 15m history; ATR is Wilder 14 on closed bars before entry.

## What the live sample shows (32 trades)

| outcome | n | avg R | median peak | median life |
|---|---|---|---|---|
| trail exit | 19 | +0.36 | +0.84R | 13 min |
| never moved, stopped | 10 | −0.92 | +0.02R | 6 min |
| break-even exit | 2 | +0.85 | +1.70R | 19 min |
| stopped after a move | 1 | −0.98 | +0.32R | 46 min |

The ten never-moved trades cost 9.2R; the 21 winners made 8.5R. Net −1.6R over 32 trades
(+$31 in dollars because the winners were sized larger).

What the ten have in common, against the winners:

| measure (median) | never moved | winners |
|---|---|---|
| signal bar, body in the trade's direction, in ATR | +1.02 | +0.89 |
| move over the 3 bars before entry, in ATR | +1.69 | +1.12 |
| range of the bar entered on, in ATR | 1.54 | 1.12 |
| stop distance, in ATR | 0.90 | 0.97 |
| minutes into the bar at entry | 0 | 0 |
| signal → entry delay | 15 min (one bar, correct) | 15 min |
| entry vs signal price | 0.00R (no chase in price) | 0.00R |

Six of the ten were stopped inside the very first bar after entry (three to six minutes). The
picture: the scanner fires on a bar that is itself a full ATR in the trade's direction, the fleet
enters at the open of the next bar, that bar is 1.5–2.9 ATR wide, and a 0.9 ATR stop set from a
lagging ATR(14) sits inside its noise. After the stop, price came back to the entry within two
hours in 6 of 10 and also went on to −2R in 7 of 10: whipsaw in both directions, not a wrong side.

Concentration:

- **Two scanners account for 7 of the 10**: Machine Learning RSI AI (4 of its 5 live trades never
  moved, −3.4R) and Adaptive ATR Extension (3 of 3, −2.7R). Both fire after extended bars.
- **Three came in the same minute** at 00:00 UTC (05:30 IST) on SOL, DOGE and AVAX: one market
  move, three stops. Two more at 22:00 UTC on XRP and ZEC. Half the never-moved trades had another
  never-moved entry within 30 minutes.
- **The same scanner re-entered SOL twice** an hour apart after the first stop (#557, #560).
- The :00 bar of hours 22, 23, 02, 05, 09 and 12 UTC is 20–60% wider than the rest of the hour
  across all symbols; a modest effect, not the driver.

## Shadow sample (332 trades on 15m)

Never moved 38%, winners 42%. The same "chase band" shows: when the three bars before entry moved
1–2 ATR with the trade, 57% never moved and expectancy was −0.45R, against 33% and −0.10R when the
prior move was against the trade. Stop distance did not separate the groups (1.47 ATR both). After
the stop, 57 of 126 came back to entry and 57 went on to −2R — the same whipsaw.

## Fixes tested (first-touch model, +1R vs stop, 16 bars, R re-based to each variant's stop)

| variant | live E[R] (32) | shadow E[R] (332) |
|---|---|---|
| A baseline | +0.19 | −0.14 |
| B stop at least 1.0× the signal bar's true range | +0.18 | −0.16 |
| B2 stop at least 1.5× signal-bar range | +0.04 | −0.15 |
| C skip when the signal bar exceeds 1 ATR with the trade | +0.11 | −0.16 |
| C2 skip when the prior 3 bars moved 1–2 ATR with the trade | +0.26 | −0.10 |
| C3 skip when the signal-bar range exceeds 1.5 ATR | +0.53 | −0.24 |
| D pullback limit at close − 0.3 ATR, two bars | +0.18 | −0.18 |
| E enter only after one confirming bar | +0.33 | −0.34 |

Wider stops do not help: the whipsaw runs both ways and a wider stop just loses more per unit.
Pullback and confirmation entries lose the winners that run immediately. C3 looks brilliant on the
32 live trades and is the worst on the 332 shadow trades — an overfit. Only C2 survives both
samples, and mildly. There is no mechanical entry or stop rule in this data that fixes the
pattern; the pattern is which scripts fire and when.

## Conclusion

Never-moved stops are a property of extension-chasing scanners and of correlated entries in the
same minute, not of the stop distance. The exit policy (lock, trail) is not the cause and widening
stops would make it worse.

Recommended, awaiting the operator:

1. **Return Machine Learning RSI AI and Adaptive ATR Extension to the shadow book** on 15m until
   they pass the halves screen. Together they are 8 of 32 live trades and −6.1R.
2. **Burst throttle**: at most one new entry per two-minute window across the fleet, or at most
   one per direction; the 00:00 UTC triple would have been one trade.
3. **Re-entry cooldown**: no re-entry by the same scanner on the same symbol for 60 minutes after
   a stop (`risk.cooldownAfterLosses` exists but is off; a per-symbol variant is the one wanted).
4. **Chase band as a soft filter** (C2) only after it has been measured on more live trades; do
   not ship it on 32.

## Addendum 2026-09-29: every live stop reviewed (16 of 45 closed trades)

Mechanics are clean on all sixteen: stop distance exactly 1.00 × ATR(14) Wilder on 15m
(`fallbackAtrSl: 1`), stop fills 2 bp past the stop, fees about $1.60 a trade, net −0.88 to −0.98R
(fees and slippage take 0.05–0.10R). Every stop was the original stop; none had been moved.

| # | IST | scanner | market | side | stop % | life | peak | after 2 h | 4 h drift |
|---|---|---|---|---|---|---|---|---|---|
| 488 | 28 01:00 | Smart Swing VWAP | EVAA | L | 1.29 | 6 m | −0.07 | continued, −2R | −3.0R |
| 494 | 28 01:45 | ML RSI AI | AVAX | L | 0.52 | 6 m | −0.11 | continued, −2R | −2.4R |
| 499 | 28 04:15 | Volume SuperTrend AI | XRP | S | 0.51 | 17 m | +0.21 | continued, −2R | +0.6R |
| 500 | 28 04:16 | Volume SuperTrend AI | ZEC | S | 0.62 | 46 m | −0.05 | came back, +1R | +2.4R |
| 506 | 28 06:00 | Adaptive ATR Extension | SOL | L | 0.49 | 3 m | −0.08 | came back, −2R | −4.6R |
| 507 | 28 06:00 | ML RSI AI | DOGE | L | 0.64 | 3 m | +0.08 | came back, −2R | −5.8R |
| 509 | 28 06:01 | ML RSI AI | AVAX | L | 0.71 | 3 m | −0.07 | came back, −2R | −3.1R |
| 514 | 28 06:45 | ML RSI AI | MUBARAK | S | 1.13 | 7 m | +0.24 | came back, −2R | −3.0R |
| 523 | 28 09:45 | Volume SuperTrend AI | LINK | S | 0.80 | 46 m | +0.32 | came back, +1R | +2.3R |
| 557 | 28 22:00 | Adaptive ATR Extension | SOL | L | 0.66 | 12 m | +0.26 | came back | −1.6R |
| 560 | 28 22:45 | Adaptive ATR Extension | SOL | L | 0.73 | 12 m | +0.29 | continued | −2.5R |
| 562 | 28 23:15 | Session Killzones | AKE | L | 2.16 | 4 m | +0.05 | continued, −2R | −2.1R |
| 570 | 29 03:00 | AI Predictive Flow | UNI | L | 0.85 | 31 m | −0.05 | came back, +1R | −1.8R |
| 573 | 29 03:45 | Volume SuperTrend AI | DOGE | S | 0.61 | 22 m | +0.04 | continued, −2R | +0.4R |
| 576 | 29 05:30 | Pivot Channel Breaks | ZEC | L | 0.74 | 52 m | +0.48 | continued, −2R | −8.0R |
| 583 | 29 06:17 | Volume SuperTrend AI | AAVE | L | 0.58 | 11 m | −0.06 | came back, −2R | −2.3R |

Reading: 10 of 16 were stopped inside the first bar; none lived past an hour. 11 of 16 went on to
−2R within two hours and only 4 drifted with the trade over four hours — the stop was right about
the direction in three cases out of four. Three were true whipsaws that would have paid (ZEC #500,
LINK #523, UNI #570): 19% of stops, the normal cost of a 1 ATR stop. The signal bar had a body of
at least +0.5 ATR in the trade's direction in 13 of 16, median prior three-bar move +1.5 ATR.
Three fired in the same minute at 06:00 IST. Machine Learning RSI AI (4 of 4) and Adaptive ATR
Extension (3 of 3) have not produced a stop that was not a first-bar stop; Volume SuperTrend AI's
five stops came later (11–46 min) with some excursion first, the normal shape of a losing trade.
Live book to date: 45 trades, net −$28.67, −4.57R; 26 trail exits average +0.36R against 16 stops
at −0.94R.
