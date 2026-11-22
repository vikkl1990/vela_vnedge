# Paper-copy funnel and quote continuity — 16 November 2026

Read-only VM audit, captured at 17:08:42 UTC. Baseline `d861858`; paper mode, $150 configured margin, risk caps and evidence rules unchanged. This follow-up freezes the same 57 cells inspected for decision 288, rather than selecting only later winners.

## Why only ten cells had fills

The original count covered 15 November 16:27:26 UTC through 16 November 16:27:26 UTC. The lower turnover floor went live at 16:09:34 UTC, only 18 minutes before that snapshot. Eligibility at the end of the window does not mean every cell was eligible throughout it.

| Outcome in that window | Cells |
| --- | ---: |
| At least one new paper fill | 10 |
| Paper entry decisions, no new fill | 16 |
| Shadow entry events, no paper entry decision | 17 |
| No shadow entry events | 14 |

The 17 cells with shadow events but no paper attempt have recorded copy refusals: the former $2M floor, insufficient qualified closes at the time, or non-positive qualified R at the time. Their current eligibility must not be used to backdate paper fills. The 14 silent cells had successful scans, but no entry event in this window; scanning does not guarantee a fresh signal.

Across all 57 cells there were 74 paper entry decisions: 19 fills; 19 same-symbol capacity refusals; 11 chop refusals; 7 depth-cost refusals; 6 burst refusals; 6 already-held outcomes; 3 native-stop-policy refusals; 2 cooldown refusals; and one stale-depth refusal. The stale-depth pending-order defect was fixed in decision 288. The other policies are unchanged. In particular, converting native stops to ATR stops would need a separately evaluated execution policy.

The cell-by-cell classification is in `cells.json`. Counts are historical, not a limit on how many cells can participate.

## Forward observations

Between the floor change and 17:08:42 UTC, two additional cells filled in paper:

- Scalping Ichimoku / AINUSD / 15m: position 20101, entered 16:45:08 UTC and stopped at 17:00:20 UTC.
- Twiggs Money Flow / ARIAUSD / 1h: position 20106, entered 17:03:43 UTC and still open at the snapshot.

That is 12 distinct participating cells across the combined observation windows. The new AIN fill lost; increased participation is not proof of improved profitability.

## Confirmed execution gap and correction

Entry processing already fetches REST depth before admission. However, the executable bid/ask used by the paper engine came only from the separate quote store. When the streaming ticker/L1 channel was quiet, a freshly fetched book could coexist with a `no executable bid/ask` refusal.

Publish the top bid/ask of that existing REST response to the quote store in paper mode only. Require a valid timestamp, current exchange time, nonempty sides, finite positive prices and sizes, and an uncrossed book. Preserve both exchange and local receipt times. Keep healthy WebSocket L1 quotes ahead of the REST fallback. There are no extra API requests and no events emitted to manufacture fills.

Actual-sized depth, complete depth coverage, fees, cost ceilings, risk limits, signal expiry, pending-order timing, evidence identity and scanner contracts still run unchanged. Failed or stale depth never creates a usable fallback quote. The fallback can expire normally; a later read does not rejuvenate its timestamp.

At the 17:00 close SOPH and BTW each had a paper quote refusal. Their subsequent shadow depth checks also exceeded the cost ceiling (approximately 0.318% and 0.314%, versus 0.25%). This correction therefore does **not** claim that those specific signals would have filled or made money. It removes an inconsistent data dependency; it does not waive their economic checks.

## UI correction and validation

Asset-class breakdowns gave the net-dollar column a fixed width of 72 px, clipping large research balances. Shared intrinsic grid columns now fit complete amounts, and phone rows stack the class above R and net dollars. No balances are rounded, abbreviated or changed.

- The new browser regression fails on the original CSS at desktop and phone widths, then passes with the correction; measured at 1440, 1024, 900 and 375 px.
- The quote regression fails on the original implementation, then passes with the correction. Tests cover expiry, stale/future/missing timestamps, empty/crossed/malformed books, L1 precedence, costs and risk refusals.
- Full validation and deployment results are recorded in the pull request.

No configuration mutation, replayed paper entries, forced signals, cap changes or evidence relaxation is included.
