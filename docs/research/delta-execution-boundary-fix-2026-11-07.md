# Delta execution boundary corrections — 7 November 2026

Status: corrective release for paper operation; live certification remains incomplete. Baseline: `66bf376`.

## Implemented

- Use `/v2/positions` with its required product filter for current quantities. The margined endpoint discovers instruments only. Include products from durable order history, paper positions and exchange open orders, so a newly filled order is not hidden by delayed margin inventory. Bound concurrent position requests to four. Invalid or incomplete reads fail explicitly.
- Record a stop edit as uncertain before sending it. Independently read the order and verify identity, side, reduce-only, trigger reference, trigger price, remaining quantity and state. Lost acknowledgements can resolve through readback; unresolved edits retain the prior confirmed local protection and do not create a second stop. Recover the observed order shape after restart.
- Read back even a rejected edit before replacement: the stop may have filled in the meantime. Treat Delta's `offset_by_reduce_only` response as ambiguous because it can describe an adjusted order.
- Reject unsupported FOK, invalid quantities/prices/enums and non-boolean outbound flags before submission. Parse incoming booleans explicitly. Do not fabricate order identifiers, cumulative quantities or an empty position list from malformed data. Preserve large string identifiers and reject unsafe numeric IDs.
- Include pending-order instruments in emergency cancellation and read positions again afterwards to size residual close requests. Confirm disappeared protective orders individually. Report close attempts as `submitted`, not `closed`. This does not complete the protected-flattening state machine.
- Show live certification as pending on Exchange, distinguish unavailable reconciliation from zero drift, and correct the production bracket explanation.
- Resolve the 16 pre-existing full-server TypeScript diagnostics through fixture/type annotations and an explicit shared-module package boundary.

## Validation

- **979/979 server tests**, including process-crash recovery.
- **7/7 dashboard tests**, dashboard lint and production build passed.
- Full server TypeScript check passed.
- **21/21 new regression cases fail on the baseline source and pass on the corrected source**, using identical fixtures. Coverage includes malformed responses, delayed inventories, large IDs, deprecated FOK, lost edit acknowledgements, wrong identity/trigger/reduce-only, adjusted orders, partial fills during rejected edits, restart after PUT, and fills racing cancellation.
- A run interrupted by a long host pause had two crash-test timeouts and one expired signal fixture. The complete suite subsequently passed with the host kept awake; no timeout limits or assertions were weakened.
- No exchange order was submitted during validation. Exchange behavior above was exercised with stateful fakes and injected responses; actual testnet certification is still required.

## Limits and next acceptance work

Production activation locks remain in place. The normal paper margin stays **$150**. No TP/SL strategy or fee setting was retuned by this release, and this work establishes no improvement in trading expectancy.

Remaining rollout work includes production protective-order lifecycle and a protection deadline, restart-safe emergency closure with independently confirmed residual exposure, an account-scoped read-only observer using saved credentials, actual fee/tax/funding/credit reconciliation, complete product constraints, shared request scheduling, and private account-event recovery. Account-wide freshness for an externally opened, previously unknown product is still limited by discovery; touched products are queried directly.

A successful credential check verifies authenticated reads only. It does not prove trading permission, complete accounting, profitable execution, or eligibility for a live pilot. Continue the acceptance process in [GO-LIVE-ROLLOUT.md](../GO-LIVE-ROLLOUT.md).

Reference: [Delta India API documentation](https://docs.delta.exchange/), including Get Position, Get Margined Positions, Edit Order and order-error semantics; the supplied API reference export was cross-checked during the preceding audit.
