# Paper positions and a misleading empty dashboard

Verified 16 November 2026, 02:35 UTC, against VM `080eccb`, using read-only
position/order/entry-evidence queries and the original service logs. No positions
were created, cancelled, closed or backdated by this audit.

| Paper position | Recorded fill (UTC) | Audit row recorded after fill timestamp |
| --- | --- | --- |
| ETHUSD #18850 | 15 Nov 08:02:00.252 | 8 ms |
| BNBUSD #19035 | 15 Nov 12:02:27.570 | 8 ms |
| LINKUSD #19211 | 15 Nov 16:07:18.049 | 9 ms |
| SOLUSD #19481 | 16 Nov 01:01:01.077 | 11 ms |
| UNIUSD #19482 | 16 Nov 02:17:45.062 | 11 ms |

The original log contains each OPEN at that time. The restart at 02:10:46 UTC
loaded four existing positions at 02:10:51; it did not create them. UNI's resting
limit was placed at 01:00:18.519 and survived the restart, then filled against a
live 02:17 minute update at 02:17:45. SOL subsequently closed at 02:24:05.
All five use execution model 211. Their minute observations start after placement
and precede the recorded fill. They are forward paper trades, not backtests
inserted into the account. Among all 259 entries with entry-execution records in
the preceding seven days, recording lag was 6–169 ms (median 24 ms).

Their entry source is `limit-candle-model`: price traded through the resting limit
in a newly observed live minute. This establishes a causal modelled fill; it does
not establish exchange queue priority or the quantity an actual order would fill.
Do not describe these fills as confirmed exchange fills. No maker-pricing rule or
existing exit policy is changed by the UI correction.

## Confirmed display bug

The SSE position handler used `previous ?? []`. A close event arriving before the
first complete positions response created a successful empty cache. An open or
update event could similarly manufacture a partial list. The UI then showed that
as the account, rather than as unknown/loading. Each event also refreshed the
cache timestamp although it described only one position. A rendered browser test
reproduced the false “No open positions” message on the deployed code.

Without a recording of the user's earlier browser session, the exact trigger of
that session cannot be established. The reproduced defect is consistent with the
report, and the server's orders/logs independently disprove newly backdated fills
for the pictured positions.

## Correction and checks

- Deltas only update an already loaded list; they cannot initialize one.
- Preserve the last complete response time when applying a per-position event.
- Refresh the full list every 10 seconds and upon stream connection/remount.
- Shared positions display on Home, Workspace and Trades shows refresh status,
  refresh failures and an explicit refresh control. Cached empty/error is never
  presented as a verified empty account. Workspace filters say when positions
  exist outside the current view.
- Show absolute fill date/time and relative age on desktop and phone.

The regression failed on the old handler and passed after the fix. Validation:
89 dashboard unit tests, 38 rendered desktop/phone tests, type checking, lint and
build. Trading, paper configuration, evidence rules and risk settings are untouched.
