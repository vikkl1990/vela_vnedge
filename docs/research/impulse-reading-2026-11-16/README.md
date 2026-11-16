# Trend Impulse Channels: which side does the script mean, and does it matter? (16 November 2026)

The script (`scripts/pine/d3IaFa7c-Trend-Impulse-Channels-Zeiierman.pine`) prints only two trade markers, both only in the direction of its own trend: **Lower Retest** (up-triangle below the bar, uptrend) is its long and **Upper Retest** (down-triangle above the bar, downtrend) its short. The account's base id `trend-impulse-channels-zeiierman` reads them the other way (`scripts/specs.json`; decision 195 kept it because that reading earned the early record). The `-native` variant reads them as drawn.

## Method (`ti-spread.mjs`)
All 766 closed shadow trades of the base id (23 Sep to 16 Nov, 22 markets). For each event both sides are replayed from the fill on Delta India 1-minute candles with the live exit (arm 0.5R, keep 90/92/94%, TP 6R, stop 1.5 ATR as recorded, 7-day horizon, recorded fee). d = (R_long - R_short) / 2 is the move the event offered. Spread = mean(d | base went long) - mean(d | base went short): market drift is common to both groups and cancels. Spread above 0 means the base reading picks the better side, below 0 the as-drawn one. Confidence interval: bootstrap by calendar day.

## Result (`results-spread.txt`)
- Spread -0.010 R, 95% interval -0.19 to +0.15. No timeframe, week or regime has an interval that excludes 0. The two readings are indistinguishable.
- Taking both sides of every event: +0.290 R an event from 23 Sep to 19 Oct, +0.005 from 20 Oct to 2 Nov, +0.023 from 3 Nov. The early record was a property of the events (timing and volatility), not direction, and it faded. The account began trading the scanner on 17 Oct.
- An earlier 219-trade mirror sample (+0.134 R for the as-drawn reading) fell to t 0.6 once controlled by day and side; the full set confirms there is nothing there.

## Limits
Replay without slippage (optimistic by about 0.05 R against recorded results); one window, 8 weeks; live shadow comparison `reader-impulse-init-15m` holds 4 and 3 trades so far.
