# Paper and shadow performance

The Performance page (`/analytics`, previously Analytics) compares closed paper and shadow trades using the same UTC closing window, market, timeframe, scanner, direction and exit filter. It defaults to seven UTC calendar days including the partial current day. Filters persist in the URL and are applied before aggregation; there is no trade-count cap. Open positions and backtests are excluded.

The read-only endpoint is `GET /api/analytics/performance`. Paper is book 0, shadow is book 2. Only shadow excludes cells currently marked `tracked`, as Daily intends. Daily now retains all paper closes even when their cell is tracked, so account results continue to reconcile to the journal.

Metric definitions:

- Net USD = stored realized P&L − commission. Stored realized P&L already includes funding.
- Funding = signed funding fill P&L. Trading P&L = stored realized P&L − funding. Thus trading P&L − commission + funding = net.
- Net R = net USD / the trade's initial risk amount. Average R and average commission R use trades with positive, finite risk and finite R only; missing-risk counts are visible.
- Win rate uses positive net USD, including every matching close. SL rate counts `exit_reason='sl'`; trails and break-even exits are separate.
- Profit factor is positive net USD / absolute negative net USD. Positive-only samples display “No losses”; empty samples display a dash.
- Malformed funding details do not alter net accounting. They suppress the incomplete funding/trading decomposition and show the missing-detail count.

Shadow positions use independent simulation sizing. Their dollar totals are not account returns or an equal-capital comparison. R/trade and commission R/trade support a sizing-normalized comparison, but the books still have different populations and execution policies. This view is descriptive, not a paired experiment or promotion rule.

Daily bars show UTC days with closes; a book with no closes on a day has null average R, not a fabricated zero. The chart can switch to close counts and exposes an accessible daily table. Group breakdowns support timeframe, market, scanner and exit, with clickable filters and mobile cards. The Paper journal link carries the same selection.

Advanced Learning and Allocation remain available on demand with an explicit separate-window notice. They are not affected by the comparison filters; Learning retains its existing 5,000 paper / 20,000 shadow limits and 30-day shadow window.

Validation: tests cover time boundaries, book/filter isolation, complete history beyond 5,000 trades, funding reconciliation, group totals, tracker isolation, missing risk/funding detail, empty samples, and no-loss profit factors. Before deployment, the read-only VM query reconciled all 625 paper closes, $228.47803472898116 net and $416.3667879709713 commission to independent SQLite aggregates; all-history aggregation took about 160 ms.
