# SOL maker tick/depth fills and half-stop review — 21 November 2026

**Decision: hold deployment and paper adoption.** The corrected fill model is implemented as a disabled, SOL-only shadow candidate. No VM configuration, paper execution, risk cap, margin, evidence rule or historical trade was changed. Existing prospective SOL reference collection remains active.

## What was wrong

The current SOL maker uses `limit-candle-model`. Its existing optional tape model also treats one small crossing print as sufficient for a whole order. A crossing proves that price traded; it does not prove our place in the queue or that our whole quantity could fill.

For shadow trade **24176**, the original model filled all **11 contracts** at 03:46:00.297 UTC. Retained prints support a quantity-bounded model of **1 contract** at 03:46:00.142 and the remaining **10** at 03:46:00.548. These are receipt times. The two reports retain separate exchange timestamps and depth observations. The modeled net result remains **+$3.94249**, with **$0.60381** total fees; the half-stop never triggers. Public prints and L2 remain a model, not exchange execution reports.

## Implemented candidate

`makerFill: tick-depth-v1` is restricted to the SOLUSD 15m Trend Impulse maker research plan, paper mode and causal exits. The disabled `sol-maker-tick-depth-reference` has its own complete evidence identity; ordinary/account readers and the old reference keep theirs.

- Require a fresh verified WebSocket book after configured arrival latency; cancel a crossing post-only arrival. No candle entry fallback.
- Fill only the quantity supported by a fresh crossing print; deduplicate its volume budget. Persist every partial report, exact fill/arrival depth and remaining quantity atomically.
- Charge fees on each actual modeled slice. Preserve the first-fill fee clock through restart; reserve only the unfilled remainder, and count a partial order as one position.
- Recheck existing admission, cost and risk controls. An exit cancels only the remainder and protects exactly the held size. Never infer fills during downtime.
- A corrupt research remainder cancels that remainder without stopping the account engine or losing held exposure.
- Archive SOL's actual execution-depth stream separately from advisory depth, within the existing bounded replay archive. Journal detail exposes all partial reports.
- Keep the half-stop hypothetical and exclude changed quantities, gaps and mismatched policies from comparison. It cannot promote a scanner or alter an account exit.

No plan is enabled, no plan capacity is raised, and no threshold is relaxed by this change.

## Diagnostic replay

Input: **12 closed SOL records** in the seven-day export — 11 paper, one isolated shadow reference. Replayed **472,017 retained events** from three checksum-verified capture collections, deduplicated by complete event and merged by receipt time. No historical fill is written back.

Historical execution depth was not archived at entry. This run explicitly uses recorded **advisory-depth as a proxy**. It freezes each originally accepted order's price, levels, quantity and costs; it is not a portfolio backtest. Rejected/expired orders lack equivalent frozen sizing, so their opportunity cost is not reconstructed. Missing coverage is not a zero-return trade.

| Diagnostic group | Current result | Tick/depth candidate | Conclusion |
| --- | ---: | ---: | --- |
| Six filled records whose exit replay matches the journal | −$22.18715; 3 SL exits | −$22.18715; 3 SL exits | No profit or SL improvement; not qualifying evidence |
| Two additional reconstructed fills | Exit replay differs from journal by +$0.10 / +$0.30 | Same proxy-priced exit as baseline | Excluded from journal-parity comparison |
| Three oldest records | Historical closed results exist | No retained entry-window events | Unavailable |
| Paper winner 24161 | +$4.37455 | Post-only refusal on first reconstructed book | First fresh book is 13.464s after due time; cannot claim the real order would be rejected |

The six matching records are 20202, 20875, 20935, 21694, 23828 and 24176. Matching outcomes do not establish continuous coverage or queue priority. Some reconstructed arrivals start late. Eight records produce modeled fills; five of those use multiple partial reports. No supported inference says the new model increases profit or reduces full stops.

## Half-stop result

| Reference | Current net | Half-stop net | Stress net | Status |
| --- | ---: | ---: | ---: | --- |
| Paper 23509, existing prospective cohort | −$8.59256 | −$3.89256 | −$4.93898 | $4.70 / $3.65 smaller loss; still a losing trade |
| Paper 23828 | −$10.72326 | Unavailable | Unavailable | Recorded 22.7s observer interval exceeds unchanged 15s rule |
| Paper 24161, original entry | +$4.37455 | Unchanged | Unchanged | No half-stop trigger; corrected entry remains unavailable |
| Shadow 24176, corrected partial entry replay | +$3.94249 | Unchanged | Unchanged | 45 recorded observer opportunities; no trigger |

The saving on 23509 belongs to its **original entry cohort**, not the corrected entry model. Its corrected entry moves about 30.8s earlier and lacks the required prospective observer sequence. Do not transfer the old saving to the new entry model. The paper and shadow winners 24161/24176 come from the same signal and are not independent observations.

## Current collection and validation

Read-only VM check at **05:01:38 UTC / 10:31:38 IST**: paper mode, production disabled, zero exchange-order records. Paper and risk hashes match the beginning of the review. In the checked 04:30–05:01 window, the focused SOL archive retained 1,608 trade events, 5,957 depth updates and 377 fresh market samples, with no observer gap; maximum sample interval 8.842s. The 05:00 close scanned in 1.831s for paper and 74.610s for shadow, producing no new source entry. There is still only one closed SOL research reference, not an invented extra sample.

Validation: **1,757 server tests pass**, server typecheck passes, dashboard build and lint pass. New coverage includes both directions, partial quantities/fees, exact depth, latency, stale and duplicate prints, post-only crossings, missing depth, restart, expiry, rollback, adverse entry gaps, funding during partial fills, corrupt research recovery, journal reports, advisory-only exits, unchanged promotion exclusion and paper-priority scheduling.

Reproduce the diagnostic locally with the retained capture directory (private raw journal data is not committed):

```sh
node ops/replay-sol-maker-tick-depth.ts /absolute/path/to/capture /absolute/path/to/result.json
```

The directory contains `export.json`, `events.ndjson.gz` and `manifest.json` with their SHA-256 hashes. The tool refuses changed inputs and regressing arrival times. Its databases are in-memory; it has no network or configuration writer. Compact per-trade results and capture hashes accompany this report in `sol-maker-tick-depth-2026-11-21.json`.

Before adoption, obtain independent prospective candidate fills with exact execution depth from placement through expiry/closure, sufficient loser and winner coverage, and paired half-stop results after fees under normal and stressed latency/slippage. Count missed winners and partial-order cancellations as well as filled outcomes. Apply the unchanged evidence rules; positive isolated examples do not satisfy the deployment condition.
