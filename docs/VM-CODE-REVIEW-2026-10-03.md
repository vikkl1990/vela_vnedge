# VM code review — 3 October 2026

## Scope and baseline

Read-only review of `/opt/vnedge` on the VM, with local tests against a downloaded source snapshot. No VM configuration changes, service restarts, deployments, or exchange orders were performed by this review.

The VM changed during the review: `4866821` → `4d2d129` → **`c3edf77a2e62b6df6a22f0334cec5415564f675a`**. Findings below were checked against the final commit. The intervening Decision 71 changes concern drawdown reporting and do not repair these findings. The relevant changed server files were refreshed in the snapshot before rerunning tests. The service was active at the last check.

Runtime/configuration observations captured at 04:52:39 UTC, while `4d2d129` was deployed: execution was **paper**, production execution disallowed, risk sizing 1% per trade, regime efficiency threshold 0.25, automatic tuning and automatic walk-forward disabled, incubator auto-promotion enabled. These observations are timestamped, not a guarantee of subsequent configuration. The actual worker resolved PineTS **0.10.0 from server/node_modules**; the root-level 0.9.34 installation is not the worker runtime.

The review concentrated on scanner scheduling, signal interpretation, validation/promotion, paper persistence, execution reconciliation, and market risk gates. It is not an assertion that every scanner script or every code path was exhaustively tested.

## Findings

### 1. P1 — Validation measures a different strategy from the live scanner

Locations in the saved snapshot: `server/src/validation/service.ts:160–166`, `server/src/scanners/engine.ts:396–422`.

Live signal extraction supplies scanner-specific sources, edge behavior, label filters, and inversion. Walk-forward extraction supplies only derived events. The validation worker also omits the scanner timezone. Its simulation call does not carry the scanner exit overrides or the live regime efficiency gate. Warm backtests and CLI incubation have related configuration omissions.

**Reproduction:** a scanner configured to accept only `LONG` labels and invert them produces one short event through the live extraction path. Validation produces both the original long and short events. A configured `America/New_York` timezone is absent from the captured validation worker job.

Consequently, a profitable validation result need not describe the signals, directions, sessions, or exits that the deployed strategy trades. This matters to manual tuning now and to the credibility of screening and promotion evidence; it does not prove a particular live trade lost money. Automatic tuning is presently off.

**Repair:** define one resolved strategy specification and share its worker configuration, event extraction, and simulation settings across live, warm-backtest, walk-forward, and screening paths. Add parity tests with label filtering, inversion, timezone and exit overrides. Version or fingerprint stored results by source, inputs, interpretation settings, runtime, and simulation assumptions; the current simulation-version check alone cannot invalidate all stale strategy results.

### 2. P1 — Opening a paper position and recording its entry fill are not atomic

Location: `server/src/paper/engine.ts:290–298`.

`openAt` updates the in-memory position map, persists the position, and separately persists its fill. No transaction encloses those writes. Event publication happens afterward.

**Reproduction:** injecting an error into the `INSERT INTO orders` write leaves a persisted `open` position with zero order rows. The operation throws after the in-memory position has also been added. This is a current paper-mode problem, conditional on a write failure or interruption between writes.

The resulting position has no recorded entry fill, while downstream consumers may never receive the opening event. Recovery cannot safely infer that the logical operation completed merely from the presence of the position row.

**Repair:** commit the position and entry fill in one database transaction, then publish the committed state to memory and subscribers. For execution-dependent events, persist a recoverable delivery record in that transaction. Add rollback and restart tests that inject failures between each durable write.

### 3. P1 — Residual exchange exits flatten exposure but misstate P&L and fees

Locations: `server/src/execution/testnet.ts:224–232,301–313`; `server/src/paper/engine.ts:534–538`.

The first confirmed partial market exit restates a full paper exit using its price and fee, without its executed quantity. A subsequent residual exit calls `restateFill` with reason `stranded`, but no paper fill with that reason exists; the method returns without accounting for that execution.

**Fake-exchange reproduction:** enter 200 contracts at 100.5; close 120 at 99.2 with a 0.12 fee; reject the immediate residual retry; then close the remaining 80 at 99 with a 0.08 fee on the next sweep.

| Result | Recorded | Expected from confirmed fills |
|---|---:|---:|
| Realized P&L before fees | −260 | −276 |
| Exit fees | 0.12 | 0.20 |
| Remaining exchange exposure | 0 | 0 |

