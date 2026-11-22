# Research capacity and profit capture — 17 November 2026

## Capacity correction

The shadow dispatcher counted an entire scan plus subsequent pricing/admission I/O as one compute slot. A Pine worker could finish while its dispatch permit remained held until depth, copying and journal processing finished. Separate those permits from result settlement: at most six research scans can compute on the eight-worker VM, and at most 24 results can be in flight. Per-cell ownership lasts until all processing finishes. Repeated release calls cannot release a later run of the same cell.

The same paper/mirror priority, two reserved workers, memory guard, least-recently-served fairness, freshest-bar coalescing, original five-minute freshness limit and entry checks apply. No worker increase, shorter lookback, late entry replay or risk-policy relaxation is included. Outstanding result count is bounded, and computing/settling counts are separately visible in dispatch diagnostics.

Controlled load test: 1,600 jobs, each with 800 ms of scan work and 1,000 ms of asynchronous settlement, against the real pool/dispatcher with simulated workers. Baseline completed 984 and expired 616; the split completed 1,600 with no expiry, using at most 18 outstanding results. Ten injected paper jobs each completed in 200 ms under both schedulers. This deliberately reproduces I/O contention; it is **not a prediction of live throughput**.

The read-only 12:45 UTC live sample showed research workers busy for most of the backlog. This fix removes avoidable idle time; it cannot create CPU capacity or guarantee zero expiry on every combined 4h close. Preserve the freshness boundary if a wave still exceeds capacity. Compare deployed cycle receipts and paper latency before drawing a stronger conclusion. Numeric observations: `research-capacity-2026-11-17.json`.

## Profit capture

Snapshot: 1,166 closed paper trades and 16,748 ordinary shadow trades with positive stored risk. Another 447 research-plan trades are separate. This is a historical journal audit, including legacy execution policies, not a promotion-qualified backtest. Shadow dollars represent virtual sizing and are not account cash.

| Trailing exits | Count | Median displayed peak retained | At least 40% displayed giveback |
|---|---:|---:|---:|
| Paper, all history | 726 | 75.9% | 92 |
| Paper, last 7 days | 145 | 73.5% | 28 |
| Paper, last 24 hours | 30 | 76.4% | 6 |
| Shadow, last 7 days | 2,870 | 72.9% | 583 |

The concern is particularly valid for **Trend Impulse**: 50 paper closes in seven days lost 10.70R ($179.47); its 26 trailing exits retained a median **59.5%** of displayed peak, and 14 gave back at least 40%. Donchian's 13 trailing exits retained 77.0%. These are descriptions, not proof that changing a trailing percentage improves returns.

### Why displayed peak and final R differ

`trailStop` records peak price movement divided by original stop distance. Final net R divides profit after commission and funding by stored dollar risk, which also includes modeled execution costs. `recordPath` additionally takes the maximum with net open R, so the historical peak field has mixed semantics. It is not an executable net-profit high-water mark. Historical values and the trailing engine must not be silently rewritten because that would change outcomes/evidence.

INIT trade #20645 illustrates the split: displayed +0.502R peak versus +0.309R closed, or 38.6% apparent giveback. Its gross price-peak value was $2.904, final gross profit $2.185, commission $0.296 and net $1.889. About 0.028R of the displayed gap is the different risk denominator, 0.047R the intended trail distance, 0.070R the trail-level-to-fill difference, and 0.048R commission. The stop triggered at 0.09775 and filled at 0.09790 after 1.685 seconds; that fill improved on the triggering print. Filling at the theoretical stop of 0.098067 would invent a better price than the recorded execution.

The current trail activates at +0.5 price R and normally gives back 10% of the peak (8% above 2R, 6% above 4R, with a stall adjustment). A global change from 10% to 5% would save only 0.025 price R at a 0.5R peak **if** the tighter stop actually fills at that level. It cannot remove spread, price jumps or commission, and may close a trade before further gains.

### What to test next, in order

1. Record a separate executable net peak using timestamped depth, actual remaining quantity, banked partial P&L and applicable exit fees/funding. Label coverage gaps instead of treating candle highs as attainable liquidation value. Keep the trading peak/evidence identity unchanged for this observation metric.
2. Prioritize Trend Impulse's INIT/PARTI 15m executions. Compare its current exit against an earlier fee-covered lock and a modestly tighter trail, with the same causal stop-amendment delay and actual post-trigger depth. Use later dates as the holdout and report winners cut short, full stops avoided, net dollars and net R.
3. Treat the pre-trail losses separately: 14 of 74 paper stop losses in the last seven days had reached +0.3R but not +0.5R; none reached +0.5R. Tightening an already-active trail cannot rescue those. Earlier protection requires its own replay because good trades can also revisit those levels.
4. Compare native scanner targets/partial exits only with complete post-entry replay and the entry-time policy. Minute path samples and a first tape print are insufficient to establish an executable counterfactual.

No exit policy is deployed from this descriptive audit. Detailed aggregates, all scanner groups and ten audited trade decompositions are in `profit-capture-2026-11-17.json`.
