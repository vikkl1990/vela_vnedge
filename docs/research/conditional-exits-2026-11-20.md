# Conditional exits: built, not qualified for deployment

Verified 20 November 2026. Execution remains paper; no VM code, settings, risk caps,
fees, allocation or evidence thresholds changed in this review.

## Frozen research hypotheses

Three independent arms compare invalidation, conditional profit protection, and their
combination against the same filled reference entry. SuperTrend Cluster and AI Predictive
Flow include their existing markets/timeframes; continuation-maker is restricted to SOL 15m.
These are proposed bot overlays, not newly discovered author-native exits or reader corrections.
Current entries and readers remain intact, including the deliberate continuation reading.

| Scanner | Setup invalidation hypothesis | Profit protection hypothesis |
| --- | --- | --- |
| SuperTrend Cluster | Signal-wick failure after 60s grace, persistent for 60s, at least 0.2 price R adverse | Observed executable peak ≥0.20 net R, confirmed range failure for 20s |
| AI Predictive Flow | One source-bar grace, then 120s of signal-wick failure, at least 0.2 price R adverse, without previous +0.10 price R follow-through | Observed executable peak ≥0.25 net R, confirmed range failure for 30s |
| SOL continuation-maker | Signal-wick failure after 30s grace, persistent for 30s, at least 0.2 price R adverse | Observed executable peak ≥0.20 net R, confirmed range failure for 15s |

The signal wick is frozen from the actual entry decision, bound to its policy. A wick outside
the original stop-to-entry interval does not activate invalidation. No fabricated fallback stop.
Reclaims clear failure confirmation. No stop widening, position resizing or new entry.

Protection requires giveback of at least max(0.08R, 35% of the observed executable net peak),
and a persistent break of a prior observed price range (samples 30–90s old, at least six
points spanning 25s). This is sampled price structure, not an author's indicator or a complete
candle. It requires positive close-now net above 0.02R plus the estimated 5bps stress cost.
This cushion is not a guarantee against later slippage. A reclaim or missing fresh net quote
clears confirmation. A fixed profit floor or a gross journal peak alone cannot trigger it.

## Execution and evidence isolation

Future entries only; separate paper and regular-shadow reference cohorts, books, cells and
frozen policies. No tracker, basket or execution-plan inclusion. All new tables enforce
promotion_eligible=0. The research has no engine, order API, risk/configuration setter, or
promotion dependency. It cannot close or change the reference trade.

Fresh quotes track invalidation independently of depth. Full-size depth less than one second
old prices net close-now and every hypothetical fill. Missing depth never confirms protection.
The draft initially required continuous depth for price coverage too; replay exposed this
unnecessary coupling and regression tests now cover the separation. Price observation gaps
over 15s remain unavailable; no interpolation across downtime or stale quote bursts.

Base execution uses the frozen entry policy's delay, fees, taxes and offer timing. Stress adds
three seconds and five bps adverse execution. Pending real stops have priority. Hypothetical
partial fills and consumed liquidity persist atomically; no inferred fill after the 30s deadline.
Funding is reconciled through the hypothetical close using existing accounting. Entry-policy
or quantity changes, adopted policies, late enrollment and unseen closures remain unavailable.

Unchanged trades count only with coverage through actual closure. Results include net profit,
SL labels, all losing trades, winners cut, winners turned nonpositive and stress winner damage.
A smaller count of exits labelled SL is not itself profit improvement. Shadow dollars are not
displayed as account cash. There is no automatic paper adoption.

## Retrospective result

Read-only VM export: all 10 closed eligible reference entries opened in the preceding 48h;
all were paper references. Four EVAA and three AAVE Cluster trades, one BNB Cluster trade,
one BLESS Predictive Flow trade, and one SOL maker trade. No regular-shadow reference closed
in this interval. No selection of only stopped or losing trades.

The capture verified 1,022 immutable segments and 622,327 events, with no missing segment
files or backward observation timestamps. Archive checksums do not establish usable coverage.
The offline evaluator uses recorded bid/ask arrival times on a 5s sampling clock, entry-time
policies and quantities, and actual exit/funding records in an in-memory database. It never
replays entries into the running account. The 5s clock is an explicitly stated approximation
of the historical observer's phase, not an exact recovery of its scheduler.

| Arm | Covered / enrolled | Current net on covered trades | Candidate | Stress | SLs before → after | Winners cut |
| --- | --- | --- | --- | --- | --- | --- |
| Invalidation | 0 / 10 | Unavailable | Unavailable | Unavailable | Unavailable | Unavailable |
| Protection | 1 / 10 | +$4.8740 | +$1.9323 | +$1.4893 | 0 → 0 | 1 |
| Combined | 1 / 10 | +$4.8740 | +$1.9323 | +$1.4893 | 0 → 0 | 1 |

The priced comparison is AAVE SuperTrend Cluster #21810. The two rows are alternative arms
on the same trade, not two independent successes/failures. Protection lost $2.94 relative
to the current exit ($3.38 under stress). Nine other trades have insufficient continuous
coverage; their original results cannot be silently carried into a claimed improvement.
Examples include bursts of quotes arriving 17–19 seconds old after a pause. This is observed
arrival delay, not proof of its infrastructure cause. Recorded extrema cannot repair it.

**Deployment decision: no production or paper-exit deployment.** This candidate has neither
demonstrated profit improvement nor fewer SLs without winner damage. Keep the parameter set
frozen rather than tuning to the single AAVE winner. A research-only prospective deployment
is distinct from adopting an exit; it has not been performed in this change.

## Validation and next evidence

Regression coverage includes long/short symmetry, recovered winners, persistent failures,
scanner timing, fees/tax, fresh net pricing, depth/price separation, true observation gaps,
actual-stop priority, changed exposure, partial fills, restart, transaction rollback, unavailable
closures and winner damage. Desktop/phone UI tests cover separated arms, missing-data states
and no trading controls. Trade health → What-if exits contains the comparison view when
this branch is running; it is not on the VM yet.

Next: diagnose the measured feed/processing pauses, then run this unchanged protocol on a
new prospective period. Do not infer profitability from a candle replay or relax freshness
to fill the missing periods. Paper adoption still requires later independent evidence of
better net profit and fewer SLs, including execution stress and winners cut short, under the
existing evidence and risk rules.
