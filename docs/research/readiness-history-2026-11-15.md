# Readiness history: explain exclusions and prove unchanged sizing

Verified from the VM journal at **2026-11-15 15:00:36 UTC**, running `e3ef8df19461f9074b82b8a3fb6f8f6a86d627cc`. This is an account-readiness audit, not a profitability optimization or a paper-admission change.

## Why only 15 counted

The journal contained 1,091 closed paper/account trades, of which 1,041 closed in the 30-day readiness window. There were also 16,000 closed shadow rows; those are a separate research population and cannot establish account readiness.

| Paper history after the correction | Trades | Treatment |
| --- | ---: | --- |
| Exact current policy | 1 | Count |
| Identical policy except expanded global count ceilings | 14 | Count, as introduced by decision 272 |
| Same-size replay under removal of drawdown sizing | 9 | Newly count, including one losing trade |
| No bound execution policy | 744 | Exclude: archived configuration fingerprints do not establish the complete trade policy |
| Original policy unknown at adoption | 2 | Exclude |
| Execution model 210 rather than current 211 | 163 | Exclude: older stop fills are not current causal execution |
| Insufficient entry data for same-size proof | 57 | Exclude; no assumed quote, depth, allocation fraction or fill |
| Size equivalence not established | 51 | Exclude; do not scale old profits to a new quantity |
| Outside the 30-day window | 50 | Exclude from this window |
| **Total paper history** | **1,091** | **24 qualify, up from 15** |

The 744 unbound rows' configuration fingerprints contain either no simulation version (418 rows) or older versions 190–209 (326). They cannot be retrospectively labelled as current execution. All 117 otherwise compatible version-211 trades with the previous drawdown schedule entered below initial capital, so simply asserting that the schedule was inactive would be incorrect.

## The narrow correction

Preserve the original full policy ID, fills, fees, risk amount and profit. Validate both complete policy hashes and source provenance. Require the same source, reader, resolved execution, fee/offer model, capital, stop, risk caps, gates and every other policy setting. Permit only the already supported expansion of global count ceilings, removal of maker-cell settings belonging to unrelated cells, and removal of the capital-based drawdown sizing schedule with a separate per-trade proof.

The sizing proof is restricted to simulation version 211, closed ordinary account trades with one full taker entry priced from recorded depth. Match the entry to its saved order, timestamp, fresh bid/ask quote, depth snapshot and version-3 admission trace. Recompute book VWAP and the engine's conservative worse-of-quote-and-VWAP entry price. Validate entry fees, the saved allocation fraction, contract specification, leverage, stop and total closed quantity.

Replay the previous and current sizing functions across every configured leverage tier and drawdown multiplier at the recorded admission quote, fill quote and depth price. Require unchanged contract quantity, isolated leverage and modeled stop risk. The exchange leverage ceiling must already bind below both configured ceilings. At or below initial capital, stop-risk sizing and integer rounding must dominate the old reduced margin; above initial capital the old capital-based schedule applies factor one. Recover the actual sizing equity from the saved effective leverage, and reproduce the recorded quantity and risk at that equity. No estimated equity or reconstructed book is accepted. A wallet/reservation-constrained fill that cannot be reproduced at the full requested allocation is excluded conservatively.

This restores IDs 17157, 17163, 17749, 18117, 18215, 18487, **18545 (loss)**, 18562 and 18659. The selection never consults P&L. The same journal outcomes feed readiness; there are no hypothetical larger profits, extra trades or claims about higher-concurrency portfolio performance.

## User-visible accounting

Live control identifies exact, capacity-compatible and same-size replay trades. Incubator → Operations → Evidence details shows all-time paper closes, closes outside the window and mutually exclusive reasons for every excluded row. Missing execution provenance is distinguishable from incompatible execution or insufficient sizing evidence.

## Validation and limits

- 1,536 server tests pass, including 16 sizing-proof tests: valid loss inclusion, pilot fractions, quote/depth pricing, changed quantity, unknown or stale evidence, mismatched fees/orders, partial entries, changed risk, changed portfolio leverage ceilings and experimental scope.
- A sizing grid checks old/new equality across account equity, wallet availability, existing exposure, adverse prices and leverage tiers.
- Server typecheck, dashboard lint/build and four rendered desktop/phone readiness tests pass.
- The recorded-data audit independently reproduces all 15 previously accepted trades and exactly nine additional trades. The 50 out-of-window rows are counted from the VM; the in-memory replay contains only the 1,041 window rows.

No configuration migration or journal mutation is required. Paper mode, $150 margin, stop and portfolio risk caps, the 200-trade readiness minimum, other readiness checks, copying/promotion/leverage rules and all shadow experiment policies remain unchanged. This proof does not repair missing historical evidence and does not validate exchange order lifecycle behavior.
