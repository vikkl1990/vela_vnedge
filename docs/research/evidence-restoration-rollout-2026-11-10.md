# Conservative evidence restoration and forward evaluation

Date: 10 November 2026. Execution stays paper. No margin, leverage-tier configuration, risk-cap, stop, target, or fee configuration is changed.

The earlier strict-policy deployment excluded 1,322 shadow closes whose only strategy-term difference was the addition of verified Scalper Offer eligibility. A one-way comparison can retain otherwise identical, provably full-fee outcomes under the newly verified fee waiver. It never credits a discount to old trades. Source, simulator, timeframe, reading, entry, stop, target, cost, tax and regime changes remain incompatible. Missing, adopted, tracker, experiment and quarantined evidence remains excluded.

On the saved production snapshot, exact qualification found 3 cells; conservative full-fee history found 36. The 33 additional cells are enrolled in forward shadow evaluation, not immediately copied to paper. The short chronological replay did not establish a robust profit advantage: unrestricted restoration lost 2.60R against the exact baseline's +2.86R; retaining exact qualifiers and adding mature compatible cells gained only 0.14R, an advantage lost under 5bp cost stress. This is evidence infrastructure, not a claimed profit improvement.

## Enrollment and evidence

- Enrollment is keyed to the current strategy identity, stored in `evidence_restorations`, with an immutable start time, seed references, and test requirements. Restarts do not restart the clock or backdate it to favourable history.
- Existing exact-qualified and allocated cells retain their normal path. A shadow/proposed cell qualifying only through compatible full-fee history is held for forward testing.
- Only exact-policy, executed shadow trades entered at or after enrollment and closed strictly before the decision timestamp count toward the forward test. Old trades, pending/open positions and gated observations cannot satisfy it.
- The timeframe's existing promotion requirements are frozen at enrollment, with a minimum of 20 new closes. Current configuration therefore requires 30 closes/14 days on 15m, 20/28 on 1h, and 20/45 on 4h, plus PF >=1.2, mean >=0.1R, t-statistic >=2 and the existing consistency checks.
- Both chronological time halves must have positive net R. The full forward sample must remain positive after 0.05% extra round-trip friction, charged against actual entry/exit fill notionals. Missing or inconsistent fill accounting blocks the verdict instead of dropping an inconvenient outcome.
- The verdict is recomputed as evidence changes: subsequent losses or quarantine can revoke qualification. This is a continuing eligibility assessment, not a statistically independent guarantee of future returns.
- A source or economic policy change invalidates the old verdict and requires a fresh forward window. History remains available for audit.

Copying, promotion approval and evidence-based leverage all use the shared runtime qualification boundary. Before a pass, restored cells supply no qualifying outcomes. After a pass, conservative compatible history becomes available, still with original net results. Normal copying thresholds, promotion checks, liquidity, market depth, execution costs, available capital and risk limits continue to apply. Existing positions retain their bound exit policies. Exits and shadow scanning are not blocked by the restoration hold.

The Incubator exposes each enrollment, sample/age progress, current net R, stressed R and the reasons paper qualification remains held. Gated signals stay in their separate non-promotable ledger.

## Validation and rollout

The production-snapshot validation reproduced all 1,715 historical strategy hashes; enrolled exactly 33 restored cells with zero forward closes and zero passes; retained the 3 baseline eligible cells; preserved every historical fee/P&L/policy row; and retained enrollment clocks after a repeated startup. Unit and integration tests cover fee proof, asymmetric compatibility, stage exclusions, timeframe requirements, restart persistence, as-of boundaries, source changes, stale/cohort promotion approval, sizing, loss/quarantine revocation and unchanged configuration.

Validation completed: 1,102 server tests and 22 dashboard tests passed; dashboard lint/build passed; all 31 server typecheck diagnostics exactly match the baseline. The actual ShadowRunner integration test holds restored entries, records the copy refusal and resumes copying only after a passing forward record. Deploy the exact tested commit. The existing server typecheck has 31 unrelated diagnostics; no new diagnostics are accepted. Take a VM database/config backup and verify paper mode, $150 margin, unchanged paper/risk/execution configuration and service health after restart. Do not run any offer enrollment, trading endpoint or historical fee rewrite.

If operational errors appear, return code to the previous commit and restart; retain the enrollment table and journals for audit. No restoration verdict is manually forced to pass.