Protection/retry handling succeeds in this test. Accounting remains wrong even after exchange exposure is cleared, affecting risk and performance consumers of the paper ledger. This is **latent while the VM stays paper-only**; no real exchange incident is claimed.

**Repair:** account for every confirmed execution by quantity and exchange fill identity, aggregating weighted prices and fees idempotently. Reconciliation must repair the accounting as well as the outstanding exposure. Test partial fills, retries at different prices, duplicate confirmations, and restart recovery.

### 4. P2 — Explicit-pair migration is incomplete in tuning and validation

Locations: `server/src/scanners/engine.ts:134–141,254–261`; `server/src/validation/service.ts:101–109`.

The scheduler correctly prefers explicit `(symbol, timeframe)` pairs. Tuning still writes separate symbol and timeframe lists, leaving existing explicit pairs intact. Validation still enumerates the Cartesian product of those lists.

**Reproduction:** configure only BTCUSD/15m and ETHUSD/1h. Reject BTCUSD/15m on out-of-sample metrics and retain ETHUSD/1h. The tuning report says only ETHUSD/1h remains, but `pairsFor` still schedules both original pairs and `runsOn` returns true for the rejected BTC pair. Validation creates four jobs from the two configured pairs, including BTCUSD/1h and ETHUSD/15m.

This creates a false impression that tuning has removed an exposure and spends validation work on combinations outside the intended strategy. Automatic tuning is disabled on the observed VM, so this currently requires manual invocation or subsequently enabling it.

**Repair:** have tuning write the canonical retained pairs. Make validation jobs and enabled-state summaries consume the same pair enumerator as the scheduler. Assert that a rejected pair is actually unscheduled, rather than testing only the report or legacy configuration fields.

### 5. P2 — Enabled market gates treat missing data as permission

Locations: `server/src/risk/manager.ts:165–166`; `server/src/risk/marketGate.ts:56–59,76–104`.

Risk rejects a market only when a verdict exists and explicitly disallows it. Unknown markets return no verdict. During refresh, missing tickers, books, and candles omit their respective rejection reasons; the verdict lookup also does not enforce freshness of the stored snapshot.

**Reproduction:** with the gate enabled, an absent verdict produces no rejection. Separately, failed ticker/book providers and missing candle data produce `allowed: true`, an empty reason list, and null turnover, ATR, spread, and book-cost fields for a market with no historical trades.

This is a fail-open design gap during startup, data outages, or newly introduced markets. It is not evidence that the VM was experiencing an outage during this review.

**Repair:** distinguish allowed, rejected, and unavailable. Defer new entries when data required by enabled checks is missing or stale; retain any deliberate exemptions explicitly. Add per-input freshness and outage tests.

## What improved since the earlier review

The reviewed code includes stronger execution-mode checks, reset/exposure guards, ordered flattening, residual-exposure retries with protection retained until flat, worker recycling, and explicit-pair scheduling. The residual-exit reproduction confirms that exposure is actually cleared before protection is removed. Those improvements do not resolve the accounting, persistence, or validation parity defects above.

## Tests and evidence

Artifacts are in `_research/vm-review-20261003/`:

- `snapshot/`: reviewed server source, updated for relevant changes through `c3edf77`.
- `vm-state.json`: timestamped, sanitized VM observations from `4d2d129`.
- `repro.mjs`, `repro-results.json`, `repro.log`: deterministic reproductions for validation interpretation/timezone, explicit pairs, missing-data gates, and non-atomic persistence.
- `exchange-repro.test.ts`, `exchange-repro-results.json`: fake-exchange partial/residual-fill reproduction.
- `tests.log`: **77 passing tests: 76 existing focused tests plus one new test asserting the accounting defect is present**. A passing defect reproduction means the defect was reproduced, not repaired.

The existing tests cover scanner scheduling/tuning, risk, incubation, exchange execution, and the worker pool. Tests ran locally against the downloaded source using in-memory databases and fake workers/exchange transports. No full repository suite, real exchange execution, or comprehensive PineTS/scanner parity run was performed.

Run from the repository root:

```sh
node --no-warnings _research/vm-review-20261003/repro.mjs
node --no-warnings --test _research/vm-review-20261003/exchange-repro.test.ts
```

Priority for follow-up: restore validation/live strategy parity and transactional position creation first; fix canonical pair consumers and missing-data handling; repair and verify execution accounting before relying on exchange mode. This review adds evidence and documentation only; application fixes remain outstanding.
