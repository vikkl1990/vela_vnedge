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
