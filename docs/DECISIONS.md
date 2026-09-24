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

## 10. Tested: other timeframes. 15m is the only one that works on this fleet.

The same 19 scanner/symbol pairs, the same exit policy, the same 40 days, run at four timeframes:

| timeframe | trades | net | PF | win% | avg R | trades/day | windows up |
|---|---|---|---|---|---|---|---|
| 5m | 1074 | −1777 | 0.79 | 43% | −0.11 | 26.9 | 1/8 |
| **15m (live)** | **1067** | **4514** | **1.48** | **56%** | **0.20** | **26.7** | **7/8** |
| 1h | 345 | 740 | 1.23 | 50% | 0.11 | 8.6 | 5/8 |
| 4h | 64 | 318 | 1.60 | 50% | 0.30 | 1.6 | 5/8 |

5m is not a thinner version of the same edge, it is the opposite sign: the win rate falls from 56%
to 43% and only one window of eight is positive, on almost exactly the same number of trades. These
scanners are reading structure that does not exist five minutes at a time.

1h and 4h keep a positive expectancy but give up most of the sample: 1h trades a third as often for
half the edge, and 4h produces 64 trades in 40 days, which is too few to select on and too few to
trade. 4h's higher average R on 64 trades is not evidence of anything.

So the fleet's edge is specific to 15m, which is also the timeframe it was selected on — worth
stating plainly, because it means the selection and the result are not independent.

**Revisit if** the review shows 15m working live, at which point 1h becomes a candidate for
diversifying the signal source rather than replacing it. Adding 5m would be actively harmful.

## 11. Tested: letting a higher timeframe decide the exit. It adds nothing.

Entries stay on 15m, where the edge is. A 1h or 4h trend is computed from its own candles and,
wherever it flips against an open position, an exit is injected at the first 15m bar closing after
that higher candle completed — so the flip is only acted on once it is actually known. Stops,
targets and the trail still apply, so the higher timeframe can only end a trade early.

| variant | trades | net | PF | avg R | bars held | htf exits fired | windows up |
|---|---|---|---|---|---|---|---|
| 15m only (current) | 1067 | 4514 | 1.48 | 0.20 | 7.7 | — | 7/8 |
| + 1h trend, EMA 20 | 1082 | 4057 | 1.44 | 0.18 | 7.0 | 2333 | 7/8 |
| + 1h trend, EMA 50 | 1070 | 4430 | 1.48 | 0.20 | 7.5 | 1471 | 7/8 |
| + 4h trend, EMA 20 | 1068 | 4511 | 1.48 | 0.20 | 7.7 | 487 | 7/8 |
| + 4h trend, EMA 50 | 1068 | 4365 | 1.47 | 0.19 | 7.7 | 264 | 7/8 |

Nothing beats the baseline, and the ordering is informative: the more the higher timeframe
interferes, the worse it gets. 2333 injected exits cost 457; 487 cost 3. The 4h EMA-20 variant is
within rounding of doing nothing, which is exactly what firing 487 exits across 1068 trades amounts
to.

Per window it is the same story — the baseline is highest or tied in six of eight, and no variant
leads more than one. This is not a marginal call being decided by the total.

**Why it fails is worth keeping.** A 15m trade lasts 7.7 bars, under two hours. A 1h trend needs
several candles to turn, and a 4h trend needs most of a day. By the time either confirms, the trade
is usually over. The higher timeframe is not wrong, it is late, and the stop and trail have already
resolved the position.

**Revisit if** holding times lengthen materially — a rule that is too slow for a two-hour trade
could be useful for a two-day one.

## 12. First live sample: 12 trades, 2 winners. The engine is faithful; the strategy had a bad run.

After roughly half a day on the VM the account had closed 12 trades and won 2, for −7.60R, against
a backtest expectation of 57% winners and +0.20R a trade. On its face, two or fewer wins in twelve
at 57% has a 0.53% chance.

`npm run replay` answers the first question that raises: did the engine do something the backtest
would not? It ran every closed live trade's scanner through the backtester on the same bars. **All
twelve matched.** The backtest took every one of them, ended each the same way — the same stop,
reversal or trail exit — and landed within 0.03R of the live result each time. Live −7.60R,
backtest −7.66R.

So this is not an execution gap, a fill problem or a bug. The paper engine is doing exactly what was
tested. The losses are the strategy meeting this particular stretch of market.

Two reasons not to read more into it than that:

- **The twelve are not independent.** Four are the same scanner on UNIUSD flipping short, long,
  short, long through a choppy session; three more are the same scanner buying LINKUSD and being
  stopped each time. The effective sample is closer to five or six decisions than twelve, so the
  0.53% figure overstates how surprising it is.
- **The walk-forward already contains windows like this.** Its first window was negative, and the
  spread across windows ran from −219 to +1166. A bad half-day is inside that range.

What twelve correlated trades cannot do is distinguish "a bad window" from "the 57% was optimistic",
and the pre-committed review exists precisely so that question is answered on 100 trades, not on a
bad day. Nothing is changed.

