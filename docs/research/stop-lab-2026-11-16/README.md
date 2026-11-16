# Stop and exit definition lab (16 November 2026)

Question: the stop and target logic may be wrong; which definition of the stop, trail and target captures more profit?

Extends [runner-replay-2026-11-15](../runner-replay-2026-11-15/README.md). Same 5,600 closed account and shadow trades (5,378 with 14 closed bars of history before the fill), the same Delta India 1-minute candles, 7-day horizon. Every variant keeps the dollar risk fixed: R is measured in the variant's own stop distance, and the recorded fee in basis points is divided by that distance.

Run from a folder holding `replay-trades.json` and `m1/<SYMBOL>.json` (made by `export-trades.mjs` and `fetch1m.mjs` of the earlier study): `node stoplab.mjs`, `stoplab2.mjs`, `stoplab3.mjs`, then the `*-an.mjs` scripts.

## How results are scored
- **neutral** = mean of the long mean and the short mean. The window fell about 20%, so longs lose and shorts win under every rule; the plain average only measures the long/short mix.
- **t(day)** is the paired difference against the live rule with one observation per calendar day, because trades on one day share the market.
- **mirror** control: the same entries taken on the other side, same distance. Under a driftless path no exit can make money, so a rule's mirror result shows what is drift.

## What the live stop is
Median live stop = 1.52 to 1.56 x ATR14 of the trade's own timeframe on all three timeframes (10th to 90th percentile 1.3 to 2.1 on 1h and 4h). Only 1 to 2% sit at the 3% cap. The code does what it says.

## Results
1. **Stop definitions** (1 to 3 ATR, structural swing of 3, 5, 10, 20 bars + 0.25 ATR, fee floor 100/150/200 bp): none beats the live stop. Best neutral gains are +0.011 (1 ATR on 15m, t 0.6) and nothing reaches t 1.5 on any timeframe except 4h wide stops (+0.12, t 1.3, flips by half).
2. **Trails** (chandelier 1.5 / 2 / 3 ATR): worse on 15m (-0.04) and 1h (-0.06 to -0.09). Looser is not better.
3. **Targets** (fixed 0.3 to 3R, stop -1R): worse on 15m (-0.1 to -0.16) and 1h (-0.06 to -0.15), t -2 to -6. Capping winners costs money; the trail is the right shape.
4. **Time stops** (6, 12, 24 bars): -0.02 to 0. No help.
5. **Earlier arming** (arm 0.2 to 0.3R, keep 95%): +0.02 on 1h (t 2.0, second half about 0), +0.06 on 4h (t 1.0, flips by half), 0 on 15m. Too small to act on.
6. **Scalper Offer window exit** (close a profitable trade just before minute 15 / 30 so the closing fee is waived): 15m -0.006 to -0.017, 1h -0.002 to +0.011. The offer itself is worth +0.008R on 15m through exits that already land inside the window; forcing more exits there gives it back.
7. **Reversal and script exits** (416 trades, -0.29R recorded) were already losing: replay without them is -0.22. Not a leak.

## Where the money is
- Cost: 0.047R a trade in fees against 0.016R gross. Account, last 30 days: 15m fees 516 against net +41.
- Timeframe, neutral, live exit: **15m +0.085 (95% day-bootstrap -> +0.025 to +0.138)**, 1h -0.009 (-0.062 to +0.038), **4h -0.164 (-0.269 to -0.037)**. The account is 80% 15m; the 4h losses sit in the shadow book.
- Side: longs -0.09 to -0.38, shorts +0.05 to +0.16 in this window, for every rule.

## Limits
One falling window, 25 days; stop fills have no slippage; fees split into open and close with a 5.9 bp close assumption for the window test; the replay is optimistic on 15m (+0.081 against +0.041 recorded); about 100 variants tried, so only effects with t above 3 in both halves deserve belief, and none reached that.
