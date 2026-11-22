# Scanner attention audit — 16 November 2026

Read-only VM audit at main `160c25d`. Current-evidence recheck: 17:46:50 UTC / 23:16:50 IST.
The screenshot contains eleven review rows, not eleven proven execution failures.
Entry counts below are retained seven-day account entry decisions; shadow observations are a different stream.

| Scanner | Historical account entry outcomes | Current status |
| --- | --- | --- |
| ICHIMOKU Crypto Swing Alert | 4 attempts: 2 burst, 1 symbol capacity, 1 chop | AIN 1h is in restored forward evaluation; 5/20 trades and 5.9/28 days, negative return. |
| Slope & MA Cross + Acc + Range Filter | 7: 4 native-stop policy, 1 burst, 1 symbol capacity, 1 chop | ZEC 1h currently passes copy checks: 7 qualified closes, approximately +0.09R total. Historical refusals are not a current blanket block. |
| Alphamojo | No account attempts in the retained window | Four ordinary shadow cells plus 34 watch-only trackers. TIA 15m has 2/5 qualified closes; AIN 1h 1/5; ETH/SOL 4h 0/5. Direct paper allocation is not necessary for qualified copying. SOL's latest 4h scan expired; the previous close scanned successfully. |
| Adaptive Multi-Facto (9 years) | 3: 2 chop, 1 burst | XRP and SKYAI 1h have 6 and 11 qualified closes, but negative total net R. |
| PSOL 01 Donchian Channels | 3: 2 native-stop policy, 1 stale depth | Four ordinary shadow cells; no compatible qualified closes yet. Stale-depth recovery was already addressed in PR #63. |
| Quant Synthesis Strategy | 3: 1 symbol capacity, 1 burst, 1 chop | Three of four shadow cells currently pass copying: SOL 15m, ETH 1h, SOL 1h. FIL 15m has no qualified closes. |
| Amit Eth Strategy, two imports | Each: 3 attempts, one each burst, daily-loss halt and chop | Distinct IDs, identical source hash `86dcef8116ce`, different publication URLs. Both restored AIOT 15m cells are below their forward-evidence requirements with negative returns. Keep identities and trade histories separate. |
| RSI Volume Ladder | No account attempts in the retained window | 32 watch-only cells, one shadow-admission candidate, no ordinary shadow cells. Watch-only observations deliberately do not qualify for promotion. |
| Strategy 461 – TS M15 | 5 native-stop policy refusals | Two shadow cells, no qualified closes. |
| Value Migration | 3: 2 symbol capacity, 1 burst | Five shadow cells, each only 1–2 qualified closes. “Other” hid the actual reason. |

## Corrections

- Replace “Worth acting on” with “Setup and entry reviews”; distinguish historical outcomes from current copy eligibility.
- Preserve exact refusal reason, market, timeframe, frequency and most recent timestamp. Send at most three leading reason groups per scanner without truncating funnel counts.
- Show current paper-copy eligibility using the existing read-only evidence evaluator. No new admission criterion, exception or enrollment side effect.
- Distinguish enabled-but-shadow-allocated scanners from watch-only trackers and genuinely unallocated scanners. The scanner detail warning uses actual scheduled cells, including explicit pair assignments.
- Disambiguate same-name imports using scanner IDs in this panel, as elsewhere. Do not merge duplicate evidence or mutate allocations.
- Link entry reviews to filtered Signals and evidence reviews to the relevant Incubator scanner.

The new read-only index evaluated 27 ordinary shadow cells across 11 selected scanners in 90 ms on the VM, including 3.8 ms for the seven-day funnel. It does not run on every cell in the library. A failed eligibility check is reported as unverified rather than breaking the scanner list or treating a cell as eligible.

## Validation and limits

Regression tests cover refusal grouping and timestamps; pending versus filled orders; read-only copy evaluation; exclusion of watch-only, retired and account cells; separate scanner identities; unavailable evidence; and desktop/375px layouts with direct links.
The full server suite, dashboard lint/typecheck/build, pure UI tests and rendered browser suite are required before release.

No execution or profitability improvement is claimed. Native-stop, chop, symbol capacity, daily loss and restored-evidence refusals cannot be removed merely to clear an amber row. Any native-stop-policy experiment requires a separate, versioned shadow comparison. Paper mode, margin, risk settings and evidence requirements remain unchanged.
