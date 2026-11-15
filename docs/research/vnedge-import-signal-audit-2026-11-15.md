# Six imported shadow cells: signal-path audit

Verified 15 November 2026 at 16:04 IST against VM commit `a824de0`. The source bot's current HEAD remains `537ecec`. See the accompanying JSON for all 60 scan receipts and replay results. This is a diagnostic replay, not promotion evidence or a profit backtest.

## Why there are no entries or fills

All six cells have uninterrupted scan receipts since activation. None emitted an entry or exit; there are no entry refusals to attribute to fees, capacity, sizing, or evidence gates. Plan scan counts are recorded before admission gates.

| Cell | Recorded scans | Source comparison | Reason for waiting |
| --- | ---: | --- | --- |
| Stealth BTC 15m | 16 | 16 zero-entry scans reproduced | Source's last long was on the 02:30 UTC bar (08:15 IST close), before activation. No new flip or pending confirmation. |
| Stealth ETH 15m | 16 | 16 zero-entry scans reproduced | Source's last long was on the 02:15 UTC bar (08:00 IST close), before activation. No new flip or pending confirmation. |
| Stealth SOL 15m | 16 | 16 zero-entry scans reproduced | Source's last long was on the 02:30 UTC bar (08:15 IST close), before activation. No new flip or pending confirmation. |
| Trend BTC 1h | 4 | Python and Pine agree on every scan | ATR percentile 99.4–99.8%, above the source's 90% ceiling; ER 0.188–0.267, below 0.30; no qualifying breakout. |
| Trend ETH 1h | 4 | Python and Pine agree on every scan | ATR percentile 99.0–99.8%; ER 0.178–0.236; no qualifying breakout. |
| Trend SOL 1h | 4 | Python and Pine agree on every scan | ATR percentile 98.5–99.8%; no qualifying breakout. ER passes on two bars and fails on two. |

Stealth is not a continuous “trend is long” entry generator. The source starts a trade only on a qualified flip/confirmation, then maintains its own position until an exit. All three retain a historical long at this checkpoint. The bot must not enter that old position at an invented historical fill or reinterpret it as a fresh signal.

Across the current loaded histories the native reader finds 27 BTC, 25 ETH and 23 SOL Stealth entries. Original source alerts and shapes are unchanged by the numeric lifecycle observations. For each hourly receipt, the pinned Python strategy, indicators and regime calculations agree with the port on ER, ATR, ATR rank and the absence of an entry. Source defaults remain ER >= 0.30, ATR rank <= 0.90 and a 48-close breakout in the EMA trend direction. The source adapter supplies no funding input; the port's already-documented funding limitation remains.

## Confirmed scheduling gaps and correction

1. `App.onConfigChanged` refreshed account scanners but did not synchronize the shadow schedule. A newly saved research plan could wait for the five-minute timer, potentially losing its first fresh close to the unchanged five-minute entry-age limit.
2. If another config/stage change arrived while candle loading was underway, `ShadowRunner.sync` returned the old in-flight promise without scheduling a fresh pass. The new allocation could again wait for the timer.

The correction synchronizes shadow sources during config refresh and updates their realtime subscriptions before the refresh returns. Concurrent refresh requests coalesce into a fresh pass after candle loading. Existing watermark deduplication, candle-integrity checks, worker priorities and stale-signal deadlines remain in force.

These gaps did **not** cause the observed 60 quiet scans: those match the source. Fixing activation makes future valid setups reachable promptly; it does not promise more qualifying setups or profitable trades.

## Validation and boundaries

- Both bug-specific regression tests fail on the old code and pass with the correction.
- Full server suite: **1,478 / 1,478 pass**. Server TypeScript check passes. The additional concurrency test also covers a refresh arriving while the previous pass settles.
- Tests cover fresh activation, a config change during candle loading, stream subscriptions, duplicate suppression, stale-close rejection, no fabricated fills and unchanged policy configuration.
- Existing import tests exercise positive native signals, original-source parity, Python reference entries, causal stop amendments, charged fees and experimental evidence exclusion.
- Signal replay uses the VM's actual 1,000-bar history limit. Raw data stays in the local research workspace. The committed JSON contains diagnostics and receipts only, without credentials or account configuration.
- The diagnostic replay uses a uniform 0.01 tick size and current retained candles. There is no fill/profit assertion from these zero-entry bars. This does not substitute for archived per-run candle snapshots or forward fill validation.
- No scanner reading, source, cohort identity, execution plan, margin, risk cap, fee/evidence threshold, or account enablement changes.