**One sizing effect this surfaced.** Two of the twelve were absurdly small — 3 LINKUSD contracts at
$0.49 of risk and 4 FILUSD contracts at $0.04 — because isolated margin was already committed to
other open positions. That is working as designed, but it means live position size varies by a
factor of 500 with concurrency, while the backtest runs every pair on its own purse at full size.
R per trade matches, as the replay shows; dollar results do not. A position too small to matter is
noise, and skipping entries below a minimum risk would be reasonable — noted for the review rather
than changed during the freeze.

## 13. Backtests resolved exits on the signal bar; live resolves them on 1m. The gap is large.

The live engine checks stops, targets and the trail on every 1-minute candle. The backtest checked
them once per 15m bar. The backtest can now replay each bar's 1m path (`subBars` in
`runBacktest`; `npm run intrabar`; `EXIT_1M=1 npm run exits`), and the two disagree badly for the
policy that is live:

| live policy, 41 pairs, 4000 × 15m | net | PF | windows up | median window |
|---|---|---|---|---|
| exits on the 15m bar (what decisions 6–11 used) | +4412 | 1.19 | 6/8 | +442 |
| exits on 1m candles (what live does) | +1191 | 1.05 | 3/8 | −43 |

Ambiguous bars are not the cause: only 6 of 2339 trades change sign. The trail is. On bar-level
fills a give-back trail can only tighten once per bar, which lets a trade breathe for fifteen
minutes; on 1m it tightens every minute and is shaken out by noise. Every tight trailing rule was
flattered the same way (floor 0.5R: +2768 → −1088; give back 50% from 0.4R: +2515 → −443). Rules
that do not trail tightly barely move: no trail +4596 → +4669, ATR trail 3× from 1R +3441 → +3007
(5/8 windows under both models).

Consequences:

- Decisions 6 and 7 were taken on the flattering model. The ATR trail that decision 7 rejected is
  the one policy that is both robust to fill resolution and up in most windows on 1m.
- Exit policies must be compared with `EXIT_1M=1` from now on. Entry-side results (which scanners,
  which timeframe) are much less affected, since entries still happen at the signal bar's close.
- Higher-timeframe results are flattered more, not less: a 4h bar holds 240 minutes of path. The
  SATS 4h result (PF 1.10 out of sample, bar-level) must be read with that in mind.
- Decision 12's replay compared live with the bar-level backtest; its twelve trades were mostly
  plain stop-outs, where the two models agree, so its conclusion stands.

**Follow-up: ATR trail widths on 1m, with the look-ahead removed.** The first 1m run gave the trail
the ATR of the bar still in progress, which live cannot know. Using the last closed bar (as live
now does, via `PaperEngine.atrFor`), each candidate against the live policy, window by window:

| policy | net | PF | beats live in | net gain | gain without its best window |
|---|---|---|---|---|---|
| live: keep 75% from 1R | +1496 | 1.08 | – | – | – |
| give back 50% from 1R | +1586 | 1.08 | 5/8 | +22 | −454 |
| ATR 2× from 1R | +2143 | 1.11 | 4/8 | +366 | −493 |
| ATR 2.5× from 1R | +2239 | 1.11 | 4/8 | +497 | −680 |
| ATR 3× from 1R | +3128 | 1.14 | 4/8 | +798 | −1056 |
| ATR 3× from 0.5R | +3120 | 1.14 | 4/8 | +877 | −983 |

The ATR trails earn more in total only by riding one or two strong trends further, and give it back
in chop. None beats the live policy in most windows, and every one of them is behind once its single
best window is removed. That is a different risk profile, not an improvement, so **the live exit is
not changed**. The 1m replay removed the illusion that the live trail was strong; it did not find a
better one.

Tick fills (`fillSource: tape`) were not adopted either: the tape path never runs the trail at all,
and there is no tick history to test it on.

## 14. Exit changed: keep 60% of the peak from 1.5R (was 75% from 1R). And fees now include GST.

**Why the trades "wait and then hit the stop".** `npm run reconstruct` walked every trade minute by
minute. Of 402 backtest trades stopped at −1R, 48% never got above +0.25R and 16% never traded above
entry at all: no exit rule can rescue those, they are entry failures. Only 28% had reached +0.5R
first. Live showed the same shape: of 13 stops, 8 never passed +0.25R.

**Protecting earlier makes it worse.** `npm run exitlab` replayed rules on the raw 1m path after all
992 entries (costs included). Break-even at 0.5R, locking 0.3R at 0.75R, time stops and early
targets all lost more than the live rule, in most windows. The trades they save are outnumbered by
the ones they cut that dip and then run. The rules that helped went the other way: more room.

**The chosen rule** was the robust one in the lab (6/8 windows ahead of live on the VM fleet) and was
then confirmed in the full engine, with script exits and reversals, on the broader 41-pair set:

| 1m exits, GST included | net | PF | windows up | median window | ahead of live |
|---|---|---|---|---|---|
| live: keep 75% from 1R | +213 | 1.01 | 3/8 | −147 | – |
| **keep 60% from 1.5R** | **+1361** | **1.06** | **5/8** | **+438** | **5/8** |

