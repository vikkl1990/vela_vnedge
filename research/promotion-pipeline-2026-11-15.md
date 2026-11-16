# Shadow-to-paper pipeline review — 15 November 2026

Measured from the running VM at 17:52 UTC and a consistent private database snapshot.
This is an allocation/execution-health correction, not a claimed profitability improvement.

## Current funnel

- Direct paper allocations: 35 cells.
- Paper-copy eligibility: 34 shadow cells. Entry-time market, signal, capital and risk checks
  still apply; eligibility does not promise a fill.
- Formal shadow capacity: 1,080/1,080, with 1,958 candidates waiting at audit time.
- No formal gate promotion in the previous 14 days. Existing automatic review is enabled.
- Current-policy live-readiness history: 27 trades against the unchanged 200-trade minimum.
  The other five displayed checks pass. Small-sample bootstrap projections are not forecasts.

## Confirmed error

Six formal shadow cells were still allocated despite scanner-health quarantine. Registry
`status: ok` alone did not represent operational availability. They held no account or shadow
orders/positions. Normal admission refused their scanners, but retirement, approval and copy
paths did not use the same health check.

| Scanner | Market / timeframe | Quarantine |
| --- | --- | --- |
| STP Flip Anti Whipsaw Modified Always In Overnight Strategy | GRIFFAINUSD 15m | Memory |
| Volume Weighted S/R Zones | AKEUSD 15m | Memory |
| Synapse Trail Pro | STRKUSD 15m | Memory |
| MACD Matrix | ETHUSD 4h | Repaint |
| MACD Matrix | XRPUSD 4h | Repaint |
| Squeeze Breakout Pro | ZECUSD 1h | Memory |

The correction releases only unheld formal allocations. It keeps watch subscriptions and
held exit handling, prevents new entries/copies/promotions for quarantined scanners, and
guards asynchronous rechecks. All automatic retirement paths now also protect account-held
positions/orders instead of checking only the shadow book.

## Identical-snapshot comparison

Both runs use the same database, configuration, source versions and evaluation time
(2026-11-15 18:00 UTC). Research runs never write into production journals.

| Result | Current bot | Correction |
| --- | ---: | ---: |
| Normal retirements | 14 | 20 |
| Ranked shadow admissions | 14 | 20 |
| New paper proposals | 0 | 0 |

The six incremental shadow admissions were Momentum Index BLESSUSD 1h, FIA Trend Momentum
SOLUSD 1h, Universal Signal Backtester EVAAUSD 1h, Supertrend BB Strategy VVVUSD 1h, 80 Rule
BTCUSD 1h, and Session VWAP Profile Candle Delta EVAAUSD 4h. These are research candidates,
not paper-qualified strategies. Actual admissions may differ as markets/evidence advance.

Pooling scanner cohorts under the current full gate yielded zero passing cohorts. Therefore
this review does not switch pooling, waive provenance, lower trade counts or force promotions.
Historic missing-policy, changed-execution and experimental trades remain excluded.

## Validation and rollout

1,567 server tests pass; TypeScript checking passes. Six new regressions protect both books,
copy recovery, promotion and quarantine timing. Deploy only after CI passes and verify the
normal evaluator's resulting stages, service health and unchanged configuration hash.

Maintain paper execution, $150 margin, risk caps, evidence rules and live locks. No exchange
orders, risk changes, scanner reading changes or manual paper promotions are part of this fix.
