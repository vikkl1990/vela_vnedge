# Paper journal accuracy — 21 November 2026

Read-only snapshot: **13:34:51 UTC / 19:04:51 IST**. VM baseline: `893e884`. No trade was inserted, repriced or removed.

| Selected history | Closed trades | Recorded net USD |
| --- | ---: | ---: |
| Current account period | 1,424 | +116.25 |
| Before account resets | 80 | −134.52 |
| Current and archived | 1,504 | −18.27 |

All 1,504 closed records reconcile between positions, embedded fills and orders: quantities, remaining exposure, commissions, realized P&L, funding, entry VWAP, books and timestamps. Signal timestamps do not precede their closed bars, and fills do not precede their signals. API counts and totals match the database snapshot. This checks retained bookkeeping, not exchange executability or missing historical observations.

The former date filter said **All history**, although it excluded account-reset archives unless the hidden history filter was changed. It now says **All dates**, with history scope always visible. The current account remains the default; archive totals are not added to account equity.

**173 current-period positions, including open positions, used candle-model maker entries.** Other current receipts are 644 quote and 613 depth models. Each journal row now identifies its entry source. Public prints and candle touches cannot prove queue priority, so none is relabeled as an exchange execution.

**Recorded peak R is not a consistent net profit measure.** `trailStop` can store favorable price movement divided by original price-stop distance; `recordPath` can store marked P&L with booked costs divided by dollar risk. Both update the same retained peak field. It therefore cannot establish the percentage of executable net profit retained. The UI names and explains this limitation. A future net peak needs a separate versioned, timestamped close-now calculation with executable depth and exit fees; old peaks must not be silently reconstructed from candles.

Four historical paper entries have zero-volume candle receipts. This is a prompt to audit tape coverage, not proof all four are fictitious: ZEC #21176 has fresh post-arrival crossing prints before its candle receipt. The other examples lack adequate retained tape evidence in the audited export. Their original values are preserved.

Coverage verification found a concrete cause for missing MUSD research data: three validators required at least two characters before USD. MUSD is listed as MemeCore Perpetual, but its research depth and replay subscriptions were silently omitted. The validators now accept one-character bases, with regression tests for MUSD/SUSD and invalid symbols. Capture resumes prospectively; missing historical MUSD depth remains unknown.

The maker-model study compares 12 existing cells across BTC, ETH, SOL, XRP, BNB, ZEC, UNI, LINK, DOGE and M. Each has a current-model control and tick/depth-v2 candidate, identical scanner reading, entry policy, exits, full research fees, sizing and risk ceiling. These are independent simulated purses. Review all signals, missed fills, unresolved trades and full-cohort net alongside matched closed outcomes; a favorable matched subset is not promotion evidence. Paper fill policy stays unchanged.

Machine-readable snapshot: [paper-journal-audit-2026-11-21.json](paper-journal-audit-2026-11-21.json).
