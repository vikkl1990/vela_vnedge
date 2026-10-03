# Scanner test — 2026-10-03 05:49 UTC

Scripts 3 · timeframes 15m, 1h · markets AKEUSD, ETHUSD, EVAAUSD, FILUSD, LINKUSD, PIEVERSEUSD, SAGAUSD, UNIUSD, ZECUSD, BTCUSD, SOLUSD, XRPUSD · 46 cells with trades.

## value-area-reversion-signals

cells 22 · too few trades to say 22

| market | tf | trades | E[R] | halves | +1R seen | first-bar stops | verdict | fix |
|---|---|---|---|---|---|---|---|---|
| LINKUSD | 1h | 8 | +0.309 | -0.12 / +0.57 | 25% | 13% | too few trades to say | more history or a faster timeframe before judging |
| EVAAUSD | 15m | 2 | +0.980 | -0.95 / +2.91 | 50% | 50% | too few trades to say | more history or a faster timeframe before judging |
| XRPUSD | 1h | 12 | +0.098 | -0.28 / +0.63 | 17% | 17% | too few trades to say | more history or a faster timeframe before judging |
| AKEUSD | 1h | 4 | +0.134 | +0.51 / -0.99 | 0% | 25% | too few trades to say | more history or a faster timeframe before judging |
| ZECUSD | 15m | 4 | +0.129 | +0.00 / +0.13 | 25% | 25% | too few trades to say | more history or a faster timeframe before judging |
| UNIUSD | 15m | 4 | +0.083 | +0.00 / +0.08 | 50% | 25% | too few trades to say | more history or a faster timeframe before judging |
| LINKUSD | 15m | 2 | +0.130 | +0.00 / +0.13 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| SOLUSD | 15m | 2 | +0.095 | +0.00 / +0.09 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| BTCUSD | 1h | 4 | +0.027 | -0.11 / +0.17 | 25% | 0% | too few trades to say | more history or a faster timeframe before judging |
| PIEVERSEUSD | 1h | 1 | +0.095 | +0.00 / +0.09 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| BTCUSD | 15m | 0 | +0.000 | +0.00 / +0.00 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| SAGAUSD | 15m | 2 | -0.124 | -0.95 / +0.70 | 50% | 50% | too few trades to say | more history or a faster timeframe before judging |
| ETHUSD | 1h | 7 | -0.061 | -0.04 / -0.09 | 14% | 0% | too few trades to say | more history or a faster timeframe before judging |
| FILUSD | 1h | 2 | -0.249 | -0.25 / +0.00 | 0% | 50% | too few trades to say | more history or a faster timeframe before judging |
| XRPUSD | 15m | 2 | -0.294 | +0.00 / -0.29 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| ZECUSD | 1h | 6 | -0.117 | +0.36 / -0.35 | 17% | 33% | too few trades to say | more history or a faster timeframe before judging |
| ETHUSD | 15m | 1 | -0.913 | +0.00 / -0.91 | 0% | 0% | too few trades to say | more history or a faster timeframe before judging |
| SOLUSD | 1h | 8 | -0.184 | -0.32 / +0.22 | 13% | 13% | too few trades to say | more history or a faster timeframe before judging |
| UNIUSD | 1h | 6 | -0.300 | -0.02 / -0.58 | 17% | 50% | too few trades to say | more history or a faster timeframe before judging |
| EVAAUSD | 1h | 3 | -0.601 | -0.40 / -1.00 | 0% | 67% | too few trades to say | more history or a faster timeframe before judging |
| SAGAUSD | 1h | 4 | -0.696 | -1.00 / -0.59 | 0% | 25% | too few trades to say | more history or a faster timeframe before judging |
| AKEUSD | 15m | 9 | -0.534 | -0.78 / -0.04 | 0% | 11% | too few trades to say | more history or a faster timeframe before judging |

## mss-sweeps

