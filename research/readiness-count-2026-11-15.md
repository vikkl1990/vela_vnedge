# Paper readiness reconciliation — 15 November 2026 UTC

Verified against the VM journal and read-only API responses at 18:27:46 UTC.
The screenshot's 28 is the number of compatible closed paper trades in the last
30 days, not the full closed journal. No historical trade was changed or added.

| Classification | Closed paper trades |
| --- | ---: |
| All history | 1,095 |
| Outside the rolling 30-day window | 51 |
| Inside the window | 1,044 |
| Exact current policy | 4 |
| Compatible after global position-cap expansion | 15 |
| Original size, price and stop risk verified by replay | 9 |
| **Counted for readiness** | **28** |
| No bound execution policy | 743 |
| Different execution model | 163 |
| Original policy unknown at adoption | 2 |
| Missing complete entry evidence for sizing proof | 57 |
| Sizing equivalence check fails | 51 |

The 28 plus the 1,016 excluded trades equals the 1,044 in-window closes. All
five other readiness checks passed at this snapshot, but 28 trades remain too few
for the existing 200-trade rule; 172 additional compatible closes are needed if
none of the current evidence rolls out of the window. Shadow/backtest results
remain separate and cannot be substituted for paper execution evidence.

## Tested recovery of historical evidence

The 743 unbound trades have either an older available execution fingerprint (326)
or no matching fingerprint (417). Filling in today's policy would falsely claim
they used today's fill model. Another 163 bound trades explicitly use execution
model 210 instead of current model 211. Those histories are not equivalent.

A private consistent VM snapshot held 107 sizing exclusions (56 missing-proof
and 51 different-size), versus 108 in the later API response. It also held 27
matching trades rather than the later 28. Every diagnosed sizing exclusion was
below the original $1,000 capital. The 56 missing-proof entries comprised 38
maker entries, 14 incomplete order/depth-evidence chains and four failing depth
source/freshness/timing checks. The newly closed missing-proof trade in the later
response was not part of this snapshot replay.

For the 51 sizing failures, 46 failed quantity/risk/leverage equivalence and five
first failed the exchange-versus-portfolio leverage guard. A diagnostic-only run
omitting that guard recovered **zero**: all five still failed quantity/risk/
leverage equivalence. Production code and qualification rules were not relaxed.
This does not prove an exit strategy is unprofitable; it proves those historical
sizes cannot certify the current allocation policy unchanged.

## Practical acceleration

1. Preserve the 24 already recovered compatible historical trades, including
   losing outcomes. Avoid unnecessary identity resets for UI and count-quota edits.
2. Correct non-trading shadow slots and use normal admission to replace them:
   PR #54 freed six quarantined, unheld slots; six ranked candidates were admitted.
3. Remove optional weekly/fleet/per-scanner/per-market promotion-count quotas
   (PR #55), while retaining evidence thresholds, liquidity checks, runtime
   capacity, margin availability and risk caps. Existing pilot daily/open quotas
   are already disabled. This removes future allocation ceilings; it does not
   manufacture more qualifying cells or bypass admission.
4. Keep source/reader/execution/sizing policies stable while collecting forward
   trades. At the audited snapshot 35 direct account allocations and 34 copy-eligible
   cells were available. These counts describe different routes and may overlap;
   they must not be added as a unique-cell count or a guaranteed daily fill rate.
5. Diagnose scanner signals, entry refusals and actual fills per cycle. Do not
   force trades solely to reach 200. Positive net expectancy remains required.

## UI correction

Rename the vague closed-account-trades check to identify policy-compatible paper
closes and the 30-day window. Put the existing journal/exclusion breakdown on Live
control, using the same shared renderer as Incubator. Include exact, capacity and
same-size evidence. Missing API coverage is unavailable, never zero or a pass.
The detail and checklist are independently cached; show that explicitly.

No trading, risk, evidence-selection or sizing changes are part of this UI fix.
