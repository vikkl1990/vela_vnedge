# Prospective scanner-specific earlier exits

The 48-hour paper review identified three candidates for further study: SuperTrend Cluster,
AI Predictive Flow, and Trend Impulse Channels continuation-maker on SOL 15m. Replacing matched
exits with the already-recorded −0.5 price-R advisory control improved those retrospectively
selected groups by $50.64 across nine triggered trades, including one winner turned negative.
Across all scanners, the same control was $17.05 worse and cut 17 recovering winners.
The selected groups still lost money. These observations authorize a prospective comparison,
not a paper exit change.

## Frozen experiment

- Enroll future filled entries from the exact three scanner IDs. SuperTrend Cluster and AI
  Predictive Flow include every market/timeframe they actually trade; continuation-maker is
  restricted to SOLUSD 15m. Existing open positions and old trades are not enrolled.
- Compare against the unchanged actual trade, from the identical entry price, size and costs.
  Paper references and regular shadow references are separate. Tracker, research-plan and
  basket trades are excluded. No added scanner run or admission is needed, including for the
  SOL maker, which currently has no regular shadow fills.
- Candidate: first observed price at or below −0.5 of the original stop distance, while above
  −1, with no actual stop/liquidation/exit taking priority. This is price R, not net cash R.
- Base fill: the configured latency, then fresh executable depth. Stress: an additional three
  seconds and five basis points adverse price. The 30-second settlement window must have
  complete executable quantity; missing or censored fills are unavailable, never inferred.
- Preserve paid fees, offer timing and funding through the hypothetical exit. Partial depth
  fills and consumed liquidity survive restart. Entry/add-on exposure changes invalidate the
  comparison instead of pairing different quantities. Existing generic advisory rules remain.

## Evidence and reporting

`advisory_scanner_exit_studies` durably fixes the start time. Cohorts retain the exact entry
identity, book, scanner, source and frozen policy. An adopted/modified/unknown policy, late first
observation, a price observation gap over 15 seconds, or a changed entry exposure is unavailable.
Closed trades missed entirely by the monitor are included in the unavailable denominator.
Untriggered trades require observation through the actual close to count as unchanged.

The Trade health → What-if exits view reports covered/closed/enrolled, unavailable cases,
net before/after, stress net change, full SLs, all losing trades, winners cut, winners turned
nonpositive and profit cut from winners. Shadow results use R; artificial shadow dollars are
not presented as cash profit. Books and frozen policies are never pooled into promotion evidence.
Metrics use covered pairs; incomplete cohorts cannot substantiate deployment by omission.

Before changing paper exits, assess the future cohort without choosing favorable pairs after
the outcome. Require improved net profit and fewer full SLs, including stress execution and
all winner damage; inspect unresolved/missing cases and later-period stability. Existing
qualification and risk requirements still apply. An avoided SL label alone is not a win.
There is no automatic paper activation and every new research row has promotion_eligible=0.

## Isolation and validation

The study has no execution engine, order API, configuration setter or admission dependency.
It writes advisory tables only. The runtime reuses existing quotes and bounded, lower-priority
advisory depth collection; the trigger and both trial records commit atomically. No scanner
allocation, policy identity, risk limit, sizing, capital, fees, entry or actual exit changes.

Regression tests cover paper/shadow separation, exact scanner selection, fresh causal long/short
fills, delayed stress, missing-data denominators, unchanged winners, winner damage, partial depth,
restart, rollback, policy/exposure changes, actual-trade identity and late funding. Rendered
desktop/phone checks cover the waiting state, net/SL/loss/winner distinction and overflow.

Deploy the validated observation/UI code only. A new paper exit policy remains unproven until
future observations establish its benefit; the nine selected historical triggers do not count
as prospective validation. Configuration must remain byte-identical across this deployment.
