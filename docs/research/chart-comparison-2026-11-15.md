# Chart execution comparison and latency verification — 15 November 2026

Baseline: deployed `e6f51c2`. This change is a read-only chart/journal change. No paper, execution, capital, risk, evidence, scanner-reading or promotion policy is changed. Vela remains 0.10.5 and its Pine bridge 0.3.4.

## Implemented

- Scanner-specific execution timezone in the Vela engine adapter. Metadata is copied per execution, preserving provider metadata and isolating simultaneously loaded scanners. Updating the configured timezone replaces that indicator instance. This is separate from the chart's display clock.
- Escaped generated Pine string literals for replay and position labels. Regression scripts with quotes, backslashes, newline and non-ASCII reversal text compile using the installed PineTS.
- Closed paper and shadow trades, including retained reset archives, on the chart timeline: actual entry, add-on/partial and final fills; price, fees, net R, funding, exit reason and policy in the mark details. Funding is not a price fill. Legacy position endpoints are identified explicitly when fill history is missing.
- Journal pagination (200 records per load), book and time-window filters, per-frame marks. The count distinguishes loaded records from the complete filtered population.
- Author strategy ledger retrieved from Vela on material run changes, not every price tick. Asynchronous results are discarded after market/source replacement or destruction. Forming-bar fills are excluded; incomplete history and unavailable ledgers remain explicit.
- Source-version-aware, same-side/timeframe/entry-bar association. Multiple candidates, missing/changed source hashes, changed chart inputs and trades outside the loaded window are not force-matched. This is a visual association, not proof of policy parity. The full author round-trip table remains accessible, including unmatched trades.
- Indicators are identified as having no strategy ledger; no fills are fabricated from their markers. Script ledgers and native price arrows are simulations, not exchange executions. They cannot become promotion or sizing evidence.
- Journal read model exposes the retained policy source hash and source scanner ID for research plans. No historical records are rewritten.

## Validation

- 1,466 server tests pass, including journal source identity and paper/shadow isolation.
- 84 dashboard unit tests pass, including Pine compilation, per-script metadata isolation, conservative matching, forming-bar exclusion and partial-fill markers.
- 18 rendered browser tests pass at desktop and phone widths. The chart test runs real Pine workers, verifies New York versus UTC hour calculations simultaneously, retrieves the strategy ledger, associates a closed bot trade, switches books and detects edited chart inputs. No API mutation is sent by the chart test.
- Server and dashboard type checks, dashboard lint and production build pass. Desktop/phone screenshots inspected.

## Latency claims checked against retained VM data

The accompanying JSON records verification time, exact rolling windows and counts. All queries used SQLite read-only mode and read-only systemd logs.

**The 99 quote-labelled entries were maker fills.** Across 14 days, all 99 have maker liquidity in their saved entry fill. 97 also retain a decision trace explicitly placing a resting limit; two lack that supporting trace. Their median wait is 114.625 seconds. Classifying them as slow market entries based on `source=quote` is incorrect. No old records were relabelled.

**Actual depth-priced taker entries:** 294 over 14 days, median signal-to-fill 2.790 seconds, p90 3.131 seconds, maximum 30.167 seconds. In the seven-day slice, 169 entries have median 2.792 seconds and p90 3.218 seconds.

**Entry signal timing, seven days:** median / p90 from candle close is 6.557 / 17.581 seconds for 15m (188 entries), 16.125 / 39.771 seconds for 1h (51), and 40.192 / 53.440 seconds for 4h (10). These are signals attached to filled account trades, not all emitted signals. No filled taker entry in the 14-day sample originated from a signal emitted more than five minutes after its bar closed.

**Late run logs are overwhelmingly startup-related.** Of 463 successful runs logged more than five minutes after close in seven days, 461 fall within three minutes after a service start. There are 53 systemd starts in that slice. Examples match the reported 8 November 06:37 and 18:35 UTC and 9 November 18:27 UTC bursts. These are not evidence that the bot entered 27–37 minutes late: startup/manual runs are logged before the stale-entry check. The remaining two run rows are not attributed by this aggregate analysis.

**Existing protections:** live jobs use a FIFO live tier ahead of mirror/shadow/background jobs, with a 240-second queue deadline. The scanner entry path and paper admission already enforce the configured 300-second maximum signal age; stale exits are handled separately to reduce risk. Resting-order expiry and valid reclaim setups have different lifecycles and must not be treated as queued market orders.

**Scheduling:** the current queue does not prioritize the longest timeframe within the live tier. The difference between a run's logged time and runtime also includes preparation/data/warm-up work; it is not a measured queue wait. A blanket 4h-first change could delay scalp work. Instrument enqueued/started/finished stages and test deadline-aware scheduling before changing priority.

**Slippage:** only 35 of 428 entries in the 14-day sample publish a signal price. New retained entry evidence supplies a separate reference for 99 entries, but it must not be backfilled from execution price or conflated with a script's theoretical price. Next measurement should retain and label signal decision quote, submission quote, fill quote and their timestamps independently.

These measurements do not establish that latency has no profit impact. That needs a price-path counterfactual at executable quotes, stratified by scanner, timeframe and order type. This deployment changes neither scheduling nor entry gates.
