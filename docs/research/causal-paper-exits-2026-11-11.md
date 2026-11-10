# Phase 1: causal paper market exits

Prepared 11 November 2026 IST (10 November UTC). Baseline: `84a49fd37a65e5ef109c26621aa45497bb30a90b`. Scope: paper execution accuracy; no scanner selection, capital, risk, leverage, live permissions or offer changes.

## Delivered model

New positions bind simulation version 211. A stop, trailing stop, manual/script exit, funding exit or liquidation observation creates a durable market-exit intent. The position stays exposed and keeps its remaining margin until an execution report commits. Reports use observed sell-side bids for longs and buy-side asks for shorts, walking only available integer contract quantities, after the bound 1,500ms latency. Spread and depth impact are included in the price once; commissions and GST still use the bound fee policy. Partial fills release only their filled quantity. Missing/stale/invalid depth leaves an explicitly pending exit.

BTC/ETH/SOL prefer the existing sequence/checksum-validated L2 stream. Other markets use public Delta India L2 reads, with a 2-second timeout, no nested retries, at most two concurrent reads and four starts/second. Retries rotate fairly; account exits have priority over independent shadow trials. Both receipt and exchange clocks must be within one second, and receipt must follow simulated order arrival. A REST timestamp is not replaced with local time to make stale data look fresh. Public REST sampling on twelve markets showed why the stream matters: all three BTC snapshots in that small sample were older than one second. Delays and unavailable depth remain visible; this does not certify exchange-equivalent latency.

Account exits compete for the same observed snapshot liquidity. Shadow experiments remain independent, with their account-equivalent executable quantity frozen at entry; the large synthetic research purse is not submitted to the simulated book. Intent, fill, fee, remaining quantity, liquidity consumption and report share one database transaction, including rollback and restart recovery.

Trailing-stop amendments have a desired level and an acknowledgement deadline using the same bound latency. The old stop remains active until that deadline; a later desired amendment cannot inherit an earlier acknowledgement. This is a simulated acknowledgement, not an exchange confirmation. Historical candles cannot send a past client exit or retrospectively ratchet a new-model stop. Current live trades trigger exits; current candle closes are the fallback when tape is quiet. Resting targets require observed live trades; their existing trade-through model remains an approximation.

The UI shows pending/partial exits, retained exposure and requested versus active stops. Trade Replay lists depth fill reports and trigger-to-fill delays. Close and close-all responses distinguish requests from completed exits. The tape audit benchmarks version-211 depth fills against subsequent prints, separately from legacy stop-window comparisons.

## Baseline comparison

Read-only VM export cutoff: **2026-11-10 18:38:40.644 UTC**, trailing 24 hours. Raw-export SHA-256: `16fdf4ff0f3bd62760fe33cafa9c52c0d4b35e7285aac4d7802c9f854e655a62`. Reproduce with `node server/src/cli/validate-causal-exits.ts source.json result.json`.

| Book | Closed trades | Recorded R | Fresh quote exits | Quote-only change | Legacy first-print coverage | First-print change |
|---|---:|---:|---:|---:|---:|---:|
| Paper | 63 | -5.633R | 63/63 | -3.459R / -$51.87 | 59/63 | -3.873R / -$53.71 |
| Shadow | 742 | -11.647R | 739/742 | -30.047R | 633/742 | -30.633R |

Recorded paper net: -$213.43. These estimates hold entry, trigger time, quantity and effective fee rate fixed. Historical quotes do not retain executable size. The legacy first-print audit may look back three seconds before a stop. Neither series is a full strategy backtest, and neither may overwrite the journal or qualify a scanner.

The bounded depth ring retained 50,000 events over approximately 40.6 minutes, with only two account exits covered by validated depth after arrival:

| Position | Exit | Original price | Observed depth price after latency | Net change |
|---|---|---:|---:|---:|
| 14720 ETHUSD | SL, short buyback | 2039.05773 | 2038.65 | +$0.151 / +0.0142R |
| 14867 SOLUSD | Trail, long sell | 82.8359295 | 82.841 | +$0.046 / +0.0042R |

Both filled their actual quantities completely. This small fixed-trigger replay validates causal pricing coverage, not a profit claim. It excludes REST request delays and other traders' consumption. A full-day counterfactual of new tick triggers, stop amendments, fee-window crossings and portfolio reuse cannot be reconstructed from the retained data.

## Validation and rollout

Regression scenarios compare old and new engines on the same observations: old stop fills at its threshold versus new fill after latency; short ask/long bid selection; gaps; stale/future/missing data; partial/repeated books; competing account exits; independent shadow sizing; durable restart; transactional report-write failure; duplicate close requests; funding guards; stop amendment timing; old-policy preservation; missing state fail-closed; source selection, retry fairness and shutdown. End-to-end application/API tests demonstrate an actual pending-to-depth-fill transition and replay report, with synthetic offline fixtures and no exchange orders.

Server baseline had 1,109 passing tests. The final suite has 1,131 passing tests; 22 dashboard tests, dashboard lint and production build pass. Server TypeScript diagnostics match the existing 31 baseline diagnostics; this release adds none. No dependencies were upgraded. Tape/exit transactions checkpoint only the affected position; entry and reversal decisions retain a full-book checkpoint so high-frequency updates do not clone the entire shadow fleet.

Before restart, save a consistent SQLite backup and a private config copy. Verify exact deployed SHA, process health, unchanged config hash, paper mode, $150 margin and 3% stop-risk cap. Existing open trades and pending entries retain bound pre-211 policy semantics; historical closed trades are not restated. New execution evidence is separate, so old optimistic fills cannot become version-211 promotion/copy/sizing evidence. Restored cells keep the existing qualification standards and need prospective evidence for the changed execution model.

This is not live-order readiness. Native exchange protection, exchange acknowledgements, partial entry reconciliation and validated resting-order queue simulation remain later phases. No production trading endpoint is enabled or called by this implementation.

Official API schema: [Delta India L2 orderbook](https://docs.delta.exchange/#get-l2-orderbook), checked 10 November 2026 UTC. It documents public access, integer derivative contract quantities and the book update timestamp; these are distinct from a fill confirmation.
