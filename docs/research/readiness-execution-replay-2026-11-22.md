# Readiness recovery after execution version 212

The snapshot at 22 November contains 1,072 closed paper trades inside the 30-day window. One matches the current policy, 680 were excluded for execution version, 389 have no original policy and two were adopted with unknown original settings. No trades were deleted.

Of 517 version-211 trades, 402 also pass the existing source, reader, fee, risk and policy compatibility checks. Replay used 12,088 consecutive, checksum-verified broad archive segments and 2,772,859 selected events. Original received candle callbacks, ticks and marks were kept in archive order. Recorded exit depth supplied the settlement price, quantity and fees; no final-candle reconstruction or hypothetical entry was used.

| Outcome among the 402 otherwise-compatible trades | Trades |
| --- | ---: |
| Original execution reproduced, and version 212 gives the same execution | 130 |
| Execution changed under 212 | 13 |
| Outside retained coverage | 68 |
| Unsupported lifecycle, including funding/partial or non-price exits | 116 |
| Capture or process gap | 28 |
| Symbol capture selection changed | 13 |
| Missing pre-entry tape ordering | 31 |
| Entry event ordering ambiguous | 2 |
| Original execution could not be reproduced | 1 |

The 130 identical executions include 93 winners and 37 losing stop exits, across 49 scanners and 23 markets. Their original combined net result is $136.3266723272795. This is a description of the verified subset, not a profit improvement. Twelve of the 13 changed executions were originally winners; their original results must not be credited to the new model. Trade 22177 is the baseline mismatch and remains excluded.

The fix retains only exact execution matches as a separate readiness category. It does not change original trade rows, policies, risk caps, source/reader contracts, promotion, copying, leverage evidence or the 200-trade threshold. Different executions and missing inputs stay excluded. This conditional subset does not establish complete-policy profitability; forward evaluation is still required.

Reproduce with `ops/replay-readiness-execution.ts` using the snapshot, filtered archive and its manifest, and policy catalogue saved under `work/readiness-execution-replay-20261122` in the task workspace. The filtered archive is `readiness-complete-20261122.ndjson.gz`; the full result is `execution-report.json`. On the VM the checksum-verified input bundle is retained under `/opt/vnedge/data/` with the same date. `--record` writes separate audit receipts only, refuses production-enabled configuration, and rechecks each execution ledger before saving. A changed ledger or target policy invalidates its receipt.

Validation: 1,881 server tests, 104 dashboard unit tests, server typecheck, dashboard build and lint passed locally. Fourteen execution-replay regressions cover both sides, winners and losers, candle and queued-amendment changes, missing coverage, exact timing, late-reported capture gaps, quarantine, receipt tampering and harmless later feature enrichment. CI and VM deployment verification are recorded in PR #99.

Entry-boundary hardening: replay algorithm 2 independently tests every possible commit boundary within the entry millisecond and seeds pre-entry marks without allowing a liquidation before entry. Boundary-sensitive histories remain unverified. The strengthened replay and its independent VM run are saved as `execution-boundary-report.json` and `preview-boundary.json`.
