# Check and test of the "Scanner combinations and strategy design" report (28 Sep 2026)

The report claims the library can support four role-based composite strategies, that the existing
family lab leaks information across its holdout, and that nothing in it is established as
profitable. Every checkable claim was verified against the code, the saved results and the Pine
sources, and the four strategies were then built and run exactly as the report specifies.

## 1. Claims verified

| Claim | Verdict | Evidence |
|---|---|---|
| Registry holds 2,591 entries: 1,617 ok, 620 incompatible, 354 without source | **Correct** | `ScannerRegistry.all()` counts match exactly |
| Family lab `isIndicator()` and `agreement()` use the whole history, not the first half | **Correct** | `familylab.ts` — both iterate the full vote array; only `score()` is split-bounded |
| Trigger eligibility requires entries in both halves; halves split by entry time | **Correct** | `filter(x => x.entryAt < split)`; a trade opened before the split can exit after it |
| Transfer re-enumerates consensus thresholds and lowers trigger k when members are missing | **Correct** | `k = Math.min(t.k, present.length − self)`; the picks file stores no consensus k |
| 4h family5 second-half table (ETH −0.116/−0.121/−0.121, BTC +0.093/+0.593/+0.593, SOL +0.422/−0.255/−0.255) | **Correct** | matches the saved TSVs line for line; ETH is negative at every threshold |
| Liquidity Entry Zones + family7, 4h, k=2: +0.336 ETH (19), +0.417 BTC (27), +0.367 SOL (20) | **Correct** | saved TSVs |
| Market Regime Engine re-clusters on `barstate.islast` as well as every fifth bar | **Correct** | line 68; the probe shows exactly one mismatched bar per centroid at two prefixes, the last bar |
| High Volume Breakout qualifies a breakout by close plus 40% of the candle range beyond the zone, no volume test | **Correct** | lines 18, 199–201 |
| Range Oscillator = 100 × (close − weighted mean) / (ATR × mult), ATR(2000) with ATR(200) fallback | **Correct** | lines 93–120 |
| Zero Lag: EMA(70) lag-adjusted, ATR band, five `request.security` timeframes | **Correct** | lines 7–51 |
| Dynamic Trend Bands' delta volume is inferred from candle direction | **Correct** | lines 86, 126 |
| Liquidity Sweep Filter has separate trend and sweep alert channels | **Correct** | lines 234–239. In this runtime its sweeps surface as shapes; the alertconditions do not fire |
| Decision 45's "family of five transfers" chose BTC k=4 and SOL k=3 after the fact | **Correct** | the report's reading of the transfer stands; decision 45 should be read as a hypothesis |

Nothing in the report was found to be wrong. The runtime probe reproduces from `probe.mjs`.

## 2. The four strategies, tested as specified

Harness: `_research/scanner-combinations-20260928/composite-test.ts`. Delta candles, 15m × 8,000
bars (7 Jul → 29 Sep) and 1h × 3,000 bars (27 May → 29 Sep), ETH, BTC, SOL. Components run through
the Pine worker with audit plots appended in memory (the files were not edited). Fills at the next
open with 2 bp slippage, 0.118% round-trip fee, stop first when stop and target share a bar, one
position per market. Exits as the report proposes: 1.5 × ATR(14) stop from the actual entry, 2R
target, time exit (24 bars for S1/S2, 12 for S3/S4); S4 targets the oscillator's weighted mean and
also exits on a regime change. Each strategy was also run under the fleet's own exit model.
S3's swept level is approximated by the prior 20-bar extreme because the script does not export it.

| Strategy | ETH | BTC | SOL |
|---|---|---|---|
| S1 trend continuation (1h Zero Lag gate, 15m Dynamic break) | 152 trades, −0.29R, halves −0.32 / −0.26 | 179, −0.46R, −0.49 / −0.42 | 186, −0.31R, −0.28 / −0.34 |
| S1 ungated (every Dynamic break) | 197, −0.30R | 208, −0.51R | 220, −0.32R |
| S2 compression-release breakout | 4 trades, +1.16R | 2, +1.85R | 2, +0.37R |
| S2 ungated (every HV breakout) | 6, +0.56R | 2, +1.85R | 6, +0.41R |
| S3 sweep and reclaim | 6, +0.21R | 10, −0.62R | 13, −0.63R |
| S3 ungated (every sweep) | 323, −0.54R | 311, −0.80R | 341, −0.53R |
| S4 range return to value | 83, −0.17R, halves −0.17 / −0.18 | 96, −0.24R, −0.30 / −0.18 | 97, −0.19R, −0.20 / −0.19 |
| S1 under the fleet's exits | 23, −0.13R | 7, −0.25R | 45, −0.21R |
| S4 under the fleet's exits | 81, −0.08R | 79, −0.27R | 100, −0.13R |

Reading:

- **S1 loses in both halves on all three markets**, and the 1h gate removes a fifth of the trades
  without changing the expectancy. The Dynamic break is a losing trigger here whichever exit is used.
- **S4 loses in both halves on all three markets.** The range regime plus oscillator re-entry does
  not pay at 1h on these markets over four months.
- **S2 is positive but has 2 to 6 trades a market** in four months (High Volume Breakout fires 2–6
  times per market). Nothing can be concluded; it cannot carry a book.
- **S3's own filters remove 97% of sweeps** (6–13 trades left) and what remains is mixed; the raw
  sweep is a strongly losing trigger (−0.5 to −0.8R over 300+ trades a market).

So the report's own caveat is the finding: **no combination is established as profitable**, and
the two strategies with enough trades to judge are established as losing at the proposed
specification. The role-based design is sound as a way of writing strategies; it does not by
itself produce an edge from these components.

## 3. What is worth keeping

- The family-lab critique is correct and decision 45 should be re-read: the 4h family is a
  hypothesis selected after the fact, not a transferred strategy. Fixing the boundary (indicator
  test, diversity, eligibility and the exit-after-split trades all first-half only; a frozen
  consensus k in the picks file) is a small change and is the only way the family results can be
  trusted.
- The Liquidity Entry Zones + family7 k=2 candidate is the one row worth a clean retest after that fix.
- The component adapter idea (role, state vs event, availability time, exported levels) is what
  the extractor already lacks and is the same gap that let "Up Warn" be traded as a long.
- Market Regime Engine's last-bar re-clustering must be removed before its volatility class is used.

## 4. Side result: the three stopped-out scanners re-read (from the stop review)

The corrected readings found in the stop review were surveyed on ~80 days of 15m:

| Scanner | Current reading | Corrected reading |
|---|---|---|
| Volume SuperTrend AI, 8 markets | 382 trades, −0.014R | rising edge only: 364 trades, −0.024R |
| ML RSI AI, 6 markets | 496 trades, −0.075R | alert-only (gated L/S): 209 trades, −0.093R |
| Adaptive ATR% Extension, 6 markets | Up/Dn Warn as entries: 710 trades, −0.06R (negative on 5 of 6) | no entry semantic in the script |

Reading them correctly does not make them pay. They have no edge at 15m on these markets under
either reading; the stop review's recommendation to return them to the shadow book stands.
