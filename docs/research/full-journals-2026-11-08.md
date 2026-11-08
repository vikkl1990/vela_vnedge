# Full paper and shadow journals

Implemented 8 November 2026 in the existing `/trades` page, now labelled **Journals**. This is a read model over the retained bot ledger; it does not change trading, sizing, fees, scanners or exchange execution.

## Coverage and controls

- Separate paper and shadow books, with current-period, pre-reset archive and combined history filters.
- Closed, open, pending, voided and surviving cancelled-order records. Open/pending records never contribute to closed profit; archived open states are not current exposure.
- Filter by market, scanner, timeframe, direction, exit reason, evidence scope and UTC entry/exit dates. Global sorting and totals apply before pagination.
- Every matching trade and recorded fill can be exported to CSV, without the former page/200-fill cap. Exports preserve numeric precision and neutralize spreadsheet formulas in text fields.
- Trade details show entry signal, original and final SL, targets, original dollar risk, notional, recorded margin leverage, derived margin, costs, funding, net R, excursions, ML entry probability, frozen policy, decision timeline, order pricing provenance and retained path replay.
- The same authenticated API protects list, detail and export. Detail requests cannot cross books.

## Accounting and history

`realized_pnl` already contains recorded funding. Closed net is `realized_pnl - fees`; gross trading is `realized_pnl - recorded funding`. Commission is the recorded cash fee, not an invented pre-offer gross fee. No voucher benefit is credited as trading profit.

Unknown historical fields remain unknown. Deleted pending orders can only be represented from surviving cancellation events; their placement prices and sizing cannot be recovered. History erased by older software cannot be recreated. Reset archives retained in books -1/-3 remain accessible; order fills follow their archived book while decision traces retain their original book.

Shadow dollars are synthetic and depend on historical sizing. All-record shadow totals include watch-only and plan comparisons. The **Performance / incubator evidence** filter uses frozen evidence scope and matches Performance/Daily's evidence population for the current period. Do not compare unrestricted shadow dollars directly to paper capital.

## Snapshot reconciliation

Read-only VM snapshot completed **2026-11-08 07:02:46 UTC**. An isolated copy received journal indexes for validation; no bot state or configuration was edited.

| Book | Total retained journal records | Closed | Open | Pending | Surviving cancellations | Archived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Paper | 936 | 905 | 4 | 0 | 27 | 80 |
| Shadow | 11,274 | 10,504 | 124 | 3 | 643 | 0 |

Record counts and closed net independently reconcile to SQL on the snapshot. Four complete exports and a timestamped summary are saved in the task workspace under `work/full-journals-20261108/`. Paper current-period closed count is 825; the remaining 80 closed paper trades precede resets.

## Validation

- 1,012 server tests passed, including book isolation, accounting decomposition, archives, cancellation reconstruction, malformed filters, CSV escaping and exports exceeding 5,000 positions / 200 fills.
- Seven dashboard tests passed; server TypeScript, dashboard lint and production build passed.
- Authenticated HTTP integration tests cover list/detail/export and unauthenticated rejection.
- UI rendered against captured VM rows in an isolated preview: paper/shadow switching, a real trade detail and a 390-pixel viewport. The preview has no execution connection. Live browser session requires sign-in, so this is not claimed as authenticated production-browser validation.

Paper mode, production execution disabled, $150 base margin, 3% stop-risk cap and configured 6× fee-risk policy remain unchanged.
