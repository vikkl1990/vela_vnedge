# Telegram alerts and private paper controls

Open **Settings → Telegram alerts**, over HTTPS or the local SSH tunnel.

1. Enter your existing BotFather token in the password field, then select **Save and verify bot**. Use a dedicated bot. The server verifies its identity and refuses an existing webhook.
2. Select **Pair private chat**, open the Telegram link and press **Start**. The link expires in five minutes.
3. Return to Settings. Check the displayed Telegram name and numeric user ID, then select **Approve chat and send test**.
4. Confirm the test message arrived. The channel becomes configured after successful Telegram delivery. The **Allow paper controls** switch can disable mutations while retaining reports and alerts.

Tokens are stored atomically in data/secrets/telegram-connection.json (owner-only file, private directory), outside config, database backups and strategy/policy identities. The API returns status and the approved chat identity, never the token. Replacing the token requires pairing again. The old environment-based alert sender remains supported where no saved connection exists; it does not authorize incoming commands.

| Command | Behavior |
| --- | --- |
| /status | Mode, paper equity, open/pending count, entry pause and feed status |
| /positions | First ten open paper positions, IDs, active stops and profit-lock/trail activation explanation |
| /pnl | Today's UTC paper closes, net after fees and fee total |
| /alerts | Active operational alert keys and delivery counters |
| /pause | Pause new paper entries immediately; existing exits remain active |
| /resume | Request removal of a manual pause; requires confirmation |
| /close ID | Request closure of that paper position's remaining quantity; requires confirmation |
| /confirm CODE | Execute a pending action once, within 60 seconds |
| /cancel | Discard pending command confirmations; does not cancel trading orders |
| /help | Command list and boundaries |

Resume does not reset the daily/weekly loss windows, scanner cooldowns, drawdown, or loss counters. A tripped daily/weekly limit refuses resume. Closures use the current paper execution engine: a request may still be pending on executable data, so the reply distinguishes requested from completed. New entries, live activation, changing risk/capital, scanner promotion, resetting the account, and arbitrary shell commands are unavailable.

Only the approved numeric Telegram user in the approved private chat can use commands, and its owning dashboard administrator must remain active. Group, forwarded, bot-generated and other-user messages are ignored. Resume confirmation is bound to the current manual-pause state; close confirmation is bound to the position's original entry and remaining quantity. A partial exit or changed position invalidates the confirmation.

The receiver uses [Telegram long polling](https://core.telegram.org/bots/api#getupdates), with durable update offsets. No inbound webhook port is opened. Command updates are consumed before execution, preventing duplicate actions after redelivery or a restart. Messages older than 90 seconds or predating receiver startup are ignored; pending confirmations do not survive a restart. A crash between consumption and execution can leave an outcome unknown, so inspect the dashboard and issue a new command rather than expecting an automatic retry. The audit records the action/result, without the token or confirmation code. Status requests are limited to 20 per minute; an authenticated protective pause remains available during that limit.

The [Telegram command menu](https://core.telegram.org/bots/api#setmycommands) is installed only for the approved chat. Authorization is enforced independently of that menu. If the receiver reports another consumer or webhook, stop the other consumer or use a separate bot; VN EDGE does not delete another application's webhook.

## Verification

Tests cover pairing and successful delivery, owner revocation, unauthorized/private/group/forwarded identities, stale and duplicate updates, restart behavior, one-use confirmations, position changes, live-mode refusal, secret-file permissions, redacted network errors, and pause/resume risk invariants. Rendered desktop/mobile tests cover token clearing, pairing approval, controls toggling, disconnect confirmation, and hiding setup from non-admins. Tests use simulated Telegram responses and never submit trading commands to a live account.
