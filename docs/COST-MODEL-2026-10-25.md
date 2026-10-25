# Cost model correction — 25 October 2026

Maker entries previously failed a two-taker admission budget and were sized as slipped taker entries. They now reserve maker entry commission, taker stop-out commission and half the observed round-trip crossing for the exit. Market entries retain the full crossing budget. Both entry admission and limit-fill rechecks use the same rule. Sizing prices the actual entry route; future stop-out costs remain conservative. The 6× policy is unchanged, and future promotional waivers are never credited to admission or sizing.

An observed book-crossing cost now replaces fallback `slippageBps` in a backtest. `quotedSlippageBps` (default 0) is additional impact/latency beyond the observed crossing or live quote, and the nightly/conjunction stress paths explicitly populate it. Size-dependent impact remains separately controlled by `depthUsdPerBp`. This corrects the reproduced $4 discrepancy per $10,000 flat round trip at a 0.02% spread with 2 bps fallback slippage.

`scalperOffer.joinedAt` optionally records the account's actual enrollment timestamp in milliseconds. Trades opened earlier cannot receive a simulated waiver. Existing enabled configurations without a known date retain their behaviour and are labelled `legacy-unverified` in backtest cost coverage. No enrollment date is invented; vouchers are not counted as cash profit.

Funding settlement duplication is rejected using the position's persisted fills, including after a reload. Backtests accept exact `{at, ratePct, markPrice}` funding settlements and replay them before price-bar processing at settlement boundaries; a position cannot be charged before its actual opening time. The CLI accepts `FUNDING_FILE=/path/to/settlements.json`. Invalid marks/rates/times fail rather than silently losing costs. Repeated settlements are idempotent. Funding is charged on the then-open quantity; the model does not establish ordering inside one execution candle.

Backtest `costCoverage` names crossing, funding, depth-impact and promotional assumptions. Supplied settlements are marked `provided`, not certified complete. A run without historical funding explicitly says `not-modelled`. Historical funding is not fabricated from today's rates or OHLC funding charts. Replay/infrastructure must supply verified settlement records to close that data gap. There is no automatic historical funding backfill in this release.

Simulation versions advance to 203 (trade fingerprint) and 6 (backtest cache), separating this evidence from prior semantics. Existing trades and account data are not rewritten.

Remaining calibration: full depth walking at actual account size, shadow capacity at deployable size, historical funding ingestion and exchange GST/voucher reconciliation. These need measured data; no depth coefficient or exchange-account entitlement was guessed in this correction.

Validation includes maker admission through fill, maker sizing, quote/backtest net-P&L parity, explicit stress, enrollment dates, persisted funding idempotency, historical replay/disabled funding and invalid-cost configuration rejection.
