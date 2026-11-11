# Signal-count and collection review — 11 November 2026

Read-only VM evidence checked through 13:18 UTC. Baseline code: `1876e5b`.

## Measured reduction

Like-for-like 00:00–12:00 UTC windows, filled positions including those still open:

| Measure | 10 November | 11 November |
| --- | ---: | ---: |
| Entry signals reaching account admission | 108 | 36 |
| Paper entries filled | 29 | 10 |
| Regular shadow entries filled | 181 | 174 |
| Tracker entries filled, separately | 65 | 52 |

The abrupt account signal drop starts around 17:00 UTC on 10 November, after the shared-evidence change, before the advisory monitor deployed on 11 November. Copy-held candidates are saved in `gated_signals` and never reach `signals`; the overview only counted the latter. This confused fewer account-admitted candidates with fewer detected signals.

The new execution cohort also matters: simulation 211 prices exits from causal depth after latency. Earlier simulation-210 results cannot be silently reused as current evidence. At 13:14 UTC, the current-source/current-policy diagnostic identified one shadow cell meeting the copy sample/profit threshold: Woodie Pivots / BTWUSD / 15m, eight matching closes, +0.981R. It had already reached paper. This check is before current turnover and admission checks and is separate from approved account allocations. Four other cells had enough matching closes but non-positive evidence. These findings do not authorize automatic promotion or relaxed qualification.

All 32 restored cells still staged in shadow had successful current scans. Their latest completion delay was median 94.85 seconds; the slowest was 171.7 seconds after bar close. This is within the five-minute expiry but adds avoidable delay to prospective collection. Account run history showed 2,214 successful runs and no failures in the sampled rolling day; the sampled shadow dispatcher had no expired jobs.

## Corrections

- Give current-policy, already-enrolled forward cells access to the existing bounded research-priority turn, alongside explicitly watched tracker cells. Do not put unqualified cells in the urgent account/mirror tier.
- Keep two of four starts for ordinary evidence priority and one unconditional exploration turn. Pool capacity, reserved account workers, memory pressure and deadlines are unchanged.
- Read existing enrollment records only. Changed-source/policy, future, tracked, live and retired enrollments cannot create forward scheduling eligibility. This cannot qualify a trade, alter a stage or create an enrollment.
- Show observed candidates, copy holds, account admission and filled paper/regular-shadow entries in the Signals UI. Deduplicate a candidate across source reloads and an account receipt. Exclude shadow-book gate duplicates, tracker trades, experiments and unfilled orders. Preserve the existing account entry count API field.
- Clearly mark the overview count as signals reaching account admission. Report incomplete copy-hold history as a lower bound.

## Validation

- Server suite: 1,184 passed. Dashboard suite: 25 passed. Dashboard build and lint passed.
- Regression tests cover enrollment/policy matching, no promotion bypass, preserved urgent/worker behavior, correct full-window counts, duplicate receipts and book separation.
- Synthetic scheduling comparison: 1,800 jobs, six workers, one second/job, identical 305-second deadlines. All 1,800 finished in 300 seconds under both policies, no expiries, maximum six workers. Forward-cell median completion changed from 298 to 11 seconds; p90 300 to 19 seconds. Watched-cell p90 changed from 7 to 29 seconds because the same research allowance is shared. These are stress-test results, not measured VM latency or a profit backtest.
- VM configuration SHA-256 before rollout: `c7477e83c384b20cce34db7ed32aaffe9f0381f1fee02942662e405e42def71c`.

Paper mode, $150 margin, risk/capital settings, eligibility rules, stop/target rules and open positions are unchanged. Faster collection does not guarantee more qualified trades or higher profit. Verify actual next-bar collection after rollout; keep old execution cohorts excluded from qualification.
