# Paper qualification audit — 14 November 2026

Verified from a read-only VM snapshot at 17:21:18 UTC, running 7af7855. Trade activity was checked again at 17:23:22 UTC. No exchange orders, credentials or account eligibility claims were involved.

## What zero means

Full promotion: **0 of 1,080 shadow cells**. Paper copying: **28 cells pass the existing compatible-evidence and turnover checks**. These are distinct paths; copying still needs a fresh signal and all execution, liquidity, capacity and risk checks. All 28 cells had recent successful scans. In the trailing 24 hours the account recorded 27 entry signals with action `opened`, plus resting-limit orders. These are entry actions, not a claim about profitable closed trades.

| Shadow copy assessment | Cells |
|---|---:|
| Pass existing evidence / turnover checks | 28 |
| Too few compatible closes or nonpositive net R | 1,009 |
| Prospective restoration evaluation incomplete | 32 |
| Below the existing turnover minimum | 11 |

497 cells have at least one qualifying closed trade under the current policy. Historical trade counts are much larger because they include old execution models, changed fees and excluded observations. The new causal stop-fill model cannot inherit the older optimistic model's evidence. Most restored windows are only about four days old; their frozen sample, age, profitability and stress requirements still apply.

Examples of genuine promotion failures: Woodie Pivots / BTW 15m has 79 matching closes but only PF 1.15 and 0.05R per trade; Fisher Transform / AIOT 15m has 43 closes and −4.52R. These are not candidates for relaxed gates.

## Confirmed defect and correction

Promotion reads current-policy evidence. For cells without a restoration enrollment, retirement instead read the raw shadow journal. Consequently old-policy losses could terminate a new positive sample; old-policy wins could also protect a losing current sample. Tracker/adopted observations could enter this retirement calculation too.

Performance retirement now uses the existing exact-policy evidence reader, including all eligible current losses. An incomplete restoration still supplies its negative forward results for retirement, while remaining blocked from promotion and copying. Missing runtime policy cannot certify performance evidence. Explicit offline historical research remains available.

Inactivity remains a separate activity check with its existing deadlines; changing an execution version does not make a recently traded cell suddenly silent. Restoration inactivity retains its frozen forward window.

## Historical replay

Reviewed all 107 retirements in the preceding seven days. For 26 failed-screen retirements with current-policy observations, 24 would have remained collecting evidence under the corrected calculation; 2 still satisfy the unchanged retirement condition. Of the 24 preserved samples, eight were positive:

| Scanner / market / TF | Current-policy closes | Net R at retirement |
|---|---:|---:|
| EDO Breaker Blocks / ETH / 4h | 1 | +0.426 |
| QQE Trend Strategy / ETH / 4h | 2 | +0.878 |
| Serhan WMA RSI / AVAX / 4h | 1 | +0.340 |
| Tradleware DCA Trend ETF / ETH / 4h | 1 | +0.414 |
| Linear Regression Channel / SOL / 4h | 2 | +0.837 |
| VWAP SD2 Reversion Long / ARIA / 1h | 3 | +0.996 |
| Continuation / H / 1h | 2 | +0.879 |
| Delta Absorption / ETH / 4h | 1 | +0.413 |

This is an as-of eligibility replay using recorded fills and matching current identities, not a profit backtest. It establishes premature termination of evidence collection, not subsequent returns. The other preserved samples are also retained: the correction does not select only winners. No missing post-retirement trades are invented, and no retired cells are force-promoted or restored over research capacity/admission rules. Previously retired cells require a fresh passing screen and an available shadow slot.

## Entry blocks

The 14 trailing-day `risk budget too small for one contract` refusals were on AKEUSD. Its contract value is 10,000 units. With its wide stop, one contract exceeded the reduced pilot stop-risk budget; rounding up would raise risk. Burst, same-market occupancy, cooldown and market-depth refusals remain intact. No new profit-factor claim is justified by removing them.

## UI and verification

The Incubator now distinguishes paper-copy candidates from full promotion. Shadow progress and PF use the gate's evaluated sample instead of the all-time mixed journal. Copy-status reads cannot enroll or modify a restoration test. The VM read-only benchmark for checking all 1,080 copy candidates was 1.89 seconds.

Regression tests first reproduced four failures in the old retirement logic. Tests cover positive/negative policy mixing, excluded observations, inactivity, missing provenance, and read-only copy status. All promotion, fee, sizing, source/reader and risk identities remain unchanged. Paper mode, $150 margin, 3% stop-risk cap, and all other current risk/evidence settings remain unchanged.

Raw audit artifacts are stored in the task workspace under `work/promotion-blockers-20261114`: `diagnostic.json`, `retirement-replay.json`, `gated-budget.json`, and test/deployment logs. None of the raw database exports is committed.

