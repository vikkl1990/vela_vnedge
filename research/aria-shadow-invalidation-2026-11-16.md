# ARIA prospective invalidation and focused replay — 16 November 2026

The preceding replay found a promising but unproven ARIA Elliott Wave result on four paper opportunities. INIT was mixed/negative and PARTI lacked usable coverage. This change collects forward observations; it activates no new paper exit and changes no scanner, allocation, fee policy, risk setting or evidence threshold.

## Paired ARIA shadow study

Use the existing ordinary shadow entry as the unchanged control. Enroll only new, source-bound Elliott Wave ARIAUSD 15m shadow positions opened after the study's first activation. Experimental plans, paper trades, adopted history and pre-start trades cannot enroll. Freeze the source and policy identity, and obtain the closed signal candle from that position's original decision receipt, never from a later chart.

The candidate samples a fresh quote midpoint once per minute. The adverse signal-candle extreme must lie between entry and the original stop. Two failed observations at least 30 seconds apart confirm invalidation; a sampled recovery resets confirmation. Missing/invalid entry context, late observation startup or a gap exceeding two minutes makes the trial unavailable. This is a sampled-price rule, not a tick-perfect backtest. Protective stops and actual pending exits retain priority.

Both hypothetical exits use the original position's frozen executable quantity, costs and entry fees. Base pricing waits configured latency plus one second for fresh executable depth. Stress waits configured latency plus three seconds and adds five basis points adverse price. Both require complete observed execution within 30 seconds of the trigger and before an actual exit. Partial fills consume observed liquidity; funding follows settlement time and remaining hypothetical exposure. Unpriced/interrupted trials receive no assumed result.

All trial records are advisory, with `promotion_eligible=0`. No hypothetical fill writes to positions, orders, execution queues, configuration, trade policies or promotion evidence. The ordinary shadow trade keeps running to its actual exit. This provides the complete unchanged outcome without opening an extra research position or increasing capacity.

The denominator includes new enrolled trades that never trigger the rule. Results are grouped by frozen policy and show coverage, net R lift, stressed lift, full stop-losses, all losing trades and winners cut short. Replacing a full SL with a smaller losing exit does not turn it into a win. Results are available in Trade health → What-if exits.

## Replay collection

ARIA, INIT and PARTI remain subscribed to public prices, trades, funding and advisory depth even between positions. Record five-second market observations, five-second active-position samples, and the immutable signal-candle/policy context. Existing positions are labelled with observation delay; their earlier paths are never invented.

The existing broad archive remains bounded by 14 days / 16 GiB. A separate checksummed archive under `data/replay/entry-invalidation-v1` preserves only these three pairs and explicit gap events, targeting 21 days within 4 GiB. It pauses at a 4 GiB free-disk reserve, records failures/drops and never blocks execution. Both archives retain their own immutable manifests, fsynced journals, crash recovery and reader integrity checks. The age targets are not promises of complete coverage.

## Evaluation before a paper change

Do not count matched paper/shadow versions of the same opportunity as independent observations. Evaluate new complete opportunities under the same policy on later dates; report missing coverage and unchanged trades. Require improved net profit and fewer full SLs in both normal and stressed fills, inspect total losers and sacrificed winners, and retain the existing qualification requirements. A reduction in SL labels alone, a net-positive delta on a still-unprofitable strategy, or four repeated historical examples is not sufficient. No automatic paper admission or exit-policy promotion is added by this study.

## Checks

Regression coverage exercises paper/experiment exclusion, source-candle binding and causality, observation cadence, recovery reset, restart continuity and gaps, fresh delayed depth, stress pricing, timeout, both directions, unchanged real orders/configuration and honest cohort denominators. Replay tests cover selection, explicit disconnects, retention bounds and an independently failing disk reserve. Browser tests cover the empty prospective cohort, unavailable capture, and the difference between full stops and losing trades on desktop and phone.
