# Chart integration improvements

- Authoritative candle events own OHLCV. Tick nudges must match the forming candle's bucket, be in order and have a valid price. Closed candles cannot be reopened by delayed forming events.
- Held scanners are resolved by identity even when disabled for new account entries. Viewing one does not enable it.
- Scanner source responses include current input overrides, timezone metadata and patched-source hash. Chart indicators resolve overrides by schema key or display title; removing an override restores its declared default. Non-UTC bot timezones are explicitly marked as not reproduced by chart metadata.
- Bot journal decisions appear as clickable Vela timeline marks with the real action, signal-bar time and decision time. The sidebar exposes actions and rejection reasons. It defaults to the selected timeframe and last 24 hours, with explicit all-timeframe/older-history switches. Entry-signal lookup uses position identity independently of the recent feed.
- Pine scripts run through Vela's worker engine. A synthetic browser check confirmed a configured six-period EMA (119.95) rather than the source default three-period EMA (120.10), plus successful timeframe switching.
- Trade replay defaults to a one-minute execution view, with the strategy-candle overview still available. Replay is explicitly a sampled/candle view, not proof of exact intrabar ordering or hypothetical fills.

Validation: five focused regression cases cover rollover/closed bars, stale and invalid updates, timeframe/position signal filtering before LIMIT, escaped journal-mark content and input-key normalization. Full server tests, server TypeScript, dashboard lint and production build are required before deployment.

These chart changes do not alter the trading engine's signals, stops, sizing or risk configuration. Current source/inputs are shown; historical source snapshots and full browser/server signal parity remain future work.
