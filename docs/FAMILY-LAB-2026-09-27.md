# Family lab — scripts as indicators, families as strategies — 27 September 2026

`npm run familylab` (server/src/cli/familylab.ts). Results in `data/reports/familylab/`.

## The idea

Every Pine script in the library is asked a different question. Not "when do you say buy?" but
"which way are you leaning, on every closed bar?" — and the answer is read four ways, none of which
depend on the script publishing a signal at all:

| reading | what it is |
|---|---|
| `trail` | the side of price against the script's trailing line, or the majority of its overlay lines |
| `osc` | the sign of its pane oscillator against zero or the middle of its range |
| `color` | the colour it paints its plots: green-ish up, red-ish down |
| `event` | the last direction it called (alert or shape), held until it calls the other |
| `vote` | the majority of the four |

Each reading is a series of −1/0/+1 per bar. Labels are deliberately **not** a reading — their time is
the pivot they point at, not the bar they were drawn on (decision 44).

A **family** is then built from data, not by hand, on the **first half** of history only:

1. every reading of every script is scored: does the vote agree with the sign of the next H bars?
   (H = 24/16/12/8 bars on 5m/15m/1h/4h). A reading that anticipates the move backwards is kept,
   inverted (`⁻`).
2. a reading must behave like an indicator: ≥1% of bars are direction changes and ≥15% of its time
   is spent on each side. A constant "up" scores beautifully in any rising half and knows nothing.
3. the family is greedy-diverse: the best reading first, then the next best whose votes agree with
   no member more than 50% of the time, at most a third of the family from one category. Sizes 3, 5, 7.

Two strategies, backtested with the live exit rules on 1m/15m sub-candles, halves reported:

- **consensus** — no trigger. Enter when the family's summed vote crosses +k (long) or −k (short).
- **trigger + family** — every script's own entries, kept only when the family agrees by ≥ k. k is
  chosen on the first half; the second half is the verdict.

Then the families and thresholds chosen on ETH are applied **unchanged** to BTC and SOL
(`STAGE=transfer`): every bar of those markets is out of sample.

## What the library yields

667 runnable scripts; 528 run on ETH (139 fail deterministically: 72 on `request.security` of
non-Delta symbols, the rest on runtime gaps). Of those, on each timeframe about 200 scripts produce
at least one reading that behaves like an indicator (~400 readings). Informative on the first half at
|t| ≥ 3: 115 on 5m, 76 on 15m, 45 on 1h, 24 on 4h — the count falls with the bar count, as it should.
The `event` reading dominates the informative set, and most of those are **inverted**: the last call
of a retail TradingView strategy, faded, anticipates the next day better than followed.

## Results, ETH (fitted on the first half)

Consensus alone rarely fires — a summed vote crosses ±k a few dozen times in 4,000 bars:

| tf | family | k | trades | avg R | 1st half | 2nd half |
|---|---|---|---:|---:|---:|---:|
| 1h | 7 | 4 | 46 | +0.227 | +0.390 | **−0.027** |
| 4h | 3 | 2 | 35 | +0.296 | +0.687 | **−0.168** |
| 4h | 5 | 4 | 28 | +0.116 | +0.354 | −0.121 |

Nothing on 5m or 15m; nothing that holds its second half on ETH.

Trigger + family, second half only, all triggers with ≥15 entries in each half:

| tf | family | triggers | filter raised R/trade | filtered total R > 0 | unfiltered total R > 0 |
|---|---|---:|---:|---:|---:|
| 15m | 7 | 250 | 210 (84%) | 41 | 39 |
| 1h | 7 | 249 | 193 (78%) | 86 | 57 |
| 4h | 5 | 175 | 120 (69%) | 41 | 34 |

The filter raises R per trade on three quarters of triggers — but the universe of triggers is so
negative (about −8R per trigger per half) that raising R/trade mostly means losing less.

## Results, BTC and SOL (never fitted)

The same families, the same k, applied to markets that had no part in choosing them. The 4h
family of five is `scalper-s-moving-average-dyna[event⁻]`, `inside-day-breakout-strategy[event⁻]`,
`trend-pulse-channel-strategy[color⁻]`, `joel-on-crypto-macd-scalping[vote]`,
`pm-range-breakout-retest-fade[event⁻]`.

