# Improvement plan — 25 November 2026

Reviewed against `main` at `#116` (23 November). This corrects an earlier draft that was
written from `ARCHITECTURE.md` (last edited 6 November) and stale `PROCESS.md` / `STATE.md`;
276 commits have landed since. It maps onto the execution-contract sequence in
[ROADMAP.md](ROADMAP.md) (EC-01 … EC-10) rather than running a parallel list.

Structural items preserve every strategy setting (recovery plan, "Delivery sequence"). Items
that change admission, fleet or fill behaviour are listed separately as experiments and need
a registered hypothesis, frozen control and predeclared criteria before they run.

## Verified current state

| Area | Status in code | Evidence |
|---|---|---|
| Account signal inbox | Delivered | `scanners/inbox.ts`, `scanners/recovery.ts`, `inboxRecovery.test.ts` |
| Exchange outbox + order ledger | Delivered | `execution/outbox.ts` (throws outside the paper-fill transaction, `vnedge-so-<id>`, 5 states), `execution/ledger.ts`, `recoveryCrash.test.ts` |
| Forward-evidence identity | Delivered | `paper/strategyIdentity.ts` hashes source, reading, exit mode, paper costs, regime and sim version into `strategyId`; `evidence/compatibility.ts`; `shadow_execution_cohorts` keyed by `strategy_id` |
| Frozen evidence scope / adopted positions | Delivered | `positions.evidence_scope`, `adopted_at_migration` |
| Shadow restart handling | Partial | Replay-restored cohorts (#106/#109), `incubator/copyRecovery.ts`, journal warm-up (#112/#114). No inbox-style receipt/decision boundary for shadow entries. |
| Post-commit observers (ML, alerts, risk bookkeeping) | Gap | No durable consumer cursor in `server/src` |
| Cached backtests / walk-forward | Gap | `backtests` primary key is `(scanner_id, symbol, tf)` only |
| ML fitting | Gap (EC-10 deferred) | `trainLogReg` runs synchronously in `ml/service.ts` on the main thread; only Pine runs in workers |
| Whole-process lifecycle | Partial | Fatal-shutdown, deferred-recovery cancel, listen-before-background work (#86, #96, `startupLifecycle.test.ts`). Audit `App.stop()` before ranking further work. |

## Built on branch `Local-PC` (25 November)

- **S3 (cached backtests / walk-forward):** done. `validation/evidenceKey.ts` stamps results with
  `strategyId` + window; auto-tune, the OOS lookup and the warm-up skip ignore stale or unstamped
  rows. This also fixes `warm()` reusing a <6 h backtest after a source or settings edit.
  Tests: `validation/evidenceKey.test.ts`, `scanners/autoTune.test.ts`.
- **S1 (observers), learning part:** done. `ScannerEngine.recoverLiveSamples()` restores ML samples
  lost between commit and callback. Test: `scanners/liveSampleRecovery.test.ts`. Risk close
  bookkeeping was already durable. Alerts are intentionally not replayed.
- **S2 (shadow receipts):** done. `incubator/shadowInbox.ts`: each event a run applies to the
  shadow book gets a receipt in the same transaction that advances the persisted watermark;
  the decision and the receipt's completion share one `commitDecision`. Startup and a 5 s timer
  retry pending receipts, exits first; entries expire after ≤ 60 s and need an unchanged source,
  reading and active pair plus a fresh price, and execute at the current mark; a recovered exit
  touches only the position it was received for. Done receipts are pruned after 14 days.
  Account mirroring is unchanged (it has its own inbox). Test: `incubator/shadowInbox.test.ts`.
  The forked-process SIGKILL variant was not added; the rollback test simulates the kill inside
  the transaction.
- **S4 (ML off the hot path), training part:** done. Scheduled and API retraining
  (`MlService.trainAsync`) runs in a short-lived worker thread (`ml/trainWorker.ts`) that opens
  its own read-only SQLite connection, reads and parses the samples and fits every model; the main
  thread only installs and saves the result. The pure fitting code (`ml/training.ts`) is shared
  with the synchronous `train()`, so results are identical (tested with a real worker). One run at
  a time; a failed worker falls back to in-process training; `VNEDGE_ML_WORKER=0` disables it.
  Scoring stays in-process (a dot product). **Not done in S4:** large replays and walk-forward runs
  still post-process on the main thread, and the close-to-scan / signal-to-decision / queue-age
  latency budgets are not yet measured. Test: `ml/trainWorker.test.ts`.
- **Not started:** S5, S6.

## Structural work (ordered)

### S1. Durable cursors for post-commit observers
Learning, alert and risk-close consumers read committed journal rows through an independent,
persisted cursor per consumer; idempotent on replay. Safety-critical bookkeeping catches up
before new entry decisions after restart (recovery plan §6). Reuse the existing journal; this
is not an outbox extension and must not create a second ledger.

Acceptance: SIGKILL after commit and before each callback recovers exactly one effect per
consumer; cursors never regress; entries wait for risk catch-up.

### S2. Shadow receipt boundary
Give shadow entry/exit delivery the same receipt → single-transaction decision → retry
(exits first) contract as the account inbox, keyed by the existing source event identity.
Preserve held-position exits during migration.

Acceptance: the same SIGKILL points as `inboxRecovery.test.ts`, against the shadow book.

### S3. Version keys for cached backtests and walk-forward
Add `strategy_id` (or source hash + inputs + reader + policy + cost model + data window end)
to `backtests` and `walk_forward` with an additive migration. Old rows stay readable and are
labelled legacy; promotion and auto-tune read only compatible rows.

Acceptance: a source, input, reading or cost change makes old cached rows non-qualifying;
a UI-only commit does not.

### S4. Bounded research and ML off the hot path (EC-06, unblocks EC-10)
Run ML fitting and large replays in a bounded worker/process with CPU and I/O budgets;
pause dispatch when live scan latency degrades. Measure close-to-scan, signal-to-decision,
queue age and feed lag at full research load and publish the budgets.

### S5. One readiness state and operator surfaces (EC-09)
Fee-in-R, the refusing gate and demotion clock on Signals, Scanner and Incubator from one
backend read model.

### S6. Scheduler unification
Unify identical source/input/cell requests across account and shadow, then fan out to
versioned books. Only after S2, so both sides share one event identity and recovery model.

## Experiments (each needs its own decision record)

| Experiment | Note |
|---|---|
| OOS auto-tune by default; t-statistic gate | Changes admission. EC-08 says existing qualification rules are unchanged. |
| Higher timeframes / volatility floors for BTC/ETH/BNB 15m | `paper.minRiskFeeRatioBySymbol` already exists; test with it before adding a new mechanism. |
| Tape fills as the screening default | Changes the fill model; compare against candles on the same cells. |
| Named, versioned exit plans; structure stops | Use `executionPlans` with plan prefix; experiment outcomes stay excluded from promotion. |
| Verified Scalper Offer path | `fullFeeCompatible()` already admits only verified offers; extend only on exchange confirmation. |

## Documentation fixes

- Cost rule: `config.ts` default `minRiskFeeRatio: 4` (per-market overrides in
  `minRiskFeeRatioBySymbol`); `PROCESS.md` says six round trips and `STATE.md` says 2×. The
  deployed `data/config.json` may override the default; check it before editing either doc.
- The nightly screen already skips quiet markets on fast timeframes (decision 115), which
  partly covers the "15m majors burn scan capacity" concern.
- `PROCESS.md` is written at decision 114 (log is at ~322); `STATE.md` was generated 9 October.
  Regenerate `STATE.md` with `npm run state` and date-stamp `PROCESS.md` changes.
- `ARCHITECTURE.md` "Remaining production work" predates #86–#116; update items 1, 2 and 5.

## Platform note

The SIGKILL, file-permission and directory-fsync tests fail on Windows (101 of 2029 locally).
The durability contract is verified in CI on Linux/macOS, not on a Windows development box.
