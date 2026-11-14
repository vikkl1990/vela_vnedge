# Native contract corrections — 14 November 2026

The first readiness corrections address two enabled source families through separate experimental shadow profiles. Existing account readings, allocations and evidence remain unchanged. These are execution/interpretation corrections, not a demonstrated profitability improvement.

| Source | Current limitation | Isolated corrected profile |
| --- | --- | --- |
| Smart Money Breakout Signals (AlgoAlpha) | The deliberate long-only reading has no access to native price geometry. | Confirmed breakouts on either side, actual source SL and ordered TP milestones; full closure at farthest TP. |
| Machine Learning RSI (Zeiierman) | Broad markers can become entries; native Supertrend management is absent. | Confirmed classifier entries only; Supertrend protective stop, causal tightening and opposite-side flip close; no invented fixed target. |

The retained Pine source is unchanged. A SHA-256 guarded adapter appends observation-only hidden plots to each new profile; it does not recalculate the author's formulas or read final drawing coordinates as historical prices. Runtime hashes and separate scanner/plan identities bind the resulting evidence. Source changes fail the adapter closed. The current long-only/flip-marker readings remain available for comparison and keep their original histories.

Native prices must still be valid at signal close, the current quote, after tick rounding and after execution latency. Crossed stops, passed targets and merged target rungs refuse the new setup; the engine cannot silently substitute an ATR stop or delete a target milestone. Existing readers retain their prior behavior. Stop amendments take effect after acknowledgement and survive restart; market exits use causal depth/tape execution. TP1/TP2 are milestones, not invented partial sales or break-even orders. The two new profiles explicitly turn off the bot's unrelated floor, stale exit and trailing overlays.

## Validation

On 1,019 closed ETHUSD 15m candles (3–14 November):

| Reading | Current entries | Native entries | Native simulated fills | Prefix checks |
| --- | ---: | ---: | ---: | ---: |
| Smart Money Breakout | 2 | 6 | 4 | 6 |
| ML RSI | 32 | 6 | 6 | 48 |

The Smart Money control is deliberately long-only; the extra four signals are a separate both-side hypothesis. ML RSI's reduced count removes regime flips, not a relaxed classifier threshold. Uninstrumented and instrumented source alerts/shapes match exactly at identical inputs. Prefix checks cover every candidate entry/flip and sampled ML stop amendments; they do not claim exhaustive equivalence over every market or arbitrary input override. Each shadow replay survives seven restarts, pays full fees, remains within the $30 stop ceiling on its $1,000 research purse, and contributes zero promotion-eligible positions.

The historical execution harness uses an explicitly synthetic OHLC-derived tape/depth path with 100ms latency, quote requirements disabled for mechanics, and the unchanged 6× fee test. These are **not executable historical fills, measured latency, profit estimates, or promotion evidence**. Live experiments inherit the production quote/depth, latency, fee and risk settings. Detailed results, dataset hash and source hashes are in `native-contract-lifecycles-2026-11-14.json`. Reproduce with `node ops/validate-contract-lifecycles.ts /path/to/ETHUSD-15m.json`.

Regression coverage includes native geometry, missing/duplicate/time-mismatched plots, correct flip side, false flip entries excluded, legacy readers unchanged, source pin failure, delayed fill cancellation, rounding, causal stop acknowledgement, restart recovery, full TP3 closure, fees, isolated evidence, atomic dry-run/idempotent activation and capacity checks.

## Rollout and remaining work

`ops/enable-contract-lifecycle-shadow.ts --dry-run` validates two ETHUSD 15m plans. Apply with the service stopped. Research capacity is explicitly extended 34 → 36 to retain all existing experiments; this does not increase paper position capacity, leverage, per-trade margin or risk ceilings. Only `executionPlans` is changed in the stored configuration. No account scanner is enabled and no experiment is admitted to paper.

The readiness matrix names the supported adapter on the new profiles while retaining legacy lifecycle gaps on the current readers. This batch does not resolve the other library gaps. Alphamojo's stop-entry/HA data semantics and unimplemented per-author lifecycles remain separate work; author contract correctness is not evidence of a profitable strategy. Prospective shadow observations must still pass the existing evidence rules before any paper adoption.