**Consensus, 4h:**

| market | family | k | trades | avg R | halves | long | short |
|---|---|---|---:|---:|---|---|---|
| BTC | 3 | 2 | 40 | **+0.425** | +0.376 / +0.474 | 24 / +0.29 | 16 / +0.63 |
| BTC | 5 | 4 | 27 | **+0.576** | +0.563 / +0.593 | 14 / +0.50 | 13 / +0.66 |
| SOL | 5 | 3 | 69 | **+0.411** | +0.385 / +0.422 | 36 / +0.38 | 33 / +0.44 |
| SOL | 7 | 5 | 54 | +0.359 | +0.285 / +0.406 | 30 / +0.44 | 24 / +0.25 |
| ETH (fitted) | 5 | 4 | 28 | +0.116 | +0.354 / −0.121 | 13 / −0.07 | 15 / +0.28 |

**Trigger + family, whole history, sum across all triggers:**

| market | tf | family | triggers | R/trade up | total R > 0 (unfiltered) | Σ unfiltered | Σ filtered | long /t | short /t |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| BTC | 4h | 5 | 170 | 136 (80%) | 98 (31) | −1,640R | **+447R** | −0.006 | +0.143 |
| BTC | 4h | 3 | 176 | 139 | 91 (32) | −1,682R | +201R | −0.016 | +0.077 |
| SOL | 4h | 5 | 174 | 162 (93%) | 138 (51) | −959R | **+1,059R** | +0.137 | +0.151 |
| SOL | 4h | 7 | 151 | 133 | 112 (42) | −924R | +842R | +0.096 | +0.183 |
| BTC | 1h | 7 | 244 | 194 (80%) | 122 (49) | −3,969R | −19R | −0.009 | +0.016 |
| SOL | 1h | 5 | 237 | 186 | 131 (66) | −3,113R | +245R | +0.015 | +0.114 |
| BTC | 15m | 7 | 244 | 130 | 69 (35) | −2,536R | −463R | | |
| SOL | 15m | 7 | 247 | 152 | 74 (24) | −5,545R | −835R | −0.114 | −0.143 |

On **4h**, a family chosen on ETH's first half turns the whole trigger universe from a large loss into
a gain on two markets it never saw, raises R per trade on 80–93% of triggers, and does it on both
sides of the market. On 1h it breaks even; on 15m and 5m it does nothing.

## What this does and does not establish

It establishes that the *reading* is real: the leaning of a script's lines, colours and last calls
carries information about the next few 4h bars that transfers across markets, and that agreement
among five unrelated readings is a filter the fleet has never had — every entry filter measured
before (trend gate, learned model, a second script's reversal signal) failed the halves test on the
market it was fitted on. This one passes on two markets it was not fitted on.

It does not establish an edge to trade yet:

- **One window, three correlated markets.** All three 4h histories are the same 333 days, and the
  window is a bear market on all three. Both sides are profitable, which argues against a plain
  short bias, but the sample of independent regimes is one.
- **ETH's own second half is weak.** The market the family was fitted on is the one where it fades.
- **Small consensus samples.** 27–69 trades per market for the standalone strategy.
- **The 4h family is four faded strategies and one MACD.** "Do the opposite of what retail
  strategies last said" is a coherent hypothesis; it is also the kind that stops working when the
  strategies change. The family must be re-derived, not frozen.
- **Duplicates inflate the trigger counts.** Many triggers are variants of one script.

## Next, in order

1. **Forward evidence, not more backtests.** A `family` scanner in the runtime: runs the five 4h
   members each bar, sums the votes, enters on the cross of ±k (SOL's k=3 / BTC's k=4) — into the
   **shadow book** through the incubator cohort gate, on the 12-market 4h cohort. Nothing is
   promoted on this document.
2. **Re-derive monthly.** The family is a fit; it should be recomputed on a rolling first-half and
   the members compared. A family whose members churn every month is noise.
3. **A second window.** Delta's 4h history reaches 2,000 bars; the same test on the *earlier* half of
   a longer history from another source would give a second regime.
4. **Family as a filter on the live fleet's 4h entries**, only after 1 shows a cohort verdict.

Not on the list: 5m and 15m. The reading carries nothing there, on any market.