It stays ahead with its best window removed. Larger totals (no trail +4223, keep 50% from 1.5R
+1899) come from one or two trending windows and are not taken.

Set: `trailAfterR 1.5`, `trailGiveBackPct 40`. Fees: `feeTaxPct 18` (Delta India's GST, on top of
the published 0.05% / 0.02%). The live sample restarts from this deploy (decision 3).

## 15. Scanner exits versus price exits, and where protection should start

**Who should decide the exit** (`POLICIES=source EXIT_1M=1 npm run exits`, the VM's 17 pairs, 1m exits, GST):

| policy | trades | net | PF | win% | windows up | median |
|---|---|---|---|---|---|---|
| scanner exits only (stop kept, no trail/targets) | 506 | +5063 | 1.72 | 27% | 3/8 | −245 |
| both, old trail (75% from 1R) | 992 | +1587 | 1.19 | 55% | 5/8 | +130 |
| both, new trail (60% from 1.5R), live | 917 | +2260 | 1.24 | 45% | 6/8 | +315 |
| both, new + lock 0.5R at 1R | 951 | +1999 | 1.26 | 55% | 6/8 | +298 |
| price only, new + lock 0.5R at 1R | 888 | +2202 | 1.29 | 56% | 7/8 | +332 |

The scripts barely exit on their own (2 script exits in 992 trades); "scanner exits" is almost
entirely reversals plus holding to the stop. It makes the most in total by riding two trends for
eleven hours at a time, and loses in five of eight windows: not a policy to trade. Reversals as an
exit are neutral (71 trades, −28). Every price-exit variant is more consistent.

**Where protection should start, and on which candle** (`GRID=1 npm run exitlab`, 108 rules on the
1m path after 992 entries). The ranking of individual rules between the two halves of the data
correlates at 0.11, so picking the single best cell is picking noise; the averages over each
dimension are what can be trusted:

- Candle: trailing on 1m touches beats trailing on 5m or 15m closes (average +85R vs +66R / +68R).
  Ignoring wicks lets pullbacks run further before the exit. Higher timeframes were already ruled
  out as exit signals (decision 11).
- Start level: protecting from 0.5R destroys the edge (−3R); 0.75R is weak (+44R); anything from 1R
  to 2R is about the same (+83R to +90R). Start at 1.25R or later and stop tuning it.
- Share kept and the 0.5R lock at 1R: trade-offs, not improvements. The lock costs a little total
  and buys back the old 55% win rate and the highest PF.

## 16. Deployed: 0.5R lock at 1R, the fleet cut to ten pairs, and auto-tune switched off

**Exit.** Decision 14's trail (keep 60% of the peak from 1.5R) plus `floorAtR 1`, `floorKeepR 0.5`:
once a trade has been +1R the stop moves to +0.5R, so a trade that reached +1R can no longer end as a
loss. On the VM fleet this was the most consistent rule tested (decision 15): PF 1.26–1.29, 55–56%
win rate, 6–7 of 8 windows.

**Fleet.** From `npm run deepdive` (41 days, 1m exits, GST): kept every pair rated KEEP or WEAK,
removed every DROP.

| kept (10) | removed (7) |
|---|---|
| dynamic-trend-bands FILUSD, kinetic-momentum UNIUSD + PIEVERSEUSD, high-volume-breakout ZECUSD, liquidity-trail-matrix ETHUSD, session-breakout-context SOLUSD, supertrend-cluster BTCUSD, smart-swing-vwap AKEUSD + EVAAUSD, smart-money-breakout AKEUSD | ai-predictive-flow UNIUSD (332 trades, dies at 10 bps), smart-swing-vwap LINKUSD, supertrend-cluster ETHUSD, session-killzones AKEUSD, adaptive-atr-extension SOLUSD, fia-trend-momentum BTCUSD, pivot-channel-breaks ZECUSD |

**Auto-tune off.** On the 14:30 restart it removed four of the kept pairs, including kinetic-momentum
UNIUSD (PF 2.18 over 41 days). It judges on the last ~10 days of bar-level backtests, keeps a pair on
3 trades and any profit, runs every six hours and can only ever remove: over weeks it would switch
the fleet off by chance, and it overrides every decision above. Fleet changes are made by review.

## 17. The incubator: disabled scanners are screened daily, proven in a shadow book, then proposed

Auto-tune (decision 16) judged pairs on ten days of backtest and could only remove. Its replacement
works in both directions and never promotes on a backtest alone:

1. **Screen** (`npm run incubate`, daily systemd timer at 01:00 UTC). One seventh of the library per
   day, on the ~40 most liquid USD perpetuals, 15m, exits on 1m, live exit rules, fees with GST. Passes:
   ≥ 20 trades, PF ≥ 1.2, ≥ 5/8 windows up, still profitable at 10 bps. A script with no entry on its
   first three markets is skipped for the rest. This is only a filter: tens of thousands of
   comparisons pass hundreds of pairs by luck.
2. **Shadow.** The best candidates by (PF − 1)·√trades take free slots (100) and trade in a separate
   book (`positions.bt = 2`) on live data: same script run, extraction and paper logic as a live pair,
   but no live account, risk gate, executor or alerts. Every shadow trade happens after the pair was
   picked, so it carries no selection bias.
3. **Gate.** Proposed after ≥ 30 shadow trades over ≥ 14 days, PF ≥ 1.2 in R, ≥ 60% of weeks positive,
   ≥ 0.1R per trade, and ≤ 50% of entries duplicating a live pair on the same market. Retired if PF < 1.0
   on a full sample or not proven within 45 days; retired pairs are not screened for 30 days.
4. **Approve.** The owner promotes or rejects on the Incubator page. At most 2 promotions a week and
   20 live pairs. Promotion adds the market to the scanner's live symbols.
5. **Demote.** A live pair whose last 50 trades (≥ 30) fall below PF 0.9 is proposed for demotion; approved,
   it leaves the live fleet and goes back to the shadow book to prove itself again.

Every move is logged in `incubator_events` with the numbers behind it. Promotion is manual until the
gate has a track record; the first proposals cannot arrive before ~2–3 weeks of shadow trading.

## 18. External audit of 6610d73: twelve findings, all accepted; seven fixed now, the rest block exchange mirroring

All five reproduced failures reproduced here too, on the same fixtures. Each is fixed and the
report's own check, with its expectation inverted, now passes.

| # | finding | verdict | status |
|---|---|---|---|
| 7 | Pine provider served the scanner's own market for any requested symbol | accepted, **live today**: `session-breakout-context` computed its DXY filter on SOL | fixed: the requested market is fetched; a market Delta does not list fails the run. That scanner cannot run honestly on Delta and leaves the fleet |
| 8 | incubator shadow lacked quotes, tape, mark, funding and input overrides | accepted (introduced by decision 17) | fixed: both books share one market-data wiring; inputs pass through shadow and screen |
| 6 | quote freshness judged on receipt time only | accepted, affects paper entry prices | fixed: exchange time kept, both clocks must be fresh (2 s skew allowance), ordering by exchange time |
| 10 | `quote_at` in fill records was the mark's time | accepted | fixed: the quote's own receipt time; ticker-only quotes now reported |
| 9 | live evaluations shared a FIFO with background work; the backlog guard could drop live bars | accepted, matters more now that 100 shadow pairs share the pool | fixed: live and background queues, live first; live jobs expire after 240 s in the queue; the guard counts live work only |
| 4 | tape prints never moved the trail or the floor | accepted, dormant (VM uses candle fills) | fixed: same ordering as bars, stop persisted and emitted when it moves |
| 5 | depth impact could push the stop loss past the cap | accepted, dormant (`depthUsdPerBp` 0) | fixed: the order is sized on the exact stop-out cost and shrunk until it fits |
| 1 | a rejected bracket still suppressed market exits | accepted, dormant (execution mode paper) | fixed minimally: a level exit is left to the exchange only if its order was acknowledged; a failed stop replacement retries |
| 2 | paper fills, not exchange fills, are authoritative | accepted | **open: blocks any exchange mirroring** |
| 3 | stop replacement cancels first; brackets are memory-only across restarts | accepted | **open: blocks any exchange mirroring** |
| 11 | liquidation, funding and TP liquidity are simplified models | accepted as a limitation | documented; the numbers are estimates |
| 12 | no per-trade configuration snapshot; no frozen forward test or shared-capital replay | accepted | open; the incubator's shadow book is the forward test for new pairs, the live 100-trade review for the fleet |

Findings 2 and 3 need a durable order state machine (intent → submitted → acknowledged → filled,
recovery by client order id, protection built from confirmed exposure, brackets persisted and
verified on start). Until that exists, testnet or production mirroring must not be enabled. Paper
trading, which is all the VM does, does not touch that code.

One trade-off accepted knowingly: a script asking for an unlisted market now crashes its worker
thread (PineTS requests the series outside the job's error handling) and the worker is replaced.
That costs a restart per such run, in background work only, rather than risk a hung run sharing a thread.

## 19. Tested: smart take-profits and early-move capture. Neither beats the trail; nothing changed.

`TP=1 npm run exitlab` and `SPIKE=1 npm run exitlab`, raw 1m paths, costs with GST, stops identical
to live (lock +0.5R at 1R, keep 60% of the peak from 1.5R).

**Where the market goes.** Before the −1R stop or 24 h: median best 1.24R; 38% reach 2R, 15% reach 6R,
10% reach 8R. The median trade that reaches 1R peaks five hours after entry. The fixed targets are
not unreachable: the trail usually exits first, and the fat tail is where the profit is.

**Smart targets** (VM fleet, 992 entries; live +109.5R): scale-outs at 1.5R/2R/3R +68 to +92; prior-24h
extreme +77 (half there +94); each scanner's walk-forward median peak +26 (half there +68);
time-decaying targets +41 to +91. None beat live in more than 2 of 8 windows. Removing the 6R cap
(+159) comes almost entirely from one window. Capping winners cuts the edge.

**Early-move capture** (window 30 min BTC/ETH, 15 min others). Alts: an early spike predicts a
runner (≥1.5R in 15 min: 64% double, 24% fall back, median final peak 5.1R), and taking it costs
30–86R. BTC/ETH: on the VM fleet's 80 entries an early spike looked like a reversal (86% fell
back), but on 949 BTC/ETH entries across the local fleet it is a coin flip (40–47% double, 47–48%
fall back) and every capture rule loses 16–120R more than the trail. The first result was 7 trades.

## 20. Delta's Scalper Offer is modelled and on; chasing its window is not

Delta India waives the closing fee when a futures position closes within 30 minutes of opening on
BTCUSD/ETHUSD and 15 minutes on other futures (partial closes count; liquidations and PAXG, SLVON,
XAUT do not; the account must opt in once with "Join Now"). `paper.scalperOffer` models it; the
window starts at the actual fill (the backtest fills at the signal bar's close, `openedAt`).

`SCALP=1 npm run exitlab`, costs charged per exited portion:

| sample | live, full fees | live, with the offer | best capture rule |
|---|---|---|---|
| VM fleet, 992 entries | +109.5R | +116.2R | +113.5R (1R early → keep 80%) |
| BTC/ETH, 949 entries (local fleet) | −96.9R | −73.6R | −96.2R |

The offer itself is worth ~6% on the fleet with no change in behaviour: quick stop-outs already
close inside the window. Taking profit early to stay inside it, or scratching trades that are not
working at the window's end, still loses more than the fee saves. Enabled on the VM on the
assumption that the account has opted in; if it has not, paper results are ~6% flattered.

## 21. Tested: a stricter cost filter (minimum stop in round-trip fees). Not adopted; available per market.

Costs in R are roughly round-trip % ÷ stop %, so tight stops pay a third of every R on BTC. The
filter `minRiskFeeRatio` (live 4× = a 0.47% minimum stop) was raised in the full engine, 1m exits,
VM paper settings (`PAPER=`, `POLICIES=costfilter`):

| sample | 4× (live) | 6× | 8× | 10× | 12× |
|---|---|---|---|---|---|
| VM 17-pair list, net | +2019 | +1727 | +1077 | +883 | +874 |
| 34 BTC/ETH pairs, net | −652 (PF 0.92) | +394 (1.14) | +548 (1.89, 5/7 windows) | +182 | +147 |

On alts the filter only removes profitable trades. On the broad BTC/ETH universe any threshold of 6×
or more turns losing into winning. But on the VM's actual fleet a BTC/ETH-only 8× filter lowers the
result (+2228 → +2049): its two BTC/ETH pairs were selected because they already beat their costs,
which is the filter's job done per pair. The incubator's after-cost screen does the same for new
pairs. `minRiskFeeRatioBySymbol` exists for a per-market override; it is not set.

Found in passing: the local bot on 8787 (started 2026-09-22 00:51, older code) rewrote the local
`data/config.json` from memory, reverting the exit to 75% from 1R. The VM is unaffected; `exits.ts`
now takes `PAPER=file` so tests cannot silently use a stale local config.

## 22. Memory caps after a runaway script froze the VM

On 2026-09-22 the incubator's screen (slice 5) drove the VM to 98% of 24 GB from 16:10 UTC until SSH
stopped answering; it needed a forced reboot. The kernel log shows the same failure killed the
library sweep the day before (22 GB resident). The script responsible was not reproduced on BTCUSD
or SOLUSD, nor PO3 on all 35 markets; it is one of slice 5's scripts on one market. Rather than hunt
through 160 × 36 runs, the damage is now bounded: each Pine worker has a 1.5 GB heap cap
(`VNEDGE_WORKER_HEAP_MB`; the job fails, the worker is replaced, and the log names the script and
market), the daily job's main thread 3 GB, the job 8 GB (`MemoryMax`), the bot 10 GB. Verified with a
deliberately runaway script: stopped in 0.5 s at 409 MB, the next job ran normally.

## 23. strategy() scripts now trade; a 626-script survey says the edge is on 1h and 4h, not 15m

**Strategy support.** Scripts that signal only through `strategy.entry`/`strategy.exit` produced
nothing before: the bot read alerts and chart markers only. The runtime keeps a trade ledger, so the
worker reports each fill as `STRATEGY entry|exit side @ price` at the bar it filled on (by default
the bar after the signal, so nothing can be acted on before the order could exist) and the extractor
turns those into events. Verified against a crossover strategy: every entry lands on or after its
signal bar.

**Imported** (all disabled): 470 open-source strategies from TradingView's strategies listing, 16
from the scalpingcrypto tag, 7 from the "swing crypto" search; AlgoAlpha's 143 were already present.
Library: 2,489 scripts. Note TradingView's `/api/v1/scripts` ignores `q=`, so an earlier "crypto
search" import was really the default listing; the search and tag pages only render their first page.

**Survey** (`npm run survey`), 626 scripts × 5m/15m/1h/4h × 5 markets, live exit rules, exits on 1m
(5m/15m) or 15m (1h/4h), GST, Scalper Offer, 10 bps stress, 8 windows: 8,677 runs, 1,668 skipped as
silent. 22 script×timeframe passed — **none on 5m or 15m; 9 on 1h, 13 on 4h**. At the fast
timeframes costs consume the edge; the current 15m fleet is the exception, not the rule.

**Stage 2** took those 22 to all 36 liquid markets (633 runs): 119 pairs pass the screen's terms,
capped to 5 markets per script×timeframe → 64 candidates, now in the shadow book (81 of 100 slots,
19 free). Mostly breakouts: momentum bands, inside day, Donchian, Keltner. None trades live: the
promotion gate needs ≥30 shadow trades over ≥14 days first.

**Also fixed:** `request.security(SYM;HEIKINASHI)` is served by transforming the same candles (other
chart types are refused); the shadow runner runs each pair on its own timeframe.

## 24. Target policy reviewed: the wide 6R target is not the problem, and closer targets are worse

An external review of the live trades was checked line by line against the VM database and every
figure held: 32 of 33 positions used ATR-fallback levels, the fallback targets are 2R/4R/6R with
0%/0%/100% allocation, and of 15 stop-outs 10 never passed +0.25R, 11 never +0.5R and none reached
+1R. AKE's TP3 really was 17.4% away.

**Why the fallback rate is so high — not an extraction bug.** Of 49 recent entry signals, 47 arrive
as chart shapes (`plotshape BUY`) or alertcondition text, neither of which can carry a price. The
two scripts that publish structured alerts do supply SL/TP and are read as script levels. Deriving
stops from plotted series (a SuperTrend line, a channel edge) is the open possibility here.

**What the market offers** (`npm run targets`, 296 fleet entries, raw 1m paths to the stop or 24 h):
61% reach +1R, 44% +2R, 21% +6R; median best +1.43R. Of 218 stop-outs, 28% never reached +0.25R
(entry quality) and 72% were ahead and gave it back (exit policy). Reachability varies by pair:
dynamic-trend-bands on FILUSD reaches 6R on 36% of entries (median peak 3.49R), while
smart-money-breakout on AKEUSD reaches it on 8% (median peak 0.74R).

**Closer targets tested per pair** (`PAIRS=1 npm run exitlab`, same paths, full costs): every one of
the eight pairs keeps the 6R cap. Fleet 107.1R against 57.2R at a 2R target, 66.5R at 3R, 81.1R at
4R; half off at 1R/2R/3R all lose too. The wide target is not what costs money — it is rarely hit
either way, and the trail is what ends these trades.

**UI corrected** (the review's last point): targets carrying no contracts are dimmed rather than
struck through, the active target shows its distance in percent, and each position states where the
stop moves to +0.5R and where the trail starts.

## 25. Tested: stops taken from the lines a script draws. Worse than the ATR fallback; not adopted.

Decision 24 left one way to get real levels out of scripts that signal through shapes: use the
series they plot. `selectTrail` already identifies the line that behaves like a trailing stop, so
`npm run plotstops` sets the stop from it (targets recomputed from the new risk) and compares.

| stop source | 9 live pairs | 17-pair set | PF (17) | windows (17) | used on |
|---|---|---|---|---|---|
| ATR fallback (live) | +2199 | **+2035** | 1.27 | 7/8 | – |
| plotted line | +1236 | +756 | 1.10 | 5/8 | 28% |
| plotted line + 0.25 ATR | +1376 | +1351 | 1.18 | 6/8 | 28% |
| line if 0.3–4 ATR away | +2275 | +1872 | 1.24 | 6/8 | 16% |
| line if 0.5–2 ATR away | — | +1900 | 1.25 | 7/8 | 8% |

Raw lines sit a median 2.3–4.7 ATR from price: too wide, so position size shrinks and the edge with
it. Filtering to a sane distance only helps by doing nothing on most entries, and the 3.5% gain on
the nine live pairs (which were selected on overlapping data) did not replicate on seventeen. Only
4 of 9 scanners draw a usable line at all. The ATR fallback stays.

## 26. Portfolio replay: on one shared account, the wide targets still win

Every earlier target test measured pairs on separate purses and reported R, which cannot see the one
cost a distant target plausibly has: margin held by a waiting trade is margin the next signal cannot
use. `npm run portfolio` replays all nine live pairs through the real paper engine on ONE account —
same sizing, margin, position cap, fees, Scalper Offer and exit rules — and compares in dollars.

| target policy | entries | blocked | net $ | PF | max DD |
|---|---|---|---|---|---|
| live: 2/4/6 R | 301 | 148 | **+8239** | 2.09 | 19.0% |
| 2/3/4 R | 306 | 143 | +6151 | 1.97 | 18.7% |
| 1.5/3/4.5 R | 304 | 145 | +6186 | 1.95 | 19.1% |
| 1/2/3 R | 306 | 143 | +3705 | 1.76 | 16.9% |
| live targets, half off at TP1 | 302 | 147 | +4642 | 1.87 | 17.3% |

Closer targets free capacity for five more entries out of ~450 and cost 25–70% of the profit: the
trail returns the margin long before the target would. (Absolute returns are flattered — this span
overlaps fleet selection — but the comparison between policies is like for like.)

This also closes the audit's "shared-capital portfolio replay" gap (decision 18, finding 12). The
UI now calls TP3 a ceiling rather than a target.

## 27. Tested: exit when a profitable trade turns. The first result was a tooling bug; the rule loses.

The idea: keep the far ceiling while a trade is working, and take what is there when it stops — a
stall (no new high for N minutes), a fade (the trail keeps more of the peak with age), or a reversal
(the trade's own timeframe turns against it).

Stall and fade lost immediately (−2 to −22R against live's +110R). The reversal rule looked strong:
`reverse above 1R` scored +119.9R, beat live in 7 of 8 windows and held across trend lengths 10/20/50
and trigger levels 0.5R–2R. It was implemented in full (`paper.trendExit`, checked in the backtest,
both books and the live engine, with tests) and then failed every faithful test:

| test | live | trend exit above 1R |
|---|---|---|
| exit lab, trend aligned to each trade's fill (the original) | 110.0R | **+119.9R** |
| exit lab, calendar-aligned 15m closes (corrected) | 110.0R | 102.7R |
| per-pair backtest, 1m checks as live | +2084 | +1907 |
| portfolio replay, one shared account | +7061 | +6054 |

**The bug.** The lab built its "15m closes" by sampling every 15th minute *from each trade's fill*,
so the trend was aligned to the entry rather than to the exchange's bars. That encodes entry timing
into the signal, which the live engine cannot see. Corrected, the lab agrees with the engine.

**A fidelity gap this surfaced and fixed:** the backtest checked the trend once per signal bar while
the live engine checks every minute, so the two disagreed about the same rule. The backtest now
checks on the 1m path, as decision 13 requires of every exit.

The code stays in place, config-gated and disabled (`paper.trendExit.enabled: false`), so the rule
can be re-tested on live trades later with one setting. Capturing a reversal is already covered: an
opposite signal from the scanner closes the position, and those exits measure as neutral (decision 15).

## 28. Honesty audit after the lab bug, and a fresh re-evaluation of the fleet

**What the bug touched.** The exit lab's trend series (decision 27) aligned "15m closes" to each
trade's fill instead of to exchange bars. It was used by exactly one study — the reversal exit — and
that rule was rejected once corrected. Every other exit decision (13, 14, 15, 19, 24, 26) rests on
the full engine (`exits.ts`, `deepdive.ts`, `portfolio.ts`), which replays real bars through the same
code the bot trades with. An earlier lab flaw (a stop raised and hit inside one minute) was found and
fixed the same way, and decision 14's rule was re-confirmed in the engine afterwards.

**What that leaves weak, stated plainly:** fleet selection overlaps the data it was selected on, so
absolute backtest returns are flattered; the live sample is 33 trades and was reset to zero on
2026-09-23; and the exit rules were chosen from a menu of ~20 candidates, which favours whichever
fitted this span best. The live review remains the only unbiased test.

**Fresh re-evaluation** of the nine live pairs with the current code (1m exits, GST, Scalper Offer,
10 bps stress, 8 windows):

| verdict | pairs |
|---|---|
| KEEP | high-volume-breakout ZECUSD (PF 7.05), dynamic-trend-bands FILUSD (3.70), kinetic-momentum PIEVERSEUSD (2.18) |
| WEAK but positive after the stress | kinetic-momentum UNIUSD, smart-swing-vwap AKEUSD, smart-money-breakout AKEUSD |
| removed | smart-swing-vwap EVAAUSD (PF 1.06, 3/8 windows); supertrend-cluster BTCUSD (16 trades, −67 at 10 bps); liquidity-trail-matrix ETHUSD |

`liquidity-trail-matrix` fails every run with `Index 30 is out of bounds, array size is 30` — on both
symbols, at every history length, and on every code version bisected, so it is the script meeting
PineTS, not a regression here. It has been producing nothing in the live fleet; it is disabled until
someone reads the 1,300-line source properly.

**Also found:** the VM had been changed to 336 scanners on a top-20 universe (~6,700 runs per bar
close against 6 workers). Jobs were expiring after 2.7 hours in the queue, so almost nothing traded:
4 trades in 12 hours. Restored to the tested fleet, now six pairs.

## 29. The promotion gate judges a scanner across its markets, not one market at a time

The gate asked each shadow pair for 30 trades inside 45 days. One market produces 0.35 trades a day,
so on 15m that sample lands at about day 35, on 1h at day 175, and on 4h never: 65 of the 100 shadow
pairs were on a path to retirement without a verdict, while 54 screened candidates waited for a slot
behind them. A gate that cannot be reached is not a standard, it is a stall.

What is being judged is a scanner, not the market it happened to be admitted on, so the evidence is
now pooled per scanner × timeframe. Five markets reach the same sample five times sooner, and the
pooled result is the better question anyway: a rule that works on one market and fails on four is
luck, and the per-pair gate could not see that.

Three things keep pooling honest:

- **Breadth.** At least half of the markets with enough trades to judge must be net positive, so a
  cohort carried by one lucky market brews instead of being promoted.
- **Whole-cohort retirement.** A cohort that fails on a full pooled sample retires together, which
  frees its slots for the queue instead of dribbling out one market at a time.
- **Per-market promotion.** Only the best markets of a passing cohort are proposed — at most
  `promote.maxPerWeek`, since nothing more can be approved in a week anyway. The rest keep trading
  as evidence.

Cohort size and the retirement clock now follow the timeframe, because the rates differ by an order
of magnitude. Measured across 28 markets on the 36 scripts that survived the library sweep: 0.77
trades per market-day on 15m, 0.28 on 1h, 0.064 on 4h. So 15m is admitted on 5 markets and reaches
30 pooled trades in about 8 days; 1h on 8 markets, about 14 days; 4h on 12 markets, about 39 days,
with the retirement clock extended to 60 days on 1h and 90 on 4h. `minDays` still holds at 14, so
nothing is promoted on a week of luck however fast the trades arrive.

Admission fills cohorts rather than single pairs: cohorts already brewing are topped up first, and a
new cohort only starts when enough of its markets passed the screen to fill `minCohortMarkets` slots.
The 17 single-market cohorts already in the book are left alone — they are topped up when their
other markets pass a screen, and otherwise retire on their own clock.

`gate.pool: 'pair'` restores the old behaviour exactly, and the old path is still covered by tests.

**Revisit if** the 100 shadow slots stop being the binding constraint, or if pooled cohorts start
passing the gate and then failing live — which would mean the market, not the scanner, was the thing
that mattered.

## 30. Scripts that cannot run here are quarantined instead of retried every night

The library is 2,588 TradingView scripts and a large minority cannot execute on this stack at all.
Nothing recorded that, so every night's screen paid for them again: 1,516 worker crashes in one 24h
window from scripts asking for SPY, VIX, NDX, AAPL or open-interest series that Delta does not list,
and — the expensive half — 213 scripts that loop until the 120-second worker timeout, each one
burning two minutes of a worker to produce nothing.

A failure that will repeat now quarantines the script: it needs a market Delta does not list, it does
not transpile, its Pine version is unsupported, its source was never published, it never finishes, or
it hits a PineTS runtime gap. Two different markets have to fail before the script is quarantined,
because one market can simply have bad data, and any successful run clears the record.

Quarantine is not a judgement on the strategy, so the reason is stored: `npm run health -- release
"runtime gap"` re-opens the 84 scripts blocked by missing PineTS features the day the runtime gains
them. Seeding from the compatibility report already on disk quarantined 427 scripts — 213 that hang,
109 that do not transpile or are missing their source, 84 runtime gaps and 21 unsupported versions.

**Revisit if** PineTS is upgraded (release the runtime gaps), or if a quarantined script is wanted
live anyway — nothing stops it being released by name.

## 31. The stop-loss cap moves to 3%, and markets too coarse to size are kept out

Two of the nine live pairs are on AKEUSD, and in 36 hours every signal either one produced was
rejected with "stop too wide for the 2% max stop-loss cap". The cap is a share of equity, not of
price: one AKEUSD contract is 10,000 tokens, so at a 1.5×ATR stop it risks 10.89 against a budget of
23.08 on a 1,154 account. Any stop wider than about twice the ATR stop — which a structure-based stop
on a volatile alt often is — cannot be taken at all.

Backtested over 125 days across the fleet's scanners and markets, 5,051 trades:

| cap | trades | total R | net $ | at 10 bps |
|---|---|---|---|---|
| 2% | 5,051 | −41.0 | 489 | −8,149 |
| **3%** | **5,069** | **−32.2** | 1,916 | −10,572 |
| 4% | 5,075 | −32.5 | 2,709 | −12,190 |
| 6% | 5,080 | −33.6 | 3,895 | −13,134 |

3% is the best of them and the gain decays above it: +18 trades and +8.8R, every one of them on
AKEUSD. The dollar column rises faster than R because a looser cap also lets existing trades size up,
and the stress column worsens as it does — those extra dollars are slippage, not edge, so the R
column is the one that counts. The cap is now 3%.

That is the smaller half. The real problem is that contracts are indivisible: one AKEUSD contract is
95% of the risk budget, so the account can take one contract or none and position sizing expresses
nothing. A market like that is not a strategy question, it is an account-size question, and it should
never have entered the fleet. The daily screen now measures `contractRiskShare` — one contract's risk
at the ATR stop as a share of the risk budget — and skips any market above `maxContractRiskShare`
(0.5). `npm run tradeable` shows the same figure for every market, with the equity each one needs.

**Revisit if** the account grows: AKEUSD becomes sizeable again at roughly 20,000 of equity, and the
check is against live equity, so it re-admits itself.
