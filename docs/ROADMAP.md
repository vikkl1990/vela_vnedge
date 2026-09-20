# Next phases: making VNEdge robust

State today: 1,031 scripts catalogued, 14 scanners live on tuned pairs, paper engine with
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
