# Per-scanner meta signal study (research only)

The `server/src/meta/signals.ts` evaluator joins **one scanner** across timeframes. It is separate from the existing same-timeframe, multi-scanner ConsensusFilter. It is not connected to ScannerEngine's entry filter, PaperEngine, account configuration or order execution. A READY result is evidence alignment, not a trade approval.

## Fixed reading hypotheses

| Scanner | Fresh entry event | Higher-timeframe context |
| --- | --- | --- |
| Adaptive MACD | Histogram crosses zero on adjacent closed bars (MACD/Signal crossover) | Sign of the exact closed-bar MACD plot |
| Adaptive Squeeze Momentum Pro | Explicit derived `Squeeze fired` event | Sign of the exact closed-bar Momentum plot |

These are explicit bot research interpretations. A plotted oscillator or a scanner's name does not establish profitability. No generic bullish labels, divergence drawings or stale historical entry directions substitute for the specified plots/events.

Scalp uses a 15m event with 1h context; 4h is informational. Swing uses a 1h event with 4h context; 15m is informational. Every event expires after one entry candle. Context is refreshed from each latest closed candle; absence, stale data, non-finite/ambiguous plots, unscheduled cells, scanner errors or source/settings drift produce UNKNOWN. Contradictory same-bar triggers produce UNKNOWN. Neutral/opposite context blocks a fresh trigger. Missing reference evidence does not secretly veto the decision.

Higher candles are usable only after close. Actual per-bar `availableAt` timestamps can further delay usability; historical runs without those timestamps explicitly mark evidence `assumed-bar-close`. Missing data is never forward-filled. The deterministic READY key includes version, scanner, symbol, profile, trigger and source/settings fingerprints. Any future activation must persist consumed keys; this research module does not submit or deduplicate real orders.

## Reproduce

From the repository root:

```sh
META_CONFIG=/path/to/config.json OUT_DIR=/path/to/research npm run metastudy --workspace=server
```

Optional `MARKETS=BTCUSD,ETHUSD,SOLUSD`, `DAYS=56`, `END_MS=<closed 4h boundary>` and `HISTORY_DIR=<cached symbol-tf-end.json bars>` freeze the input window. The command caches worker outputs by source/settings and bar content, uses canonical `readingOf` extraction, writes candidate decisions with their evidence/reasons, and compares standalone vs confirmed entries on identical current account policy. It never changes a bot setting or writes orders. Do not run it on a resource-constrained production VM while live scanner work is due.

The comparison isolates confirmation; it does **not** optimise or certify separate scalp/swing exit mandates. It uses minute execution bars and reports funding/depth/crossing cost coverage. Current source/settings are replayed retrospectively; the chronological later half is not a genuinely unseen forward test. Queue/run arrival times, historical spread and exact funding are absent unless explicitly supplied by a future study integration.

All symbols receive a join-prefix check. The first symbol also gets a new Pine run with later candles removed, comparing earlier meta decisions. These checks are targeted future-data sensitivity tests, not universal non-repainting certification.

## Result of the initial fixed-window test

56 days, BTC/ETH/SOL: MACD produced 857 aligned 15m candidates and 213 aligned 1h candidates; Willy produced 283 and 65. Candidate counts precede fee/risk/fill admission. The four pooled confirmation variants remained negative under the unchanged current exits. In particular, Willy's Momentum-based context did not improve this sample. Do not enable these profiles based on cleaner readings alone.

Next stage: the Frames UI should display server-observed evidence (including arrival time and scheduled status), with per-frame journal isolation. This release provides a research matrix and reproducible evaluator, not a live Frames dashboard or an activated strategy. Define and test mandate-specific exits before any trading promotion.
