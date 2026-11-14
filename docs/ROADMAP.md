# Execution-contract implementation — 14 November 2026

The current development sequence extends the existing reader, PaperEngine, contract registry,
research plans and shared evidence rules. It does not introduce a second execution engine.
Production market data remains the source; paper execution and existing risk caps remain in force.

| Work | Status | Acceptance boundary |
| --- | --- | --- |
| EC-01 Reproducible execution evidence | Built | Read-only SQLite snapshot, explicit UTC window, exact medians, separate policies/books/scopes, unknown cost and ownership retained |
| EC-02 Confirm high-impact gaps | Queue built; verification in progress | All active profiles plus top 150 by activity; exact-contract decisions, source evidence and regression references; unknown claims stay unknown |
| EC-03 Executable-contract specification | Manifest/proof foundation built | Source/runtime/reading/implementation identity, lifecycle ownership and required mechanics proofs; no automatic runtime adoption |
| EC-04 Causal order intents | Pending verified adapter changes | Reuse existing entry/outbox/exit lifecycle; no historical fills, duplicate actions or fills during downtime |
| EC-05 Parity and capital feasibility | Pending per-contract proofs | Closed-bar/HTF/pivot causality, real tape/depth coverage, full costs and a shared $1,000 portfolio; no risk-cap relaxation |
| EC-06 Bounded research | Pending | Frozen inputs, checkpoints, API/CPU/I/O budgets; pause dispatch if live scans degrade |
| EC-07 Native/current shadow | Existing MarkitTick comparison remains active; broader rollout pending | Same signal and initial stop for exit-only studies; all fills, misses and open trades counted; experiments excluded from promotion |
| EC-08 Qualification | Existing rules unchanged | Prospective ordinary shadow evidence for the exact selected policy; existing evidence and risk criteria must pass |
| EC-09 UI consolidation | Pending | One backend readiness state across Library, Scanner, Incubator, Decisions and Journal |
| EC-10 ML | Deferred | Advisory, later-period net-return improvement beyond the non-ML baseline; no LLM in the order path |

A source ledger is a reference, not an executable fill history. The 3% stop cap limits modeled
loss relative to equity, not the price distance to the stop. Wider source stops can be expressed
with smaller quantity; no cap needs to be lifted merely because a source stop is wider than 3%.
The user's future allocation design may use flexible margin; this foundation changes no current
margin, leverage, capacity, fees, stops, targets or admission setting.

Reproducible research commands (outputs must not already exist):

```sh
npm run research:execution-evidence -- --db /path/to/vnedge.db --from 2026-10-15T15:50:00Z --as-of 2026-11-14T15:50:00Z --out /path/to/new-evidence.json
npm run research:contract-review -- --evidence /path/to/new-evidence.json --config /path/to/research-config.json --decisions scripts/execution-contract-decisions.json --reviewed-at 2026-11-14T15:59:36.266Z --out /path/to/new-review-directory
```

Run against a read-only local snapshot or use the exporter with a read-only database connection.
Do not create an application `Db` instance against production for this research: that constructor
performs migrations. The CLI performs no migrations, order operations, config writes or promotion.
Preserve the evidence JSON, producer/data hashes, code revision and selected configuration with the
report. A fixed cutoff does not reconstruct corrections posted later: the exported snapshot is the
reproducible input. Funding rows show booked cashflows, not proof that historical funding is complete.

The report's contract validation is for proposed adoption. Missing proof does not become an extra
runtime gate on current scanners. A `shadow-ready` mechanics result still cannot authorize paper:
experimental outcomes remain excluded and ordinary prospective evidence must pass existing rules.
Do not transfer claims or tests between source/reader/implementation versions. Review files are
annotative, never admission inputs. Full implementation hashes intentionally invalidate research
mechanics receipts when shared scanner/execution code changes; existing strategy IDs are untouched.

# Historical roadmap (retained for context)

Earlier baseline: 1,031 scripts catalogued, 14 scanners live on tuned pairs, paper engine with
isolated margin and liquidation, ML trade-learning, auto-tune, analytics. Everything below is
what stands between "works on ten days of data" and "trustworthy".

## Phase 1 — Honest validation (first, everything else depends on it)
- **Walk-forward auto-tune.** Tune symbol lists and scanner selection on window A, report on
  window B that the tuner never saw; roll the windows daily. Analytics shows in-sample and
  out-of-sample side by side and flags any scanner whose OOS profit factor < 1.
- **Longer history.** Page Delta candles back 60–90 days per symbol (4,000-bar chunks) so
  per-pair samples are hundreds of trades, not 3–20; keep a local candle cache in SQLite.
- **Stability checks.** Require a minimum trade count and a minimum number of positive
  weeks before a scanner×pair can go live; auto-tune demotes on OOS failure, not just in-sample.
- **Shadow variants.** Run the ML-gated and un-gated fleets in parallel as two paper accounts
  and compare, instead of flipping settings blind.

## Phase 2 — Execution realism
- Fill on Delta's trade/ticker stream (or 1s bars) rather than 1-minute candles; model
  intrabar order for stop vs target using the tape.
- Mark-price liquidation and funding: subscribe to mark price and funding rate, charge
  funding every 8h to open positions (it is a real cost at 5–50x).
- TP legs as resting limit orders with queue-position assumptions; slippage scaled by order
  size versus book depth (Delta `l2_orderbook`).
- Latency model: signal at bar close + N seconds, fill at the next tape print.

## Phase 3 — Risk layer (portfolio, not per trade)
- Daily and weekly max-loss kill switch; max concurrent positions per symbol and total;
  correlation cap (BTC-beta exposure); cooldown after N consecutive losses per scanner.
- Drawdown-scaled sizing (halve leverage below −10% from the equity peak).
- Regime filter from the learned rules: no entries when ATR% < 0.30, no weekend entries,
  configurable per scanner.
- Per-scanner risk budget so one noisy scanner cannot dominate the purse.

## Phase 4 — Reliability and operations
- Process supervision (launchd or pm2) with auto-restart; heartbeat and Telegram alerts on
  feed loss, worker crash loops, queue depth, equity drawdown.
- Candle integrity: gap detection on reconnect with backfill and a re-run of affected bars;
  clock-drift check against exchange time; symbol lifecycle (delistings, tick-size changes).
- Backups: nightly SQLite snapshot; log rotation; a `/api/metrics` endpoint for Prometheus.
- Tests: recorded-feed replay integration test (deterministic candles in → expected fills
  out), property tests on the fill logic, CI on GitHub Actions running tests, type-check,
  build and lint on every push.

## Phase 5 — Path to real orders (still demo first)
- Reconcile the demo account with paper positions on a timer (sizes, average prices,
  open orders); alert on drift.
- Place exchange-side stop and take-profit orders (reduce-only) so exits do not depend on
  the bot being up; emergency close-all with confirmation.
- Read-only production key in dry-run mode for weeks before any order permission.

## Phase 6 — Model and scanner quality
- Walk-forward retraining with probability calibration; drift monitoring on features.
- Per-script input overrides through PineTS inputs (tune lengths and thresholds per pair).
- Derivation rules for the ~56 silent-but-tradeable scripts (trailing stops, oscillators).
- Consensus logic: require two independent scanners to agree on a bar before entering, and
  de-duplicate scanners that emit the same signal on the same bars.
- Multi-timeframe: 5m and 1h alongside 15m with per-scanner timeframe tuning.

## Suggested order
1 (validation) → 3 (kill switch and regime filter) → 4 (supervision, alerts, CI) → 2 → 5 → 6.
Do not add order permissions before phases 1–4 are in place.
