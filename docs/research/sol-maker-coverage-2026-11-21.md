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
- Add one current-exit SOL maker reference, sharing the existing source event. Fresh crossing prints must fill its resting limit. Half-stop/base/stress observations are independent hypothetical records, never orders or promotion evidence.

Validation and deployment receipts are retained under `work/sol-replay-coverage-20261121-data` in the task workspace. The study continues prospectively; paper adoption still requires positive net improvement, fewer SLs, acceptable winner damage and the existing evidence rules.
