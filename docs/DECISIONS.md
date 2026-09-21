# Standing decisions

Recorded so the next change is argued against something, rather than made from scratch or from a
bad week. Each entry says what was decided, why, and what would justify revisiting it.

## 1. The VM is the record. The Mac is the workshop.

The instance at `/opt/vnedge` is the one whose numbers count. It runs under systemd, starts at boot,
survives a reboot unattended and does not depend on any other machine. The Mac keeps the research
tooling (`npm run losses`, `exits`, `verdict`, `backtest`) and is where code changes are made and
tested before they are pulled on the VM.

Two live paper accounts on one strategy is not twice the evidence; it is two records and an argument
about which one is real. When they disagree, the VM is right.

## 2. The VM's trade history starts clean. The Mac's is not copied across.

The Mac's database holds months of trades, but they were produced by a bot that no longer exists:
the old exit policy (targets at 1/2/3 R with a break-even jump), the old fleet, and the period before
the fixes for stale-signal entry, unbounded stop risk, spread charged twice and historical candles
filling at the current time. Its equity curve measures a different system.

Blending that with trades taken under the current configuration would make win rate, profit factor,
the analytics page and the machine-learning samples describe an average of two bots. The forward
record is only worth having if every trade in it came from the same rules.

The backtest cache is not worth copying either: warm-up rebuilds it from the current configuration
in under a minute.

**Revisit if** the configuration is ever reverted to what produced that history, which it will not be.

## 3. The configuration is frozen until there is a live sample.

Every choice made so far — which scanners, which pairs, which exit policy, the stop width — came
from walk-forward on the same roughly 41 days of 15-minute history. That window has been read many
times now. Another pass over it is fitting, not learning, and the loss research already found that
no entry filter improves it: all seven candidates tested lowered net profit.

The next genuine information is live forward trades, of which there are currently none. So: no
changes to the fleet, the exit policy, the stop or the sizing until there are enough of them.

Specifically frozen: `fillSource: candles` (tape mode is more realistic but switching mid-record
breaks comparability), `requireQuote: false` (availability over precision — a book outage should not
halt trading, and the fill-source metrics make the fallback visible), targets at 2/4/6 R, the trail
armed at 1R keeping 75% of the peak, and the 14 scanners on their 20 pairs.

**Revisit at** 100 closed live trades, or 8 weeks, whichever comes first.

## 4. The review is pre-committed, so a bad week cannot rewrite it.

At the review point, compare the live record against what the walk-forward predicted: profit factor
around 1.5, roughly 57% of trades winning, about 7.8 bars held, and an average result near +0.2R per
trade.

- Live profit factor above 1.2 → the edge survived contact. Keep going, consider widening the fleet.
- Between 0.9 and 1.2 → inconclusive on this sample. Keep going, change nothing.
- Below 0.9 with 100 or more trades → the backtest did not transfer. Stop, and investigate the gap
  between simulated and live fills before touching the strategy.

Drawdown is bounded separately by the risk layer: 15% in a day, 30% in a week, both of which halt
new entries.

## 5. Alerting is the one real gap.

The bot detects a stalled feed, a deep worker queue, a drawdown past 10% and a daily summary, but
delivery is unconfigured, so those conditions only reach the log and the dashboard. Nobody is told
at three in the morning.

Closing it needs a Telegram bot token and chat id, which belong in the service environment rather
than in `config.json`:

```
sudo systemctl edit vnedge      # add under [Service]
Environment=TELEGRAM_BOT_TOKEN=...
Environment=TELEGRAM_CHAT_ID=...
```

Until that is done, the forward record is running unobserved between the times someone opens the
dashboard. systemd will restart a crash, but a silent feed stall or a drawdown will not announce
itself.
