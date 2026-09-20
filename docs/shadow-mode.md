# Live Delta shadow mode

Shadow mode observes scanner signals against Delta India production **public** bid/ask quotes. It requires no API key and places no orders. Fills, fees, P&L and liquidation remain hypothetical.

After deploying this change, select **Settings → Execution mode → Shadow — live Delta bid/ask, no orders**, then save. Close existing positions in their current mode first. Existing trade history is preserved and rows identify their execution mode; legacy records are labelled paper. Historical statistics can therefore include earlier paper results. No running process or saved configuration is changed by this PR.

## Execution rules

- Long entries use ask; short entries use bid. Exits sell at bid or buy at ask. Historical alert prices are not used as fill prices.
- Quotes must have valid, noncrossed bid/ask, a positive mark price and an exchange timestamp within 10 seconds (at most 1 second ahead). A disconnect clears cached quotes. Missing/stale quotes block entries and exits, including manual closes, until valid data arrives.
- Signals must refer to a closed bar no more than 30 seconds old. Pending scanner jobs cannot execute across a mode change. Stop/target levels already crossed by the current entry quote cause rejection.
- Live quotes drive stop/target checks. Candle highs/lows never execute shadow positions. Multiple observed TP legs fill at the current executable quote. TP and other exits use configured taker fees; artificial slippage is disabled because bid/ask already includes spread.
- Exchange mark prices value unrealized P&L and trigger the **modelled** liquidation threshold. Exit valuation uses the observed bid/ask, including gaps; hypothetical losses are not capped at a theoretical liquidation fill price. This is not a replica of Delta's liquidation engine.
- Script exit signals use current bid/ask for every closed leg. Removing a scanner stops entries while existing exposure remains managed by its levels, matching current paper-mode behavior.
- Open positions retain their execution mode on restart. Quotes are never restored from disk. Starting in an incompatible mode with open positions fails explicitly.

The testnet mirror is constructed only in testnet mode, is guarded by current mode, and rejects any shadow-labelled fill. Changing to/from testnet requires restart. Shadow mode only subscribes to public production market data.

## Limits

Top-of-book quotes do not guarantee that the displayed size could fill. The model does not consume order-book depth, model queue priority, order latency, funding, taxes, actual exchange margin tiers or liquidation charges. Movements between quote updates can be missed; a disconnect can leave hypothetical exposure open until a fresh quote arrives. Backtests remain candle-based simulations and do not replay historical spreads. No exchange account is being mirrored.

Validated against a live BTCUSD public websocket quote containing bid, ask, mark and exchange timestamp. Reference: [Delta API v2 ticker](https://docs.delta.exchange/#v2-ticker).
