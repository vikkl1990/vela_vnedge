# Restored shadow collection audit — 10 November 2026

The VM at `07d57df` has 33 restored cells: 17 on 15m and 16 on 1h. All are in shadow, with valid scanner sources and no quarantine. The initial read-only audit at 17:34:51 UTC found 31 cells with entry signals in the preceding 24 hours and 60 filled shadow trades (55 closed, five still open), plus one pending order. Scalping Ichimoku / INITUSD 15m and VWAP SD2 Reversion Long / XRPUSD 1h had no entry signals in that interval.

All 33 have recent completed-bar watermarks. Their prospective windows began at 17:30:18 UTC; no new window had yet completed its first scheduled scan at the initial audit. Historical activity is operational evidence, not permission to admit them to paper.

## Collection correction

A restart just after a bar close could miss that close: initial history loading marks the bar as emitted, while shadow scheduling listened only to subsequent live closes. Recover only the newest closed bar while its original signal-age budget remains valid, after candle history and reconnect repair are ready. Deduplicate recovery, live close events and repeated syncs against both in-flight work and persisted watermarks. Preserve bounded worker concurrency, account priority, deadlines and execution checks. Repaired candles remain historical for paper fill handling; scheduling a fresh scan does not backdate an order or fill.

Persist a bounded latest scan receipt per cell, including failures, waiting for repair, queue expiry, successful bar time and entry signal count. Show collection status, raw new filled/open/pending counts and actual entry outcomes separately from the qualified forward sample. Receipts and gated signals cannot create qualifying trades. A zero-signal scan is distinct from a scanner that did not run.

## Validation

1,109 server tests and 22 dashboard tests pass. Dashboard lint and production build pass. Server type checking retains the same 31 existing diagnostics, with none added. New regressions cover fresh recovery, duplicate events/syncs, existing watermarks, stale deadlines, repair/disconnection barriers, failed-run retry, expired queue outcomes, receipt ordering and separation from evidence.

The 33 enrollment clocks and requirements, paper mode, $150 margin, leverage and risk caps remain unchanged. No paper admission is forced; forward evaluation must pass before copying, promotion or evidence-based sizing. This corrects collection reliability and visibility; it does not establish a profitability improvement.
