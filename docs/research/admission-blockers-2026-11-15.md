# Shadow admission and paper entry audit — 15 November 2026 IST

Read-only VM snapshot: 14 November, 19:14–19:18 UTC. Baseline code: `3e47b40`.
These are scanner/market/timeframe cells, not distinct pairs: the 1,432 passing
candidates cover 125 markets and 592 scanners.

## Why the passing candidates were outside shadow

| First applicable blocker | Cells |
| --- | ---: |
| Fresh, available and market-eligible, but no slot | 426 |
| Current market eligibility, including the shadow turnover floor | 821 |
| Outside the assessed market universe | 68 |
| Screen too old | 99 |
| Expired screen | 6 |
| Scanner unavailable/quarantined | 7 |
| Existing rotation cooldown | 5 |
| **Total** | **1,432** |

All 1,080 slots were occupied: 800 general, 80 major-market 4h and 200 other
4h reservations. Cached book-cost refusals are already removed when fresh-depth
checking is enabled; this audit used the actual admission logic, not raw cached labels.
Passing a historical screen does not bypass market checks or forward qualification.

## Confirmed fault and correction

Rotation checked for any fill since admission. A single old fill therefore protected
a cell forever from the configured idle-slot rotation, even after weeks of silence.
It now checks entries **and closes** during the existing 7/14/28-day windows.
A fresh successful scan is still required. Open/pending positions in either account
or shadow, proposed cells, recent restoration windows and qualified paper-copy
sources remain protected. The transaction rechecks activity and allocation before
committing the two moves and their audit record together.

History is retained; rotation is a capacity decision, not a failed performance
verdict. The existing 12-per-UTC-day rotation limit, three-day cooldown, capacity
reservations and per-scanner limits are unchanged. No quarantines are cleared.

## Current versus corrected replay

Both actual code versions ran `admitOnly` on separate copies of the same VM SQLite
snapshot, with the saved current policy per active cell and the same configuration.

| Result | Current | Corrected |
| --- | ---: | ---: |
| Newly admitted cells | 0 | 7 |
| Fresh candidates waiting for a slot | 426 | 419 |
| Rotation allowance used today | 5/12 | 12/12 |
| Active shadow capacity | 1,080 | 1,080 |
| Previously qualified paper-copy cells retained | 31 | 31 |

Admitted: MA Trend Ribbon, Double-Smoothed Momentum MAD Trend, Confirmed Close
MTPI Gold, Tradleware Gaussian Channel StochRSI BTC and SMA 4/SMA 30 on HUSD 1h;
Donchian Breakout with ATR Trailing Stop on HYPEUSD 1h; Adaptive Bounds RSI on
HYPEUSD 4h. These are research allocations, not paper promotions or profit claims.

Assertions verified that positions, orders, trade policies, evidence flags,
restoration records and the entire configuration were unchanged. No held position
was rotated, no capacity overflow occurred, and all 31 qualified copy sources stayed
in shadow. Prospective signals and outcomes must still establish profitability.

## Paper checks

31 shadow cells currently pass the existing copy-evidence rules. Their remaining
entry refusals include burst exposure, chop, cooldown, fees, allocation size and
existing positions. Twelve small-budget refusals involved AKEUSD, whose contract
represents 10,000 tokens; an indivisible contract must fit the pilot allocation and
stop-risk budget. This change does not round it up or increase its risk allowance.

Four unknown/stale product-status refusals predated the already deployed recovery
fix (`e8bf77f`, decision 263). Its regression tests confirm that valid paper receipts
wait, then recheck evidence, prices and risk within the original deadline, without
duplicate orders or invented downtime fills. Genuine halts still reject.

Two causal reversal cancellations were also observed. Waiting for an actual close
is already tested under versioned shadow experiments. Enabling that different
execution policy globally would need matching prospective evidence; this release
does not silently mix it into existing paper qualification.

The dashboard now identifies cells correctly, splits capacity waits from market,
screening and availability checks, and links to the incubator's candidate view.

## Validation

Regression coverage includes old fills releasing idle slots, recent closes and
boundary-time fills retaining slots, both books' open/pending positions, restoration
windows, paper-qualified sources, concurrent fills, transaction rollback, reserve
capacity, scanner caps, cooldowns, unavailable scanners and daily limits.
Validation passed: 1,464 server tests, 72 dashboard tests, server typecheck,
dashboard lint and production build. Paper mode, sizing configuration, all risk
caps and all evidence settings remain unchanged.
