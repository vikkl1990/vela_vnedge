# Readiness history recovery — 22 November 2026

The displayed 131 was one current-policy trade plus 130 historical trades proven execution-equivalent across versions 211 and 212. It was not the total trade count; no history was deleted. This audit uses the read-only VM snapshot at 2026-11-22 13:31:44 UTC, archived received events, and independently recorded funding settlements.

## Reconciliation

Of 1,477 closed account trades, 1,068 closed in the rolling 30-day window; 409 were outside it. Before this extension, 937 in-window trades were excluded. All 517 version-211 trades were checked: 402 had compatible policy/sizing and 115 did not. The 402 were replayed against both engines using the original entry and original received tick/mark/candle callbacks. Saved depth was reusable only with the identical exit trigger, arrival, quantity and reason.

| Frozen snapshot after replay | Trades |
| --- | ---: |
| Current policy | 1 |
| Verified equivalent 211 executions | 186 |
| **Qualifying total** | **187** |
| Missing bound historical policy | 385 |
| Adopted policy, original unknown | 2 |
| Old 210 execution | 165 |
| Other policy/sizing differences among 211 | 113 |
| Replay lacks complete capture of holding interval | 100 |
| Archive/process gap | 52 |
| Capture selection changed | 15 |
| Unsupported reversal/script/partial lifecycle | 25 |
| Engine change alters exit | 20 |
| Ambiguous entry ordering | 2 |
| Original ledger not reproduced | 1 |
| Missing pre-entry tape/quiet-capture proof | 1 |
| **Total in window** | **1,068** |

Policy differences total 113 after separating two adopted-policy rows. The expanded replay admits 56 more trades: 28 via quiet capture, 19 via funding, and 9 via both. All previous 130 matches survive. Added history spans 30 scanners and 20 markets, contains 36 winners and 20 losers, and nets **−$92.26**. All 186 replay matches together net +$44.07. These are historical outcomes, not profit improvements.

Remaining sizing differences were traced through the existing same-size proof. Some produce different quantities under the removed drawdown scaling; others lack exact depth/admission evidence or are maker fills. Fill-time leverage does not record admission equity and cannot reconstruct the admission budget. Missing inputs and changed size were not treated as compatible.

## Corrections and boundaries

- Funding is validated against its order, mark, rate, timing and cash flow. Missing/unresolved provenance refuses proof and changes invalidate the receipt hash.
- A verified quiet interval can establish inactive tape without a made-up tick. It requires selected capture, a prior observed mark, and enough time to expire fallback liveness and accepted trade-clock uncertainty.
- The symbol's exported window must cover the whole holding interval and preroll. Global archive coverage alone is insufficient.
- Existing version-2 receipts stay valid for unchanged no-funding subjects. Both engines must reproduce original fills/net outcomes across every plausible entry-millisecond boundary.
- Replays write separate audit receipts only. Positions, fills, P&L and policies stay untouched. Paper mode, risk settings, the 200-trade threshold, copying and promotion rules stay unchanged.

## Validation

Regression coverage includes long/short funding, late reconciliation, changed exits, invalid/stale/missing/unresolved settlements, quiet capture, wrong/truncated symbol windows and preservation of existing receipts. Full server tests and an independent ARM VM replay are required before deployment. Final live counts and runtime verification are saved in deployment artifacts; the table above stays frozen so rolling-window movement cannot obscure reconciliation.

This recovery does not establish live readiness. Other readiness tests must pass using the larger sample.
