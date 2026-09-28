# AlgoAlpha and BigBeluga — inventory, profile, reading, survey — 28 September 2026

The same pass as the WillyAlgoTrader rebuild (`docs/WILLY-REBUILD.md`), on the two largest
authors in the library.

## Inventory

| author | published on TradingView | in the library | runnable | `strategy()` |
|---|---:|---:|---:|---:|
| AlgoAlpha | 143 | 143 | 133 | 0 |
| BigBeluga | 206 | 206 (Session VWAP Profile + Candle Delta imported today) | 194 | 0 |

## What they produce in our runtime (ETH 15m/1h/4h, `npm run profile`)

| | plan | signal | levels | silent | broken |
|---|---:|---:|---:|---:|---:|
| AlgoAlpha | **0** | 55 | 25 | 7 | **56** |
| BigBeluga | **0** | 16 | 80 | 9 | **101** |

**Neither author publishes a trade plan.** None of the 349 emits an `alert()` carrying a stop and
targets; the signals are `alertcondition()` titles and plotted shapes — indicators by design.
Every entry from them runs on our ATR stop and ladder. BigBeluga is mostly *levels* (zones,
profiles, heatmaps) — family-lab readings, not scanners.

**Half of them do not run here.** 157 broken: 43 transpile failures, of which **23 `import` a
TradingView library** PineTS cannot resolve and the rest use `type`/`switch`/`for…in`/`polyline`;
29 runtime TypeErrors; 27 worker crashes; 22 hangs; 21 with no source; 5 invalid timeframe. For
BigBeluga that is 49% of the catalogue. The runtime is the ceiling for these authors, and library
imports alone are a fifth of the failures.

## The reading (decision 57)

Their conditions are *states* — "bullish" is true on every bar of a trend — so the extractor made
an entry per bar: 6,742 "entries" from one script on ETH. The reading is now **rising-edge** for
them: one entry on the first bar of a run of a condition or shape (`edge: true` in
`scripts/specs.json` for the 65 signal scripts outside the fleet). The six of their scripts
already in the fleet keep the reading they were measured with until edge is measured for them.

## Survey — 65 signal scripts, 8 markets, 15m/1h/4h, halves

| author | tf | cells | trades | total R | net $ | 1st half | 2nd half | cells + in both halves |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| AlgoAlpha | 15m | 413 | 132,395 | −16,223 | −181,270 | −5,517 | −10,703 | 8 |
| AlgoAlpha | 1h | 421 | 114,113 | −8,771 | −124,171 | −3,537 | −5,233 | 21 |
| AlgoAlpha | 4h | 413 | 56,523 | +188 | +5,336 | +932 | −743 | 82 |
| BigBeluga | 15m | 89 | 8,339 | −1,090 | −18,090 | −455 | −634 | 0 |
| BigBeluga | 1h | 96 | 6,965 | −366 | −7,045 | −149 | −217 | 6 |
| BigBeluga | 4h | 96 | 3,089 | +77 | +1,436 | +95 | −18 | 15 |

The Willy shape again: everything loses on 15m and 1h; 4h is flat-to-positive with pockets. The
oscillator scripts still trade every few bars even at rising edge — that is what they are.

Scanner × timeframe pooled over the 8 markets, positive in both halves, ≥60 trades, ≥5/8 markets
positive — 10 of 194 cells:

| scanner | tf | trades | total R | net $ | halves | markets + |
|---|---|---:|---:|---:|---|---:|
| breakout-targets (AA) | 1h | 126 | +23.0R | +446 | +0.153 / +0.207 | 8/8 |
| swing-traces (BB) | 4h | 584 | +47.1R | +956 | +0.064 / +0.096 | 7/8 |
| high-probability-order-blocks (AA) | 4h | 314 | +32.8R | +646 | +0.162 / +0.045 | 7/8 |
| volume-trend-order-block-engine (BB) | 4h | 157 | +10.2R | +195 | +0.084 / +0.044 | 6/8 |
| institutional-displacement-volume-delta (BB) | 4h | 604 | +28.0R | +504 | +0.086 / +0.014 | 7/8 |
| multi-spectral-rsi-deviations (AA) | 4h | 1,955 | +111.7R | +2,594 | +0.110 / +0.010 | 8/8 |
| median-proximity-percentile (AA) | 4h | 2,366 | +97.2R | +2,183 | +0.082 / +0.004 | 7/8 |
| volume-weighted-median-oscillator (AA) | 4h | 1,667 | +66.8R | +1,451 | +0.064 / +0.017 | 7/8 |
| wavetrend-ribbon (AA) | 4h | 1,687 | +16.4R | +430 | +0.017 / +0.003 | 5/8 |
| rolling-point-of-control-poc (AA) | 4h | 1,135 | +11.5R | +209 | +0.000 / +0.019 | 5/8 |

The first four have a second half that means something; the oscillators below them are positive
in both halves by a hair, on thousands of trades — a coin that came up heads twice.

## What was done with it

The 50 scanner × market pairs that pass the screen in halves (44 at 4h, 6 at 1h) were recorded
as incubator candidates and are **in the shadow book** as of 04:12 UTC, trading live data in 4h
and 1h cohorts. The cohort gate decides in weeks; nothing was promoted on this survey. To make
room, the 162 candidates screened under the old single-run rule were set aside for the daily
screen to re-judge in halves, and the shadow book grew to 150 slots (4h pairs cost almost nothing
to run). Rows: `data/reports/2026-09-28-algoalpha-bigbeluga-survey.tsv`, candidates in
`…-candidates.json`.

## Next for these authors

1. Runtime: library `import` support in PineTS (23 scripts), then the `type`/`switch` syntax; that
   unlocks more scripts than any reading change.
2. Measure rising-edge on the six fleet scanners from these authors before switching them.
3. The 80 BigBeluga level tools belong in the family lab as readings, not in the fleet.
