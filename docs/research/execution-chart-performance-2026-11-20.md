# Execution coverage and Vela chart performance

Date: 20 November 2026. Baseline: main dd85856. Paper mode and saved settings unchanged.

## Execution investigation

The fixed 48-hour review ended at 2026-11-20 16:04:10 UTC. It contained 131 closed paper trades, cash PF 0.791, 41 stop exits and net −$74.89. Trigger-to-fill median was 1.703 seconds; ten exits exceeded ten seconds and the maximum was 31.046 seconds. Fresh depth at the eventual fill does not explain the time before it arrived. Historic request/loop telemetry was absent; the scheduling defect below is reproducible, but cannot be credited with causing all ten delays.

Previously the exit pump returned immediately with two requests in flight, including when verified streaming depth could already fill an account exit. The correction first settles eligible streaming observations and reserves public-read capacity for account exposure. Total concurrency remains two. Research can wait longer for its second REST request while the account is exposed; it continues to make progress through its first slot.

Controlled simulation, same prices, 100 ms pump clock, two 2-second research reads:

| Condition | Baseline ready-to-fill | Corrected ready-to-fill |
| --- | ---: | ---: |
| Fresh execution stream available at arrival | 1,700 ms | 0 ms on that pump tick |
| Account requires REST; account exposure reserves a slot | 1,700 ms | 100 ms |

This is a scheduling regression test, not a profit backtest or a promise of zero live latency. Arrival, freshness, partial depth and shared liquidity remain enforced.

Entry context and original market timestamps are retained for selected active/recent trades; post-close tape is needed to judge winners a proposed early exit would cut short. The focused archive remains capped at 4 GiB/21-day target and the broad archive at its existing cap. Coverage is never backfilled by pretending candles are ticks. Diagnostics and new capture cannot count as promotion evidence.

## Chart performance

The installed/latest release is Vela 0.10.13. Its [official changelog](https://github.com/LuxAlgo/Vela/blob/main/CHANGELOG.md) reports faster WebGL line rendering in 0.10.9, already included in our pin. That upstream claim is not a measured speedup for this dashboard.

The integration had independent avoidable work:

- Position and stop changes generated new Pine source. Native price lines now update without compiling a script or replaying historical bars.
- Every timeframe change destroyed the chart. It now switches market in place.
- Adding a frame remounted the whole grid. Existing frames now keep their canvases and workers.
- A bare candle chart waited for Pine and started a worker. Pine is now loaded only for selected scripts.

Browser regressions use real Vela/Pine workers with isolated API fixtures. They verify native stop updates through the actual SSE/React Query path, no Pine worker for a position-only chart, the same chart on timeframe changes, and exactly one new worker when adding one frame. Existing tests still exercise every supported timeframe, per-script New York/UTC execution and recorded fills against author ledgers.

Native live levels are hidden during historical replay; the existing causal replay overlay is unchanged. No server reader, scanner eligibility, chart plot limit, paper risk rule or exchange order path is changed by this UI work.

## Rollout and limits

Deploy the tested revision once with config-byte equality checks and a rollback copy. Check service health, diagnostic rows, focused capture and the published dashboard asset hashes afterwards. Observe natural fills; do not manufacture entries to validate it.

Scanner-specific invalidation, partial targets and conditional profit protection remain evaluation work. This release supplies more trustworthy execution and the data needed for those decisions; it does not claim improved PF or authorize an unproven exit.
