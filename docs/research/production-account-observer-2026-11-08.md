# Production account observer — 8 November 2026

First implementation slice of A1 in [the production rollout](../GO-LIVE-ROLLOUT.md). This adds continuous read-only observation while the executor stays in paper mode. It does not complete P3 or authorize real orders.

## Delivered

- The saved production credential store supplies a narrow GET-only capability: account identity, balances, open orders, position discovery/realtime position reads, fills and wallet transactions. No executor or order writer is constructed.
- Account identity comes from `GET /v2/users/trading_preferences`. State and history keys include environment and account ID. A replacement key for the same account resumes that account's cursor; another account gets separate records even when IDs overlap. Removing or replacing credentials invalidates subsequent requests and prevents in-flight results from being published.
- The initial import covers the previous hour. Subsequent imports overlap five minutes and advance at most one hour per cycle, with missing coverage displayed. Every page, both histories and the full observation must succeed before the ledger and cursor commit together. Missing pagination, cursor loops, conflicting duplicate rows, invalid IDs/timestamps and identity mismatches fail closed.
- Polling runs every minute after success, backing off to at most five minutes on errors. Each reader has an overall time budget plus per-request timeouts. Concurrent syncs coalesce; stopping the observer prevents in-flight commits.
- Exact reported decimal strings, commission and fee-credit metadata are retained separately. Missing monetary fields remain unknown. Private metadata and credentials are not retained in the observation ledger or returned to the dashboard.
- Exchange shows current account reference, balances and credits, actual positions/open orders, last complete sync, imported interval, remaining tail and recent accounting evidence. Legacy executor records remain separate because their account identity was never verified.

## Validation

- 1,000 server tests and 7 dashboard tests passed; server type checking and dashboard lint/build passed.
- New tests cover account/key rotation, invalidation in flight, restart/backfill, atomic failure, stale/backward clocks, concurrent sync/shutdown, pagination errors, malformed rows, unknown fees, realtime confirmation of lagged position inventory and an empty account.
- Read-only production probe from the VM using the saved credentials succeeded on 8 November 2026: **7 wallet balances, 0 open positions, 0 open orders, 0 fills and 0 wallet entries in the sampled preceding hour**. No credentials were copied off the VM; no orders were sent or cancelled.

## Explicitly pending

This is an observation/import milestone. It does **not** claim complete balance-to-ledger reconciliation, verified cash fee/tax allocation, promotion eligibility, private-stream continuity, late-settlement reconciliation, protective-order behavior or profitable execution. The quiet production account proves read access only.

REST responses are not an atomic exchange snapshot. The margined inventory can lag; the reader confirms discovered products through realtime position reads and also includes products from open orders, recent fills and previously held positions. A private stream and periodic full reconciliation remain required before live use.

History before the displayed starting time is not imported. The five-minute overlap does not prove that older late-posted events have all arrived. A deeper periodic settlement audit and explicit reconciliation discrepancies are the next A1 slice. Do not add imported wallet entries or vouchers to simulated trading P&L.

Paper sizing stays at $150 margin, with its existing variable leverage, 3% stop-risk cap and 6× risk-to-cost policy. Production execution remains disabled. Seven continuous days of observation and real account lifecycle evidence have not yet been established.

Official schema reference: [Delta Exchange India API documentation](https://docs.delta.exchange/), including trading preferences, wallet balances/transactions, fills, open orders and realtime positions. Production host: `https://api.india.delta.exchange`.
