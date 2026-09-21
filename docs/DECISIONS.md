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

## 6. The edge is thinner than the cost assumption. This is the real risk.

Testing a volatility-based trailing stop (the Oxford "volatility exit" family) produced a more
important result than the idea itself. Sweeping the fill assumption shows the whole strategy sits
close to its break-even cost:

| slippage assumed | net, current policy |
|---|---|
| 2 bps (what the backtest uses) | +4726 |
| 10 bps | −2471 |
| 25 bps | −9328 |

Eight extra basis points per side turns the system negative. That is arithmetic, not bad luck: the
edge is about 0.09R per trade, a stop is roughly 100 bps wide, so a 20 bps round trip is 0.2R of
cost against a 0.09R edge.

Measured spreads on the ten live symbols are mostly inside the assumption — BTCUSD 0.03 bps a side,
ETHUSD 0.09, ZECUSD 0.17, SOLUSD 0.47 — but EVAAUSD is 3.67 and AKEUSD 1.60, and those are quotes in
calm conditions rather than at the moment a stop is triggered.

**What follows from this.** Fill quality is not a detail to check later, it is the thing the result
depends on. The metrics that report how each entry was priced (`entries_priced_on_quote_total`
against `entries_priced_on_slippage_total`) are the early warning, and the review at 100 trades must
compare realised fills against the assumption before it compares anything else.

**Revisit if** the live record shows fills consistently worse than the 2 bps assumption, in which
case the thin-spread symbols come out of the fleet before anything else is changed.

## 7. Tested and rejected: volatility-based trailing stops

Oxford's resource list is mostly setup, filter and exit variations on public-domain patterns. The
one family that was genuinely new here was the volatility exit, a stop trailing at a multiple of
current ATR rather than at a fraction of the risk fixed at entry. Six settings were walk-forwarded
against the incumbent:

| policy | net | PF | windows won | bars held |
|---|---|---|---|---|
| current, keep 75% of peak from 1R | 4914 | 1.20 | 7/8 | 7.7 |
| ATR trail 2× | 3068 | 1.13 | 4/8 | 9.9 |
| ATR trail 3× | 3879 | 1.14 | 4/8 | 12.9 |
| ATR trail 5× | 4167 | 1.14 | 3/8 | 17.7 |

Every setting is worse on net, on profit factor, on holding time and, most tellingly, on
consistency: the ATR variants win three or four windows out of eight and swing between +3004 and
−1282, against 7/8 and a much narrower spread for the incumbent. Rejected.

A tighter give-back appeared to help and was also rejected: net rises monotonically from 4914 at
keep-75% to 9194 at keep-95%, with no peak, which is the signature of a backtest artifact rather
than an edge. At keep-95% the stop sits a fraction of a bar's range below the peak, exactly where
"the bar's low touched the stop, so fill at the stop" does the most work. Under a 10 bps fill it
collapses from +4386 to −4493, a bigger fall than the incumbent suffers. A gain that needs an
optimistic fill to exist is not a gain.

## 8. Tested: "exit above break-even when it reverses". It is the worst variant.

The instinct was that when a trade turns against you, the bot should at least get out ahead rather
than ride it to the stop. Unlike the price-threshold protections, this one keys on a reversal
*signal*, which had never been tested, so `paper.reversalMinR` was added: an opposite signal may
only close the position once it is at least that far ahead, otherwise the position is held to its
stop and the new signal is skipped.

Walk-forwarded on the VM's own fleet, 19 pairs, 1112 trades, 8 windows:

| policy | net | PF | windows won | median |
|---|---|---|---|---|
| reverse on any opposite signal (current) | 4668 | 1.47 | 7/8 | 640 |
| reverse only above break-even | 4530 | 1.47 | 7/8 | 588 |
| reverse only above 0.1R | 4613 | 1.47 | 7/8 | 588 |
| reverse only above 0.25R | 4774 | 1.49 | 7/8 | 588 |
| reverse only above 0.5R | 5112 | 1.51 | 7/8 | 547 |
| reverse only above 1R | 5146 | 1.52 | 7/8 | 547 |
| never reverse at all | 4858 | 1.49 | 7/8 | 547 |

The requested setting, reversing only above break-even, is the worst of the seven. Every variant
wins the same seven windows of eight, and the current policy has the *highest* median, so the gains
shown by the stricter thresholds come from a few windows rather than consistently. The spread from
best to worst is about 10% of net, inside what this sample can distinguish.

One directional hint worth noting for the review, not for acting on now: what helps is reversing
*less*, not more selectively in the profit direction. Refusing to reverse at all beats the current
policy by 190, and only reversing when already a full R ahead beats it by 478 — which suggests the
reversal signal itself carries little information and the "already winning" condition is doing the
work.

`reversalMinR` ships at 0, which is current behaviour. Nothing changed on the live account.

**Revisit at** the 100-trade review, alongside the fill-quality check, since the candidates here are
separated by less than the cost assumption is worth.

## 9. Tested: taking partial profit at TP1. Worse in every window.

With targets at 2/4/6 R and the split at 0/0/100, TP1 and TP2 carry no contracts, so the whole
position rides to 6R, to the trail, or to the stop. The obvious objection is that it banks nothing
on the way. Six splits were walk-forwarded against it on the VM fleet, 19 pairs, 1112 trades:

| split | net | PF | avg R |
|---|---|---|---|
| 0/0/100, current | 4668 | 1.47 | 0.20 |
| 20/30/50 | 4242 | 1.44 | 0.18 |
| 25/25/50 | 4174 | 1.43 | 0.18 |
| 33/33/34 | 3977 | 1.41 | 0.17 |
| 40/30/30 | 3884 | 1.40 | 0.17 |
| 50/0/50 | 3769 | 1.39 | 0.16 |
| 50/25/25 | 3698 | 1.39 | 0.16 |

Monotonic: the more taken at TP1, the worse the result. Unlike the other exit tests this one is
consistent rather than marginal — the current split wins seven of the eight windows outright and
ties the eighth, and no split wins a single window.

The mechanism is plain in the numbers. Trade count is identical at 1112 and win rate identical at
57%, because the split changes nothing about which trades are taken or where they stop. It only
truncates the winners. Banking 2R on half the position removes that half from everything above 2R,
and the give-back trail is already protecting the open profit, so the partial adds no safety it did
not already have. It converts a run into a cap.

This is the same lesson as the floors and the give-back thresholds, in the one place it is
unambiguous: on this fleet, protecting profit earlier costs more than it saves, every time.
