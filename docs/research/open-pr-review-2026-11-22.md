# Open PR review — 22 November 2026

Reviewed all 13 open PR heads against main `bec7bc1`. No unrelated PR was merged or deployed in the readiness-history task. Merge conflicts alone do not imply broken code: 11 PRs conflict only in the appended decision log; #81 also conflicts in execution code, and #67 merges cleanly.

## Findings to fix before merging

1. **#100: historical source/size labels use current allocations.** `paperFleet.sourceOf` and journal filters relabel an old copy as an own-list trade after promotion, and an old own-list trade as a copy after removal. `SourceTag` also displays today's copy-size scale on past trades. Use persisted entry provenance and size, with unknown for missing history; show current membership separately. This is a P2 reporting defect, not a change in actual fills.
2. **#89: paper-only operator boundaries and rollback are incomplete.** `releaseFleet` lacks the paper-mode guard present in enable. Disabled/hidden scanners lose their original pair lists, and the release marker stores only enabled/hidden flags, so release cannot restore them. Quarantine-query failure returns an empty set. Fix mode guards on both directions, fail closed on unavailable quarantine state, retain exact prior allocations, and replace the full validated config atomically. Do not run these scripts as submitted.
3. **#64: late prices overwrite fresh mover readings.** `MoverStore.record` coalesces every negative time gap before checking out-of-order arrival. An observed 110 price / +10% five-minute move becomes 80 / −20% when a delayed 80 sample arrives. Reproduced against the PR's exact module. Reject backwards clocks before coalescing; test concurrent refresh completion order.
4. **#65: small-cluster confidence bands are too narrow.** The daily-cluster standard error omits the finite-cluster correction G/(G−1). With five days, six equal-R trades per day, and daily returns −0.1, 0.4, 0.9, 1.4, 1.9R, its 95% badge says edge (lower +0.022R); the corrected daily-cluster interval includes zero (−0.081R). Reproduced with the PR's stats and badge functions. Correct the estimator and test the small-day boundary. This badge is advisory but must not overstate certainty.
5. **#88: entry context can come from after entry.** `market(entryAt)` accepts the latest context without checking its timestamp and clamps negative age to zero. The restart path explicitly records already-open positions five minutes after startup, so an hours-old entry can receive today's context as contemporaneous. Require `ctxAt <= entryAt`; otherwise record missing context or select an earlier persisted snapshot. Candle-based features already request closed bars as of entry.

## Disposition of every PR

| PR | Disposition |
| --- | --- |
| [35](https://github.com/vikkl1990/vela_vnedge/pull/35) | Keep draft. Removing cooldown/burst/regime guards is a trading-policy change; descriptive returns do not prove the counterfactual. Needs current rejected-entry replay and explicit policy scope. |
| [64](https://github.com/vikkl1990/vela_vnedge/pull/64) | Fix stale-price overwrite, rebase decision log, rerun checks. |
| [65](https://github.com/vikkl1990/vela_vnedge/pull/65) | Correct confidence bands and regression, rebase decision log. |
| [66](https://github.com/vikkl1990/vela_vnedge/pull/66) | No blocking defect found in static review. Rebase and validate mobile navigation/filter persistence. Client filtering applies to the fetched recent-signal slice, not all history; keep that scope explicit. |
| [67](https://github.com/vikkl1990/vela_vnedge/pull/67) | Clean merge, no blocking defect found. Fresh CI and keyboard/typing-focus browser checks still needed before merge. |
| [76](https://github.com/vikkl1990/vela_vnedge/pull/76) | Keep advisory draft. Its covered example cuts a winner from 4.874R to 1.932R and nine examples lack coverage. No proven paper improvement. |
| [81](https://github.com/vikkl1990/vela_vnedge/pull/81) | Rebase/reconcile with execution changes already on main. Eight code/test conflicts plus decision log; six matched fills do not demonstrate improved profit or fewer SLs. Keep draft. |
| [88](https://github.com/vikkl1990/vela_vnedge/pull/88) | Add as-of context guard and delayed-callback regression; rebase. |
| [89](https://github.com/vikkl1990/vela_vnedge/pull/89) | Fix operator guards, exact rollback and atomicity before use. Its comparison SQL also needs the shared evidence-scope exclusions. |
| [97](https://github.com/vikkl1990/vela_vnedge/pull/97) | Package 0.10.14 exists in the publisher's npm registry. Rebase and inspect upstream diff plus chart smoke tests; an import/build check alone is insufficient. No upgrade bundled into this deployment. |
| [98](https://github.com/vikkl1990/vela_vnedge/pull/98) | Improve provenance: read the shipped license files, not npm metadata alone. Localhost binding does not establish who receives a dashboard behind a proxy. Remove that unverified deployment assertion; no legal-compliance conclusion made here. |
| [100](https://github.com/vikkl1990/vela_vnedge/pull/100) | Fix historical classification and size labels before merge. |
| [101](https://github.com/vikkl1990/vela_vnedge/pull/101) | No blocking defect found. Decision-log conflict only; rebase and rerun guide/config and mobile checks. |

The [official Vela release page](https://github.com/LuxAlgo/Vela/releases) inspected during review listed 0.10.13; npm independently verified 0.10.14 at git head `3d2179bd01da000c4ffbf8c94d55d2011701254f`. This discrepancy means release notes need verification, not that the npm version is absent. The [PineTS license source](https://github.com/LuxAlgo/PineTS/blob/main/LICENSE) is available for the notice review. No messages or reviews were posted to other contributors.
