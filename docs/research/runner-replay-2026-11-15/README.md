# Runner replay and stop follow-through (15 November 2026)

Question: trades hit the stop about a third of the time and winners are cut at about +0.5R. Is the exit the leak?

## Method
- `export-trades.mjs` (run on the VM, read-only): 5,600 closed account and shadow trades, entries 33 to 8 days before the run (stratified 15m 1,773 / 1h 2,709 / 4h 1,118; 81 markets).
- `fetch1m.mjs`: Delta India public 1-minute candles for each market from the first entry to 7 days after the last.
- `replay.mjs`: from the minute after the fill, 7-day horizon, stop checked before a same-minute raise (conservative), the recorded per-trade fee in R, no slippage on stop fills. `NOW` is the live exit (arm +0.5R, floor 0.25R, keep 90% / 92% from 2R / 94% from 4R, TP 6R).
- `export-stops.mjs` + `follow.mjs`: what price did in the 24 hours after 450 stopped trades.

## Result (`replay-results.txt`)
- Calibration: replay NOW -0.019R a trade against recorded -0.031R; by side long -0.119 / short +0.098 against -0.123 / +0.076; by timeframe 15m +0.082 against +0.041, 1h -0.024 against -0.041, 4h -0.167 against -0.123. The replay is slightly optimistic, most on 15m.
- No variant beats NOW with any confidence. Best: 50% NOW + 50% runner (arm 1.5R, keep 65%, break-even at 0.5R) +0.007R better, t 1.0, and it swings by period (-0.05 to +0.10). Arming at 1R, holding with the stop only, and unhedged runners are worse (t -1.5 to -3.9). Wider stops at the same dollar risk (1.5R, 2R, 3R) change nothing (-0.013 to -0.024).
- Price after a stop: 36% back to entry within 4h, 62% within 24h; 69% went a further 1R against within 24h; going further first 53% against 41% back first.
- Holding 7 days with only the -1R stop: long -0.61R, short +0.53R. The window fell, so the book's sign is market drift, not entry skill.

## Limits
Script exits, reversals and stop-fill slippage are not modelled; one falling window; 5,600 of 9,144 trades; the sample was taken before the replay, not after seeing it.
