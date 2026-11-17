# Prospective exit studies — 17 November 2026

## Frozen hypotheses

| Source / market | Control | Candidate |
| --- | --- | --- |
| Trend Impulse / INIT 15m | Current exit policy | After 30 minutes, exit on a fresh trade at ≤−0.5R only if the observed peak stayed below +0.2R |
| Trend Impulse / PARTI 1h | Current exit policy | Same condition after 120 minutes |
| SuperTrend Cluster / EVAA 15m | Current protection | +0.1R gross price floor after +0.3R; retain the +0.5R trail and its tightening |

All six arms are independent shadow plans with separate frozen identities, identical entry/sizing settings within
each pair, full fees and unchanged risk caps. They cannot count for promotion. Existing paper positions retain
their policy. A failed-trade exit reduces a loss; fewer `sl` labels must not be reported as fewer losing trades.

## Evidence and limits

The earlier minute-path diagnostic for Trend Impulse found the two-bar rule promising on 22 policy-bound INIT
paper trades and six PARTI paper trades: net changes of approximately +$31.64 and +$13.82 with a 5-bps adverse-fill
stress. It reduced full stops by four and one respectively; winners cut short were zero in that diagnostic.
The retained tick/depth archive covered only five recent INIT trades, one paper and four shadow, and no closed
PARTI trade. Prospective observation is required before changing paper.

EVAA evaluation uses all 68 closed source-scanner trades exported at the study snapshot. Only 13 paper trades have
an immutable original fee policy; the other 55 are excluded. No missing policy is reconstructed from current
configuration. Executing at the next minute observation after the hypothetical trigger and latency, with another
5 bps of adverse pricing, the +0.3R activation / +0.1R floor changes total net from −$6.32 to +$29.11. It fires on
three trades, reduces original-stop exits from five to three, and cuts one winner short. All three hypothetical
closes are still net losses at those sampled prices: this does not prove that the floor banks profit. Starting the
entire trail at +0.3R cuts four winners and has a smaller net lift.

The retained tick/depth archive covers three recent EVAA closed trades. The early floor produces no change in
these three; the full early trail cuts all three winners. One replay has continuous validated depth; two have depth
sequence gaps. Baseline replay differs from the actual journal by $0, about $0.06 and about $0.44 respectively.
Incomplete replays are diagnostic, not profitability proof. No paper exit change qualifies. The screenshot's EVAA
short ultimately closed with the existing trail for +$19.42 net, after reaching +0.672R.

## Execution, capture and evaluation

- Trigger only on accepted fresh observations. Preserve original stop/liquidation priority and exposure until
  executable depth fills after configured latency, with actual fees, funding and partial settlement.
- Stop amendments also have an acknowledgement delay. A displayed floor is not a guaranteed execution price.
- Retain frozen entry context, tick/depth and actual exit reads for INIT, PARTI and EVAA in the bounded focused
  archive. ARIA capture continues. No extra exit REST request is introduced.
- Separate all-plan results from paired closed results. Exit-only pairs require identical entry time, price, size,
  original stop and risk. Display mismatched entries, pending pairs and different admissions.
- Report net dollars/R, full stops, all losing trades and profitable control trades cut short. Review later outcomes
  with adverse-fill stress and capture coverage under existing evidence rules. Do not recycle this exploratory
  sample as a fresh out-of-sample pass or relax promotion thresholds.

Raw journals and replay exports remain outside the public repository. Decision 297 records rollout scope.
