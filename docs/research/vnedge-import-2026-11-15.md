# Trend Continuation and Stealth import

Reviewed on 15 November 2026. Reference: [VELA_Delta_BOT at 537ecec](https://github.com/vikkl1990/VELA_Delta_BOT/tree/537ecec), which pins [VNEDGE at f8a2505](https://github.com/vikkl1990/vnedge/tree/f8a2505843c9aaa04a7cf210db433879d44c0d90).

## What was already installed

StealthTrail SuperTrend, StealthTrail SuperTrend ML Pro and AlgoAlpha Trend Continuation are byte-identical in both repositories. Their existing IDs, source bytes and readings remain intact. No duplicate import or change to their earlier evidence.

The missing model is the source bot's **Python Trend Continuation**, distinct from AlgoAlpha's indicator. The new `vnedge-trend-continuation-v1` ports that algorithm to Pine so the existing worker, chart, screen and shadow execution paths can all use it. No Python subprocess or second execution engine is installed on the VM. The original MIT notice is retained.

## Contracts

- **VN EDGE Trend Continuation v1 (OHLC):** previous 48-close breakout, EMA 24/96 alignment, efficiency ratio >=0.30 and ATR midrank <=0.90. ATR is a 24-bar simple mean, not Wilder smoothing; EMA is seeded from the first close. Midrank counts equal values as half. Warmup is 264 bars. Stop is 2×ATR and the single full-position target is 2R. No trailing or 6R fallback.
- **StealthTrail native v1:** a separate, source-pinned reading of Willy's existing v2.0.1 source. Actual qualified entries, the source stop and all three target milestones, full TP3 closure, stop/BE closure and old-side reversal exits. TP1/TP2 are milestones, not invented scale-outs. A BE amendment takes effect after receipt/latency, never on an earlier candle extremum. Same-bar close-and-reopen waits for the old position to finish.

Both are disabled for the paper account by default. Source drift fails closed. Historical records for other scanners remain unchanged.

**Funding limitation:** the Python class accepts funding, but VELA_Delta_BOT's adapter passes none. This port matches that OHLC-only adapter; it does not claim that funding is zero or that the funding-entry filter is working. The existing execution engine still accounts for funding and retains its other admission checks. Adding a time-stamped funding feature would be a new version requiring a new evaluation.

The source repository's proposed Stealth higher-timeframe filter and stricter 4h ER threshold are not silently folded into this baseline.

## Validation

The pinned Python implementation generated the committed independent fixture. On 1,000 bars the port matches all **190 default entries and 187 entries at ER 0.35**, including sides, stops and targets. Checks also cover flat data, ATR ties, warmup, prefix stability and source-hash refusal. Stealth's appended observations leave original alerts and shapes unchanged; prefix checks agree.

An offline mechanics replay used 1,500 closed Delta India candles per cell. It replayed synthetic tape/depth through the real shadow engine with 1,500 ms latency, full fees, $150 margin and a 3% stop-risk cap. It exercised restarts, deduplication, single-target closes, milestone handling and causal stop amendments.

| Profile | Market / timeframe | Source entries | Simulated fills | Closed |
| --- | --- | ---: | ---: | ---: |
| Stealth native | BTC 15m | 50 | 13 | 13 |
| Trend Continuation | BTC 1h | 32 | 5 | 5 |
| Stealth native | ETH 15m | 36 | 24 | 23 |
| Trend Continuation | ETH 1h | 39 | 14 | 14 |
| Stealth native | SOL 15m | 42 | 30 | 29 |
| Trend Continuation | SOL 1h | 22 | 10 | 9 |

There were 24 additional sampled real-candle prefix checks. Every research position was excluded from promotion/copy/sizing evidence. Entries rejected by the unchanged fee/risk checks were retained as rejections.

**These fill totals validate mechanics, not executable profitability.** The replay uses synthetic depth, a test contract size, and no replayed funding or market-regime/liquidity callback. It starts execution after warmup; source counts cover the whole input history. Profit and win-rate claims require prospective observations.

Machine-readable results: [validation JSON](vnedge-import-2026-11-15-validation.json). Source/publication contract: [review JSON](vnedge-import-2026-11-15-review.json).

## Rollout

`ops/enable-vnedge-import-shadow.ts` adds six experimental plans: Stealth 15m and Trend Continuation 1h on BTC, ETH and SOL. Markets are selected for coverage, not historical profits. The existing 73 plans remain; the research-only ceiling becomes 79. Paper position/trade limits, sizing, risk caps, fee checks and evidence rules do not change. The earlier removal of the below-capital sizing multiplier stays in place.

The installer supports a write-free dry run, refuses edited profiles and over-capacity configurations, preserves other settings and is idempotent. For a running service, apply its validated plan list through the authenticated configuration API; do not rewrite its config behind the process.

Native experimental evidence cannot automatically qualify a scanner for paper. Review the recorded execution and results, then use the established prospective evidence process before account activation.
