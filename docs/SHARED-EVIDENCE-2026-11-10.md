# Shared evidence and gated observations

Copy eligibility previously read raw shadow history. Promotion and leverage read current-policy outcomes, with duplicated SQL. Tracker observations could also enter qualification. `server/src/evidence/trades.ts` now supplies the shared qualification query for all three consumers.

## Qualification contract

- Executed, closed account or shadow positions only; positive finite risk and finite net R; exit at or before the evaluation time.
- Exact strategy identity, including scanner source, cell, reading, economic policy and regime. Unknown, adopted and changed-policy history cannot qualify today's strategy.
- Frozen account/shadow membership; tracker, experimental, archived and backtest records are excluded. Quarantine identity includes both position ID and entry time.
- ATR-only policies require an ATR-fallback trade. A native-stop policy keeps its own rules.
- Sizing takes the most recent compatible closes, with deterministic ID ordering for equal close times. An accepted pending order uses its bound policy when sized again.
- The callers retain their existing trade-count, return and duration thresholds. Missing policy/source fails closed. Explicit offline historical research remains available separately.

Raw journals are preserved. No historical policy snapshots or outcomes are invented. Existing account allocations and held-position exits continue; copying qualifications apply to prospective shadow copies.

## Diagnostic ledger

`gated_signals` stores entry observations rejected or ignored by copy qualification, shadow/account admission, execution, receipt recovery, or cancellation before filling. It retains the event, reference price, available signal bar/ATR/quote/features, reason, stage, cost rates and policy/source identity. Pending observations survive restart. Legacy pending orders without an original event cannot be reconstructed.

This table contains no positions or simulated profit. Its `promotion_eligible` field is constrained to zero, and the qualification query never reads it. It does not feed ML training or change balances. Counterfactual fills and outcomes require a separate replay; a rejected signal is not presumed to be a missed winning trade.

Observation identity is book + cell + bar + direction + label + source + stage. Reprocessing preserves the first record. The same source signal may have separate copy and shadow admission observations; row count is not unique trade count. Existing closed-trade, order and cancellation journals remain authoritative for execution.

Authenticated read-only endpoint:

`GET /api/evidence/gated-signals?book=shadow&since=<epoch-ms>&limit=100`

Optional filters: `book=paper|shadow`, `scannerId`, `symbol`, `tf`, `stage`; `before` provides ID pagination. Default window: seven days; maximum page: 500 observations. This change adds the data endpoint, not a new dashboard page.

## Validation and rollout

Regression tests cover shared qualification, current/source-policy changes, tracker exclusion, invalid/future outcomes, fee-net R, ordering, quarantine identity, bound pending sizing, copy dispatch, gated persistence/deduplication, transaction rollback, unfilled-order restart and authenticated API access. Full server/dashboard tests and dashboard lint/build are deployment checks. Server TypeScript diagnostics are compared with the unchanged baseline; existing diagnostics are not described as a clean typecheck.

A read-only VM comparison on 10 November found 218 non-live cells passing the old copy evidence check and 3 passing compatible evidence, before liquidity checks. The 215 excluded cells held 2,453 legacy closes and 492 changed-policy closes among their records; no outcome was deleted. There were 41 already-live cells, which retain their allocations. This corrects evidence validity; it is not a demonstrated profit improvement.

Deployment uses additive schema changes. Paper mode, $150 margin, leverage tiers, risk caps, fee configuration and qualification thresholds remain unchanged. Code rollback can leave the new table/index in place without changing historical trading data.
