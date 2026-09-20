# Paper calculation model

This is a linear-contract paper simulator, not an exchange margin calculator. Quantity is integer contracts; underlying quantity is contracts × contract value.

## Sizing and margin

Risk sizing budgets the expected loss at the stop, including adverse entry/stop slippage and both taker fees. Quantity is rounded down and capped by account notional exposure and available wallet cash. Quality sizing targets equity × selected leverage, subject to the same caps. Entry fees are reserved alongside initial margin.

`leverage` remains notional / account equity for account exposure. `marginLeverage` is the selected isolated leverage: maxLeverage in risk mode and the score-derived leverage in quality mode. Initial position margin is filled entry notional / marginLeverage. Existing margin is reserved before another entry, and unrealized gains do not create available wallet cash. Partial exits release margin proportionally; realized P&L and fees update the wallet. The position table shows isolated leverage.

Existing persisted positions retain their historical leverage, margin assumptions, and liquidation levels. New entries use the corrected model. Simulation cache version 4 forces historical simulations and ML models to rebuild.

## Liquidation

For the simplified fixed maintenance-on-entry-notional model, with entry E, isolated leverage L and maintenance fraction m:

- Long trigger: E × (1 − 1/L + m).
- Short trigger: E × (1 + 1/L − m).
- A nonpositive long trigger is unreachable and represented as null.
- New positions require initial margin fraction 1/L > m.

The first adverse threshold is evaluated before profit targets. When a liquidation threshold is crossed, the entire remainder closes, including when the crossing is observed in a script exit. Modeled liquidation slippage is bounded by bankruptcy price; liquidation exit fees are capped at the remaining allocated margin. Entry fees were charged separately at entry.

These are approximations. Delta uses mark-price triggers, contract-specific maintenance tiers, liquidation charges, netting and possible incremental liquidation. This application uses candle prices, a configured fixed maintenance rate and full liquidation. Funding, taxes and exchange liquidation charges are not modeled. A candle gap cannot establish the exact order or executable price of stop and liquidation triggers.

References: [Delta isolated margin](https://guides.delta.exchange/delta-exchange-india-user-guide/trading-guide/margin-explainer/margin-explainer), [Delta liquidation process](https://www.delta.exchange/support/solutions?articleId=80001199739).

## P&L, fees and statistics

Gross P&L = (exit − filled entry) × underlying quantity for longs, with reversed sign for shorts. Net P&L subtracts the entry fee once and each exit fee. Resting TP fills use maker fees; stop, reversal and liquidation fills use taker fees. Break-even moves the stop to filled entry, so fees and slippage can still produce a net loss. R-multiple divides net P&L by the initial expected stop-loss budget.

SL and TP levels must remain positive and on the correct side after tick rounding. Zero-quantity target allocations neither fill nor activate break-even. Backtests ignore exits explicitly addressed to the opposite side.

Statistics are based on closed trades. Reported maximum drawdown is closed-trade equity drawdown, not full intratrade drawdown; backtest equity curves likewise omit open-position unrealized swings. Trade pnlPct is return on original notional, not return on margin. These definitions should be considered when comparing results to exchange reports.

A TP touch followed by a close beyond a newly raised break-even stop closes the remainder on that candle. Rounded targets retain their original TP indices even when their prices coincide. Removed scanners restored after restart wait for a valid quote before closing; open-position symbols remain subscribed even outside the active scanner universe.
