# SOL maker replay coverage and half-stop decision — 21 November 2026

Decision: deploy tested collection/scheduling fixes and one isolated shadow reference; **do not activate the half-stop in paper**.

The fresh VM export at 02:47 UTC includes two closed SOL maker account references since the half-stop study began. There are no regular SOL maker shadow references. The other two new study references (SuperTrend/AAVE and AI Flow/LINK) remain open and are not closed-trade profit evidence.

| Reference | Current net | Live half-stop | Live stress | Evidence |
|---|---:|---:|---:|---|
| SOL #23509 | -$8.59 | -$3.89 | -$4.94 | One recorded prospective comparison, still a losing trade |
| SOL #23828 | -$10.72 | Unavailable | Unavailable | 22.7-second observer interval, exceeding unchanged 15-second continuity bound |

The audit exported 58,653 events in 111 checksum-verified segments; no selected segment file was missing. This is not a claim of continuous execution coverage. Two backward envelope times come from old pre-upgrade exit-depth receipts; the replay invalidates cached data at those boundaries. #23509 predates the deployed observation-sample capture, so its live persisted advisory record and a modeled-clock replay are distinguished. #23828 has exact archived observer timestamps and remains unavailable. The current-exit replay reproduced its actual net result exactly; that does not repair missing hypothetical observations.

A naïve reconstructed five-second clock would report both trades covered and a $9.00 improvement. That claim is rejected because it invents observation opportunities during the recorded pause. Respecting the gap leaves only the earlier case. There are no new covered winning SOL trades to establish winners cut short. No tuning thresholds, evidence windows, risk limits or historical fills were changed.

Implementation:

- Keep SOL in focused retention before entry, within the existing 4 GiB / 21-day target and disk reserve.
- Keep retained symbols on their current depth socket. New markets no longer invalidate unrelated healthy books.
- Capture the next verified checkpoint when a symbol joins focused retention, and record advisory REST exit books and quote invalidations.
- Yield between evidence-review cells/cohorts instead of blocking quote/exit/observer timers for a full review. Identical synchronous/cooperative verdicts and state transitions are regression tested; configuration changes abort the review.
- Add one current-exit SOL maker reference, sharing the existing source event and current resting-limit model. Half-stop/base/stress observations are independent hypothetical records, never orders or promotion evidence. Entry execution labels remain explicit: a candle-model fill is not a verified exchange queue fill.

Validation and deployment receipts are retained under `work/sol-replay-coverage-20261121-data` in the task workspace. The study continues prospectively; paper adoption still requires positive net improvement, fewer SLs, acceptable winner damage and the existing evidence rules.

## Live verification and follow-up

Main `9fcbc4d` was deployed at 03:38 UTC. The reference received a fresh entry signal at 03:45:54 and a maker fill at 03:46:00 (position #24176). It closed by the current trail at 03:49:48 for **+$3.94249 net**, with $0.60381 in fees. The continuously observed half-stop cohort finished `unchanged`: no trigger and no winner cut. This research-policy result is separate from the earlier account-policy loss; it is not pooled promotion evidence.

Replaying 6,345 recorded events from 13 checksum-verified focused segments reproduced the unchanged half-stop outcome at the actual observation timestamps, with no missing files or backward event times. The entry receipt is `limit-candle-model` and has no exact entry depth. The tape crossed the limit just before the modeled fill, but that print's quantity was only 1 against the reference's 11; a larger crossing print arrived 251 ms afterward. This confirms price movement, not queue priority or full-size fill parity. Keep this conditional exit comparison separate from execution-accuracy proof; no paper promotion follows from it.

The 04:00 source scan expired in the background queue while the account scanner completed in 2.9 seconds. The 04:15 source scan subsequently completed at 04:16:14 with zero entries. The follow-up gives this exact reference an existing bounded timely-research turn; it does not occupy reserved account workers, run ahead of queued account/mirror work, or extend signal validity.

Post-deploy capture included a 27.7-second observer interval at the 04:00 close. Bar-close copy qualification was another synchronous loop, separate from the full evidence review fixed above. It now yields between cells, preserves qualification rules and rechecks admission at entry. Stopping during qualification releases the scheduled work. This addresses a remaining stall source; historical gaps remain excluded, and complete runtime coverage is not assumed.