cells 24 · READING 11 · no variant pays in both halves 7 · COSTS 4 · too few trades to say 1 · pays as read 1

| market | tf | trades | E[R] | halves | +1R seen | first-bar stops | verdict | fix |
|---|---|---|---|---|---|---|---|---|
| ETHUSD | 1h | 79 | +0.128 | +0.24 / -0.01 | 23% | 18% | COSTS: positive before fees, negative after | a slower timeframe or a wider stop/target so each trade pays the round trip several times over |
| ZECUSD | 1h | 119 | +0.068 | +0.16 / -0.02 | 27% | 23% | COSTS: positive before fees, negative after | a slower timeframe or a wider stop/target so each trade pays the round trip several times over |
| BTCUSD | 15m | 5 | +1.208 | +0.87 / +1.71 | 60% | 20% | too few trades to say | more history or a faster timeframe before judging |
| AKEUSD | 15m | 174 | +0.033 | +0.08 / -0.01 | 21% | 26% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| AKEUSD | 1h | 28 | +0.150 | +0.28 / +0.02 | 21% | 14% | pays as read | nothing to fix; measure in shadow |
| UNIUSD | 1h | 105 | +0.040 | +0.12 / -0.05 | 19% | 25% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| XRPUSD | 1h | 92 | +0.010 | +0.22 / -0.24 | 28% | 21% | READING: shorts lose, longs pay | long-only on this market (the script's short logic does not transfer) |
| ZECUSD | 15m | 122 | -0.023 | -0.01 / -0.03 | 29% | 18% | COSTS: positive before fees, negative after | a slower timeframe or a wider stop/target so each trade pays the round trip several times over |
| PIEVERSEUSD | 1h | 105 | -0.040 | -0.10 / +0.02 | 22% | 30% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| SOLUSD | 15m | 44 | -0.100 | +1.02 / -0.31 | 23% | 16% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| BTCUSD | 1h | 61 | -0.076 | -0.08 / -0.08 | 25% | 16% | READING: label mix (alertcondition:Bearish BOS lose; alertcondition:Bullish BOS pay) | read only the paying channel/label (sources or a label allow-list in the scanner config) |
| EVAAUSD | 1h | 92 | -0.051 | +0.09 / -0.19 | 25% | 33% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| FILUSD | 15m | 77 | -0.061 | +0.38 / -0.12 | 19% | 18% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| ETHUSD | 15m | 23 | -0.210 | -0.19 / -0.23 | 17% | 30% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| XRPUSD | 15m | 58 | -0.120 | -0.03 / -0.13 | 19% | 12% | COSTS: positive before fees, negative after | a slower timeframe or a wider stop/target so each trade pays the round trip several times over |
| PIEVERSEUSD | 15m | 70 | -0.119 | -0.30 / +0.01 | 29% | 30% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| SOLUSD | 1h | 111 | -0.082 | -0.11 / -0.05 | 23% | 20% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| SAGAUSD | 15m | 89 | -0.119 | -0.10 / -0.13 | 17% | 25% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| UNIUSD | 15m | 153 | -0.074 | -0.04 / -0.09 | 25% | 28% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| LINKUSD | 15m | 61 | -0.216 | +0.11 / -0.28 | 13% | 26% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| LINKUSD | 1h | 106 | -0.148 | -0.11 / -0.19 | 24% | 25% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| EVAAUSD | 15m | 140 | -0.122 | -0.02 / -0.26 | 27% | 26% | no variant pays in both halves | not a reading, exit or cost problem on this cell; re-time or retire the pair |
| SAGAUSD | 1h | 98 | -0.193 | -0.05 / -0.33 | 26% | 37% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |
| FILUSD | 1h | 98 | -0.235 | -0.49 / -0.02 | 24% | 43% | READING: direction inverted | the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source |

## market-structure-volume-distribution

no cell produced 20+ trades (silent, broken, or too slow a signal on this history)

## Notes