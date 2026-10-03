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

## 32. The stop sets the ceiling on leverage, so liquidation can never arrive first

A live MUBARAKUSD long closed at −0.88R with the exit reason `liquidation`, having never traded at
its stop. Entry 0.05473, stop 0.05292 — 3.31% away. The signal scored 54, `leverageForScore` turned
that into 29.2×, and under isolated margin the liquidation price sits `1/leverage − maintenance`
from entry: 2.93%. The stop was behind the liquidation price and could never be reached.

Leverage was being chosen from the signal's quality alone, as if the stop did not exist. It does:
the stop is the whole risk model, and a position that dies at the exchange's price instead of ours
has no R. Leverage is now capped at `1 / (stop% × 1.25 + maintenance%)` — the stop distance plus a
quarter of it as headroom — so the stop is always reached first. On that trade, 29.2× becomes 21.6×
and liquidation moves to 4.13%, comfortably behind the 3.31% stop. Posting more margin is what buys
the room, so the cap costs margin, not edge.

Two existing tests had encoded the old behaviour — one asserted that 50× against a 2% stop liquidates
at 98.5, inside the stop, and another that 200× is rejected for posting less than maintenance margin.
Both now assert the invariant instead: liquidation sits beyond the stop, and the sizing cap gets
there before the maintenance-margin guard does.

**Revisit if** a venue is added whose margin model is not isolated, or if the buffer proves too thin
on a gap-prone market — it is one number, `LIQ_STOP_BUFFER`.

## 33. Tested: a trend filter on entries. Rejected as a default; one scanner is a real exception

Nothing in the system asked whether a trade agreed with the trend, so the gate was built properly —
one rule in `logic.ts`, called by the live engine, the shadow book and `runBacktest`, with a
per-scanner mode and an optional higher timeframe that only ever reads a bucket that had already
closed — and then measured over the fleet's eight scanners × 28 markets × 125 days of 15m.

| gate | trades | avg R | at 10 bps |
|---|---|---|---|
| none | 20,633 | **−0.030** | −42,770 |
| follow EMA50, own timeframe | 16,059 | −0.060 | −45,043 |
| follow EMA200, own timeframe | 14,199 | −0.049 | −38,860 |
| follow EMA50 on 1h | 10,827 | −0.059 | −31,564 |
| follow EMA50 on 4h | 6,328 | −0.051 | −18,269 |
| fade EMA50, own timeframe | 4,667 | +0.090 | — |

**Following the trend is worse in every variant**, on the same timeframe and on higher ones, and it
costs between a fifth and two thirds of all trades to achieve that. The higher-timeframe versions
look better per trade only because they destroy the sample: `dynamic-trend-bands` keeps 32 trades on
one market out of 2,756 on 28, so its apparent improvement is noise wearing a suit.

The fade row is not what it appears either. Its +0.090R is one scanner: `structure-anchored-vwap`
contributes +540R of the +420R total, and excluding it the rest is −0.031R, exactly the ungated
number. That scanner takes 80% of its entries against the EMA, which is what a structure-and-VWAP
pullback scanner is supposed to do.

And even there the gain is not profit. Fading improves its average from +0.547R to +0.679R and its
per-market result on **28 of 28 markets**, but total R is flat — 542R against 540R — because the 195
entries it removes were worth +0.011R each. What it buys is the same result from 20% fewer trades:
less fee exposure, fewer position slots, slightly better stress (+9,384 → +9,630). Worth having
where capacity is the binding constraint, which on this account it is.

So: `paper.trendGate.enabled` stays **false**. The mechanism stays, because it is now built and
tested, and `scanners.structure-anchored-vwap.trendGate: 'fade'` is the one setting the evidence
supports.

One tooling fix came out of this: the survey skipped a script after two silent markets, which under
a gate measures the gate rather than the script — the fade variant first returned 11 rows instead of
224. The skip is now disabled whenever a gate is on.

**Revisit if** a scanner is added whose entries are explicitly continuation-based, or if the fleet
ever becomes profitable enough that filtering for quality beats filtering for count.

## 34. Per-market exits: the mechanism is built, the evidence says use it for exceptions only

Reconstructing 96 shadow trades minute by minute confirmed what the trade rows suggested: **40 of the
51 stopped trades (78%) had been in profit before they died.** Most were barely green — 31% peaked
under 0.25R — but 16 of them had reached 0.5R or more and still lost a full R. Across all 96 trades,
55% reached +0.5R and 30% of those ended at −1R, while of the 33 that reached +1R only two were
stopped, because that is where the floor arms. The protection works; it starts too late. The total
peak available was 81.8R against −18.9R realised, and winners kept a median 58% of their peak.

Since how far a trade runs before it turns is a property of the market, `paper.exitBySymbol` now
overrides `floorAtR`, `floorKeepR`, `trailAfterR`, `trailGiveBackPct`, `trailAtrMult`, `fallbackRR`
and `tpSplit` per market, resolved once when the position opens so a configuration change cannot move
a stop that is already protecting money.

Then it was fitted honestly — eight policies per market, fitted on the first half of 12,000 bars and
scored on the second:

- **Seven of twelve markets produced a curve fit**: the best in-sample policy lost out of sample.
- The four that "passed" are what eight candidates × twelve markets produces by chance.

Pooled — one comparison per policy across every market, out of sample, 1,828 trades:

| policy | out of sample | vs current |
|---|---|---|
| **trail from +1R** | **−11.4R** | **+13.8R** |
| lock 0.5R at 0.75R | −24.2R | +1.0R |
| current (trail from 1.5R) | −25.2R | — |
| break even at +0.5R | −69.3R | −44.1R |

**Every break-even-at-0.5R variant is far worse.** Arming break-even early kills more trades on noise
than it saves from reversals — which is the same lesson as decision 8, arrived at from the other
side. What works is not stopping earlier but *ratcheting* earlier: `trailAfterR` moves from 1.5 to
**1.0**, better on 10 of 12 markets out of sample and pointing the same way in sample (+42.9R).

The two markets it hurts are the two profitable ones — UNIUSD (−12.0R) and AKEUSD (−4.2R), where the
earlier trail cuts winners short. They keep 1.5 through `exitBySymbol`. That is what the per-market
mechanism is for: the exceptions the evidence identifies, not a policy fitted market by market.

**Revisit if** a market's exemption stops paying, or if the fleet's peak-to-realised gap (81.8R
against −18.9R) closes enough that giving back less matters more than staying in.

## 35. Trades record the path they took, not only where they ended

A closed row says a trade lost 1R at 03:27 and nothing else. It cannot answer the first question
anyone asks of a loss — *was it in profit before it died* — and answering it meant re-downloading
candles and replaying them, which is how decision 34 was measured and is far too slow to do casually.
When the live book was reset mid-review, that history went with it.

The engine now writes `position_path` as a trade runs: a sample a minute plus a row for every level
event — a target touched, the stop moved by the floor or the trail, the exit — each with the price,
the result in R at that moment, and the stop as it then stood. The peak and worst excursion are also
kept on the position itself (`peak_r`, `peak_at`, `worst_r`, `worst_at`), so the common question
needs no replay at all.

`worst_r` is the worst result *observed while sampling*, not an assumption about the ticks between
samples: a trade that runs up immediately and never comes back has a positive worst, and that is what
it should say.

Read it with `npm run forensics` for the last trades, or `npm run forensics -- <id>` for one trade's
whole path, and over the API at `/api/positions/:id/path`.

**Revisit if** the sampling cost shows up on a busy book — it is one row a minute per open position,
about 1,500 rows a day at the current fleet, and the interval is one constant.

## 36. Smarter trailing: give back less as a trade grows, and tighten when it stalls

The flat trail treats a 1R trade and a 5R trade identically, which is backwards — the small one needs
room to become the large one, and the large one is worth protecting. And a trade that has stopped
making new highs is usually finished: across the 96 reconstructed trades the median stopped one sat
**44 minutes** between its peak and its stop.

Two parameters, both off by default: `trailSteps` gives back less of the peak as the peak grows, and
`trailStall` multiplies the give-back once a trade has gone `minutes` without a new high. Fourteen
policies fitted on the first half of 12,000 bars per market and scored on the second, 1,839 trades:

| policy | out of sample | vs current |
|---|---|---|
| **steps 2R/4R + stall 45m** | **+2.6R** | **+30.9R** |
| steps 1.5R/3R | +1.5R | +29.8R |
| steps 2R/4R | −2.2R | +26.1R |
| stall 60m | −9.0R | +19.2R |
| trail from +1R (decision 34) | −12.6R | +15.7R |
| current | −28.3R | — |
| **ATR trail ×2.5** | **−48.0R** | **−19.7R** |

Stepping the give-back is worth twice what moving the arming point was, the two compose, and the
combination is the first exit policy in this repo to come out **positive out of sample**. It is
better on **9 of 12 markets** and points the same way in sample (+88.6R), so it is not a split
artifact.

The ATR trail is last again, which is decision 7 reproduced on a better measurement: distance
measured in volatility rather than in the trade's own progress does not work here.

Adopted: `trailSteps: [[2, 30], [4, 20]]` with `trailStall: { minutes: 45, factor: 0.6 }` — give back
40% below 2R, 30% to 4R, 20% above, and 40% less than that once a trade has been flat for 45 minutes.
The three markets it hurts are the three profitable ones — AKEUSD, UNIUSD, ZECUSD — where tightening
cuts winners short; they keep the old policy through `exitBySymbol`, which is the second time that
mechanism has earned its place by holding the exceptions rather than fitting every market.

**Revisit if** the exempt markets stop being exceptional, or if a forward sample disagrees with the
+0.017R per trade this predicts.

## 37. Tested: the learned model as an entry filter. It buys R per trade by throwing away total R

The Learn page's per-scanner logistic regression has never been wired to anything (`ml.minProb: 0`),
and its training data was mostly scripts the fleet does not trade — `structure-anchored-vwap` had two
samples. So it was measured the way everything else here is: a model trained on the first half of
each surviving scanner's history, applied as an entry filter to the second half.

No threshold improves total R anywhere. Where it improves R per trade it does so by discarding
trades, which is not the same thing:

- `smart-money-breakout` 1h: +0.126R over 386 trades becomes +0.187R at a 0.6 threshold — but keeps
  23% of them, so 49R becomes 16R.
- `kinetic-momentum` 1h: +0.074R becomes +0.156R at 0.55, keeping 38%: 21R becomes 17R.
- `high-volume-breakout` 1h: filtering at all destroys it, +0.078R to −0.008R.
- `structure-anchored-vwap`, the one scanner with a decisive edge: every threshold keeps essentially
  every trade and changes nothing. The model has no opinion about it.

That is the trap the harness was built to catch, and it is the same shape as decision 33's fade
result: a filter that doubles R per trade while dropping most of them has not made money.

`ml.minProb` stays 0 and `useAsScore` stays false. The model is a readout, not a gate. Note that
turning `useAsScore` on would put the model in charge of leverage — the path that liquidated
MUBARAKUSD before decision 32 capped it.

**Revisit if** the surviving fleet runs long enough to train on its own live trades rather than on
backtests of scripts it does not trade.

## 38. Exits can now differ per scanner. Tested with target ladders: none of them beats riding to TP3

Two things, one of which worked.

**The mechanism.** Exit rules now resolve in three layers, narrowest last: the fleet's policy, then
`paper.exitBySymbol` for the market, then `scanners.<id>.exit` for the scanner. A scanner names only
what it wants to differ and everything else still comes from the fleet, resolved once when the
position opens and carried on the position. A breakout scanner that runs and a mean-reversion scanner
that stalls at 1R have no reason to share a trail, and now they need not.

**The test.** The obvious first use was the target ladder, because today the whole position rides to
TP3 — `tpSplit [0, 0, 1]` at 2/4/6R — so TP1 and TP2 are drawn on every chart and can never fill.
Decision 9 tested partial profit at TP1 and decisions 24 and 26 tested closer targets, but never the
two together, which is the combination that would actually capture something.

Seven ladders, five scanners, twelve markets, fitted on the first half of 12,000 bars and scored on
the second — 2,247 trades:

| ladder | out of sample | vs current | target exits |
|---|---|---|---|
| **current: 2/4/6, all at TP3** | **+104.6R** | — | 57 / 2,247 |
| split 2/4/6 at 40/30/30 | +50.0R | −54.7R | 57 |
| runner 1/3/6 at 30/20/50 | +34.8R | −69.9R | 57 |
| half at 1R, rest at 4R | +3.3R | −101.3R | 124 |
| close 1/2/4 at 40/30/30 | −6.7R | −111.3R | 124 |
| close 1/2/3 at 50/25/25 | −29.7R | −134.4R | 191 |

Every ladder is worse, for **every one of the five scanners**, with no exception and a monotone
ordering: the closer the targets and the more taken off early, the worse the result. Per-scanner
ladders do not rescue the idea — the answer is the same everywhere, which is itself informative.

The reason is in the last column. Targets fire on **57 of 2,247 trades**; the trail ends nearly
everything. Moving the targets closer converts trail exits into target exits — 191 of them in the
worst case — and each conversion costs more than it captures, because it caps a trade that the trail
would have carried further.

So: nothing is enabled. `tpSplit` stays `[0, 0, 1]`, and TP1 and TP2 remain markers rather than
targets — the dashboard already greys them, which is honest.

**Revisit if** a scanner joins the fleet whose trades reach 2R far more often than these do, since
the whole result rests on how rarely targets are reached at all.

## 39. Tested: closing a small winner that stalls below the floor. It loses, and the owner's hand does not generalise

On 25 September thirteen trades were closed by hand for **+5.62R**, at +0.43R each and a median 54%
of their peak, almost all in the 0.3R–1R band where nothing in the system acts: the floor arms at
+1R, so a trade that peaks at half an R and turns gives back the half and the full R behind it. Nine
trades did exactly that and cost −8.76R. The obvious inference is that the owner was applying a rule
the bot lacks, so it was written as one — `earlyStall`: once the peak sits between `minR` and `maxR`
and no new high has come for `minutes`, close at market.

Five settings, against the policy actually deployed, fitted on the first half of 12,000 bars per
market and scored on the second — 1,813 trades:

| policy | out of sample | vs deployed |
|---|---|---|
| **deployed, no early stall** | **+4.1R** | — |
| stall 0.5R / 60m | −8.7R | −12.8R |
| stall 0.3R / 45m | −23.4R | −27.5R |
| stall 0.5R / 30m | −37.3R | −41.4R |
| stall 0.3R / 30m | −41.2R | −45.3R |
| stall 0.2R / 20m | −59.1R | −63.2R |

Every variant is worse, monotonically: the earlier and more eagerly the band is touched, the more it
costs. Per market the best variant helps 5 of 12 and hurts 7, which is a coin flip, and it changes
only 8 trades in 1,813 — it is not even doing much, and what it does do is negative.

This is the third time the sub-1R band has been tested and the third rejection: break even at +0.5R
was the worst of fourteen policies in decision 36, the trend-flip exit lost in decision 27, and now
the stall. The band is where trades are most likely to still be going somewhere, and acting there
trades a small certain gain for the tail that pays for everything.

Which leaves an honest gap. The thirteen manual closes were real and profitable, and a mechanical
reading of them is not. Either the day was kind, or the judgement used something the rule cannot see
— and thirteen samples on one day cannot distinguish those. The `position_path` recorder from
decision 35 is now running, so the next attempt should characterise what those exits actually looked
like rather than guessing parameters for them.

`earlyStall` stays off. The mechanism remains, because it costs nothing and the question will come
back.

**Revisit if** a month of recorded paths shows manual exits clustering somewhere a rule could reach.

## 40. 1m is enough: the most that finer data could be worth is 0.006R a trade

Peaks were never the question — the trail already reads each bar's high, so an intra-minute spike to
+2R raises the peak and ratchets the stop exactly as a tick feed would, and levels crossed inside a
minute fill at the level. The only thing a 1m bar cannot know is the **order** of what happened
inside it, and `applyBar` resolves that pessimistically: a minute that reaches both the stop and a
target books the stop.

So the ceiling was measured directly, by resolving the same trades optimistically (`barOrder:
'target-first'`) — the best that perfect intra-minute knowledge could ever do:

| reading | out of sample | per trade |
|---|---|---|
| pessimistic (deployed) | +6.6R | — |
| optimistic | +17.3R | — |
| **gap** | **+10.7R over 1,857 trades** | **+0.0057R** |

Six thousandths of an R, and only if every ambiguous minute fell our way; the true value is about
half that. Fees are 0.066R a trade, eleven times larger. The fleet change is 0.24R, forty times
larger. Nine of the twelve markets show a gap of exactly zero — no trade ever reached both levels in
the same minute — and today's 33 live trades replay identically under both readings.

Tape mode is therefore not worth building for accuracy. It would change how every fill is modelled,
cannot be validated against history, and is chasing a rounding error. Fees cannot be helped by it
either: the fee in R is 0.118% divided by the stop width, a function of size and stop distance, not
of how closely the price is watched.

**The tooling fix this exposed.** `replaytargets` hand-rolled its own copy of the exit policy and had
gone two decisions stale — it still modelled the trail as 60% of the peak from 1.5R. It is replaced
by `npm run replay`, which drives `applyBar` itself, so the rules it measures are the rules that
trade. Its first honest run, on today's 33 real trades:

| policy | total | per trade |
|---|---|---|
| before 24 September | −1.34R | −0.041R |
| trail from 1R (decision 34) | −0.33R | −0.010R |
| **deployed now (decision 36)** | **+1.58R** | **+0.048R** |
| deployed, read optimistically | +1.58R | +0.048R |

Thirteen of the 33 end better under the deployed policy and none end worse, all of them trades the
trail carried further before stopping them out at break even. What the account actually made today —
**+0.74R**, including thirteen closes made by hand — sits between the old policy and the new one.

**Revisit if** a venue is added with materially different intra-minute behaviour, or if the ambiguous
share of bars rises above a few percent on markets that matter.

## 41. The weekend block is removed: it refused 22% of opportunities for no measured reason

`risk.regime.noWeekend` rejected every entry on Saturday and Sunday UTC, ahead of every other check.
It fired 35 times on 26 September — the first weekend since the fleet grew to 35 pairs — across six
scanners, and the live book sat empty all day while the shadow book, which does not pass the risk
gate, kept trading the same signals.

The rule was an equities-shaped assumption. Delta's perpetuals trade through the weekend, so the only
real argument for it is thinner books. 18,824 backtested trades across 12 markets, 8 scanners and 3
timeframes, split by the UTC day of entry:

| day | trades | avg R | | day | trades | avg R |
|---|---|---|---|---|---|---|
| Sat | 1,864 | **+0.009** | | Wed | 3,042 | +0.039 |
| Sun | 2,354 | **−0.010** | | Thu | 2,869 | +0.046 |
| Mon | 3,131 | **−0.085** | | Fri | 2,753 | +0.024 |
| Tue | 2,811 | −0.048 | | | | |

**Weekend −0.001R against weekday −0.006R.** The weekend is marginally better, both are
indistinguishable from zero, and the block refuses **4,218 trades — 22% of all opportunities** — to
avoid 6.0R, which at a thousandth of an R per trade is noise. On the fleet's best scanner,
`structure-anchored-vwap`, weekends are +0.574R against +0.598R on weekdays.

The thin-book argument was tested separately, since the backtest charges the same 2 bps every day: at
10 bps the weekend is **−0.106R against the weekday's −0.103R**. Weekend trades do not degrade faster
under cost, so that defence fails too.

`noWeekend` is now false. The one real pattern in that table is that **Monday is the worst day by a
distance** (−0.085R, −265R) — which is not acted on, because choosing the worst of seven days after
the fact is how curve fits are made. It would need its own halves test first.

**Revisit if** a venue is added that genuinely closes, or if live weekend fills show slippage the
backtest does not model.

## 42. The stop fallback moves to 1.0×ATR — the same money from a quarter fewer trades

96% of trades take their stop from the ATR fallback, because scripts rarely publish one, and the 4%
that do are worse on both counts: −0.349R against −0.157R, stopped out 64% of the time against 49%.
That is decision 25 confirmed on 320 live trades rather than on backtests. The fallback is not a
stopgap, it is the stop policy, and its multiplier had never been tested.

Eight widths, fitted on the first half of 12,000 bars per market and scored on the second:

| stop | out of sample R | out $ | trades |
|---|---|---|---|
| **1.0 ATR** | **+9.8R** | **$850** | **1,396** |
| 1.5 ATR (previous) | −6.5R | $853 | 1,893 |
| 1.25 ATR | −17.4R | $612 | 1,680 |
| 2.0 ATR | −85.4R | $194 | 2,163 |
| 2.5 ATR | −100.6R | −$469 | 2,210 |
| 3.0 ATR | −87.2R | −$448 | 2,148 |

Wider is decisively worse, monotonically, and past 2.5 ATR it loses money outright. Tighter is a
**tie in money — $850 against $853** — and the R column flatters it: a tighter stop is more often
refused by the fee filter, so it takes 26% fewer trades and the survivors are the better ones.

It is adopted anyway, as an efficiency change rather than an edge one. The same money from **26%
fewer trades** ($0.61 each against $0.45) matters because capacity, not signal supply, is what binds
this account: 65% of signals on the 33-pair fleet were rejected for margin or the position cap.
Better in dollars on 8 of the 12 markets.

Four markets prefer the old width — AKEUSD, FILUSD, DOGEUSD and UNIUSD, three of which are the
profitable ones again. They are **not** given exceptions: `exitBySymbol` does not carry
`fallbackAtrSl`, and per-market fitting produced curve fits in seven of twelve markets last time it
was tried (decision 34). They are a watch item, not a setting.

What this does not do is fix stop-outs. Half of all trades still hit the stop and 71% of those were
in profit first, with a median peak of +0.25R. Every attempt to act on that band — break even at
+0.5R, the trend flip, the stall rule — has lost money. The stop is where entry quality shows up;
it cannot repair the entry.

**Revisit if** the fee filter changes, since the two interact directly, or if the four exception
markets keep diverging once there is forward evidence.

## 43. Per-scanner stop widths, for the one scanner the evidence supports

Decision 42 set the fallback to 1.0×ATR for everything. Asking the same question per market and per
scanner gave three answers, only one of which is worth acting on.

**Per market: actively harmful.** Fitting the best width to each market in the first half and running
it in the second gives **$137**, against **$850** for one width everywhere. In-sample fitting picks
3.0 ATR on four markets and those choices collapse out of sample — ZECUSD falls from $698 to $243.
It beats the flat choice on 1 of 12 markets, which is chance.

**Per scanner: one real signal out of five.** Only `structure-anchored-vwap` holds its direction in
both halves; the other four flip sign between them, which is noise wearing a result:

| scanner | best stop | in sample | out of sample | |
|---|---|---|---|---|
| **structure-anchored-vwap** | **4.0 ATR** | **+235.8R** | **+221.0R** | consistent |
| smart-swing-vwap | 3.0 ATR | −83.5R | +16.1R | sign flip |
| kinetic-momentum | 2.0 ATR | −34.2R | +24.0R | sign flip |
| high-volume-breakout | 1.5 ATR | −40.1R | +18.2R | sign flip |
| smart-money-breakout | 1.25 ATR | −87.8R | +6.7R | sign flip |

For that scanner the curve plateaus rather than running to the edge of the grid — 3.0 ATR +211R, 4.0
+221R, 5.0 +231R, 6.0 +223R — so 4.0 is taken as the middle of a plateau rather than a peak.

**Why it helps is not what it looked like.** Its alerts carry no stop at all (0 of 54 entry signals
on SOLUSD), so every trade uses the fallback, and at 1.0×ATR **28 of those 54 signals were refused as
"stop too tight for fees"**. The wider stop is not exiting better; it is clearing the fee filter.

That suggested a neater global fix — widen a too-tight fallback to the narrowest fee-viable distance
instead of refusing the trade — and it is the worst policy measured: **−$657 against $887**, on 2,823
trades against 1,397. The trades the filter rejects are bad trades, and taking them at an honest
size loses money anyway. `widenStopToFee` is implemented, tested, and left off.

So: `fallbackAtrSl` joins the exit overrides, `onEntry` resolves the market's and the scanner's rules
before choosing levels, and `structure-anchored-vwap` gets 4.0×ATR. Everything else keeps 1.0.

**Revisit if** the scanner starts publishing stops the extractor can read, since the override only
touches the fallback, or if another scanner's width holds up in both halves.

## 44. The best scanner's backtest was reading fifty bars ahead

`structure-anchored-vwap` does not trade on its own signals in our runtime — its Buy/Sell shapes and
alerts have never fired in PineTS on any market or window tested. What trades under that name is a
rule in `scanners/rules.ts` that reads its swing-structure labels: `HL` long, `LH` short.

The worker records a label's **anchor** time — the pivot bar it points at — not the bar it was created
on. The script confirms a pivot only after **55 further bars** (`pivRInput = 55`). The rule shifted the
anchor by `delayBars: 5`. So the backtest entered fifty bars before the pivot could have been known,
at a price that was, by construction, near the swing.

Corrected on eight markets, 12,000 bars of 15m, 4×ATR stop:

| delay | trades | avg R | second half |
|---|---:|---:|---:|
| 5 | 433 | **+0.697R** | +0.647R |
| **55** | 435 | **+0.099R** | +0.211R |

The halves discipline did not catch this and could not: both halves leaked equally, so the "same sign
in both" test passed. Reading the script's confirmation parameters is the only check that finds it,
and it is now rule 4 of the measurement discipline (audit of 27 Sep, §5).

Live trading was **not** affected. The live path fires when a label first appears, which is when the
script itself knows about it. `auto-s-r-channels` anchors labels at the creation bar and is correct at
`delayBars: 0`. A second, smaller leak closed at the same time: a pivot whose confirming bars lay past
the end of the window was traded at the window's last bar; `confirmedBarTime` now returns null and the
trade is not taken.

**What this retracts.** The scanner was "81% of the fleet's edge" (decision 33) and the one scanner
whose stop width held up in both halves (decision 43). The corrected stop grid still prefers width —
4.0×ATR +65.5R out of sample against +28.1R at 1.0 — but in sample the agreement is now weak (+2.4R
against −10.9R), so the 4.0×ATR override stays on **moderate** evidence, not decisive. The fade
variant in decision 33 was measured on the leaked rule and is void. The scanner has zero forward trades
in either book, so nothing outside the backtest is known about it.

The corrected 28-market survey (audit appendix): 15m +0.007R a trade over 854 trades with a negative
second half; 1h +0.068R with a second half of exactly zero; 4h +0.186R with a second half of +0.046R
and 12 of 28 markets positive in both. Its fleet slot, BTCUSD 15m, is −0.33R then +0.13R. The
scanner stays in the fleet only because the fleet is frozen until the live sample exists (decision 4);
on this evidence it should be the first to go at the review.

**Revisit if** the 4h shadow cohort returns a verdict.

## 45. Scripts read as indicators; a family of five on 4h transfers across markets

Asked to use the Pine library as indicators rather than signal sources, build families of them as a
strategy, and backtest one by one on ETH across timeframes. `npm run familylab` reads every script
four ways per bar — trail side, oscillator sign, plot colour, last call held — scores each reading on
the first half of history, keeps the ones that behave like indicators (they flip, and sit on both
sides), builds a greedy-diverse family, and backtests consensus entries and family-filtered trigger
entries with the live exit rules. The families chosen on ETH are then applied unchanged to BTC and SOL.

**Result.** On 5m and 15m the reading carries nothing on any market. On 1h it breaks even. On **4h**
a family of five (four faded retail strategies and a MACD) chosen on ETH's first half is positive in
both halves and on both sides on BTC (27 trades, +0.58R) and SOL (69 trades, +0.41R), and turns the
whole trigger universe from −1,640R / −959R to +447R / +1,059R on those two markets, raising R per
trade on 80–93% of triggers. It is the first entry filter in this repo to pass a test on a market it
was not fitted on. ETH's own second half is weak, the window is one bear year on three correlated
markets, and the consensus samples are small. Full tables in `docs/FAMILY-LAB-2026-09-27.md`.

**What changes:** nothing in the fleet. The family goes to the shadow book through the cohort gate
before anything else is said about it. Two measurement rules were needed to get here and are kept: a
reading is only an indicator if it changes its mind (constants fit any rising half), and cross-market
transfer with nothing refitted is a stronger test than halves on the fitted market.

**Revisit when** the 4h shadow cohort returns a verdict, or a second, non-overlapping window exists.

## 46. Audit findings 2 and 3: the exchange decides what filled; brackets survive a restart

The two findings that blocked any exchange mirroring since decision 18 are implemented.

**A durable order ledger** (`exchange_orders`). Every order is written as `intent` before it is
sent and moves through `submitted → acknowledged → filled | cancelled | rejected`, with `unknown`
for an order the exchange could not be asked about. A network failure on send does not lose the
order: it is looked up by its client order id until it is found or the confirmation window passes.

**Exchange fills are authoritative** (finding 2). An entry goes out as a market order and is
confirmed by polling the exchange for up to `execution.confirmSec` (15 s). The paper position is
restated to the size, price and fee the exchange reports — a partial fill shrinks it, an unfilled
one voids it (no trade is recorded, the signal is marked rejected). A level exit the paper book
detects is settled against the resting order: if the exchange filled it, the paper fill is restated
to the exchange price; if it did not within the window, that order is cancelled and the exit goes
out at market, and that fill's price is what the book keeps. A sweep every `execution.sweepSec`
(10 s) catches fills the exchange made on its own — a stop triggered on mark price the candles did
not show — and books them at the exchange price, then cancels the sibling orders. Fills restated
from the exchange carry `price_source = 'exchange'` in the orders table.

**Brackets built from confirmed exposure and kept across restarts** (finding 3). The bracket is
placed only after the entry is confirmed, sized to what filled. When the paper stop moves, the
resting stop is edited in place (`PUT /v2/orders`); if the exchange refuses the edit, a new stop is
placed before the old one is cancelled. There is never a moment with a position and no stop. On
start the ledger is settled, brackets are rebuilt from it and verified against the exchange's open
orders, a missing stop is re-placed, a target the exchange filled meanwhile is booked, and stray
orders carrying this bot's client-id prefix are cancelled. A paper position with no exchange
history is reported as **unmirrored** and left alone: this process never opens exposure it did not
itself ask for.

**What is unchanged.** Production remains double-locked (`execution.allowProduction` and
`DELTA_LIVE=1`), and `assertProductionSafe` still refuses every order on the production host that is
not a plain market order — which means that on production, today, the bracket cannot be placed and
a stop would be sent at market when it hits. That rule is the owner's to relax, not this decision's:
the proposal is "a non-entry order must be reduce-only; only an entry may be a plain market order",
which lets reduce-only stop-market and take-profit orders rest on production while still making it
impossible for the bot to add exposure except by an entry it asked for.

**Tested** against a stateful fake exchange (19 cases): confirmed and partial entries, rejected
and unfilled entries voided, TP settled at the exchange price with the stop edited in place, the
edit refused, the paper stop firing before the exchange stop, the exchange stop firing first, a
vanished stop re-placed, an unanswered entry found by client id, a pending entry confirmed by the
sweep, restart with a missing stop and stray orders, restart with a target filled meanwhile, an
unmirrored paper position, bracket off, reconciliation, close-all, dry-run, host guard. Not yet
tested against the demo host itself; that is the next step before any pair is mirrored.

**Revisit when** the first demo-host session has run a day: the confirmation window, the sweep
interval and what Delta actually returns for `average_fill_price` and `paid_commission` on the
demo account.

## 47. A script's own targets are neither an edge nor a problem: 5% of trades ever reach one

Asked whether the bot should stop trusting script-published targets because they are so often out
of reach. `paper.scriptTargets` now exists — `use` (they replace the ladder, as before), `widen`
(they may push a ladder leg further out, never closer) and `ignore` (the 2/4/6R ladder always) —
and `npm run targetlab` backtests the three on the same events.

First finding: only **6 of 667** runnable scripts publish a target at all on ETH (abcd-harmonic-
projection, adaptive-dual-engine, breakout-pattern-setup, mirage-liquidity-sweep-pro,
pulse-trend-radar, stealthtrail-supertrend). For everything else the ladder already is the policy.

Those six, 8 markets × 15m/1h/4h, 139 cells, 10,797 trades, live exits on sub-candles:

| policy | trades | total R | net $ | 1st half R | 2nd half R | exits at a target |
|---|---:|---:|---:|---:|---:|---:|
| use (today) | 10,797 | −761 | −13,422 | −403 | −357 | 534 (4.9%) |
| widen | 10,743 | −779 | −13,612 | −405 | −373 | 155 |
| ignore | 10,743 | −779 | −13,618 | −405 | −373 | 155 |

Eighteen R over ten thousand trades — 0.002R a trade — is noise, though `use` is on the right side
of it in both halves. **Only one trade in twenty ends at a target of any kind**; the trail and the
stop end the rest, which is why the target policy cannot matter much. All six scripts lose money
under every policy, so the honest reading is not "their targets are unreachable" but "their entries
are not good", and no target rule repairs an entry.

Nothing changes: `use` stays the default. The flag and the lab remain for the day a script with a
real edge publishes targets. **Revisit if** the shadow book promotes such a script — then run
targetlab on its cohort before trusting either its targets or the ladder.

## 48. Scanners are profiled by what they emit, and a scanner's entry channel is now chosen

Asked to rebuild the scanners one by one, starting with WillyAlgoTrader's. All 43 published scripts
are in the library; `npm run profile` classifies each by what it actually produces in our runtime:
a trade plan (21), a direction only (14), information (5), nothing (3). Full table and the rebuild
order in `docs/WILLY-REBUILD.md`.

The profile exposed a structural over-read: `extractEvents` turned every channel into entries —
`alert()` trade calls, `alertcondition()` titles and plotted shapes alike. A script that draws a
marker on every bar of a trend was producing hundreds of "entries" beside its handful of real trade
calls (strat-trap-vwap-engine: 3,012 on 15m, of which 130 were trade calls). `ScannerConfig.sources`
now names which channels may open a trade for a scanner; unset keeps the old behaviour so nothing
running changes until each scanner is set deliberately.

Also found: the manifest's compatibility flag is stale (10 "incompatible" scripts run today), four
session-based scripts compute their sessions in UTC against authors who mean New York, and two
scripts (self-aware-trend-system, reaction-level-matrix) have a trade engine our runtime never
surfaces. Those are the next items in the rebuild.

## 49. The WillyAlgoTrader rebuild: honest readings, no edge; their own exits do not rescue them

The 22 trade-plan scripts (decision 48's group A plus Self-Aware Trend System) re-surveyed on
8 markets × 15m/1h/4h, before and after the rebuild, then once more under their authors' own exit
model (three targets, break-even after TP1, no trail). Rows in `data/reports/2026-09-28-willy-*.tsv`.

| reading | trades | total R | net $ | R/trade | 1st half | 2nd half |
|---|---:|---:|---:|---:|---:|---:|
| before: every channel an entry | 54,409 | −5,444 | −68,142 | −0.100 | −2,783 | −2,659 |
| rebuilt: the author's trade calls only, our exits | 30,453 | −3,443 | −56,631 | −0.113 | −1,923 | −1,520 |
| rebuilt, the author's exits | 30,048 | −3,484 | −58,698 | −0.116 | −1,905 | −1,578 |

Sixteen scripts were already read from their `alert()` alone; the over-read lived in a few. Strat
Trap fell from 24,852 to 1,525 trades and its R per trade went from −0.10 to −0.46: the author's
real trade calls are worse than the trend markers we had been trading by mistake. Self-Aware
Trend System, now with its packet's own stop and targets, improved from −671R to −584R. Mirage
Liquidity Sweep Pro is the one sign flip: 319 → 37 trades, +9.2R, both halves positive, too few to
act on. Daily Volume Profile Pro correctly fell silent — it never had a trade call.

Under their authors' exits the total is the same to within 1%: four scripts do better (abcd,
Fibonacci Structure Engine, StealthTrail ML Pro, Strat Trap), most do worse, and only two
scanner × timeframe cells are positive in both halves (abcd 15m +29R on 305 trades, Liquidity
Trail Matrix 4h +8R). **The exits are not what is wrong with these scripts.** Every one of the 22
loses money over these windows whichever way it is read and whichever way it exits.

Also in this commit: a paper reset archives the record instead of deleting it. The reset the owner
ran at 18:12 UTC erased the forty trades that prompted the question it was meant to answer; only
the path recorder's rows survived. Archived positions move to book `-(book+1)`, where live queries
ignore them and the forensics keep them.

**What changes:** nothing in the fleet. The rebuild stays (the readings are now the authors'),
`scripts/specs.json` is the place a script's reading lives, and Mirage 4h/1h goes on the watch list
for the shadow book rather than the fleet.

## 50. The profit lock moves earlier: +0.25R once a trade shows +0.5R

The owner watched trades go green and end at −1R. From the path recorder, of the last forty live
trades thirty were green at some point; every one that reached +1R was captured (ten of ten,
+0.53R to +1.46R banked); eight peaked between +0.28R and +0.74R and ended at the stop — the band
below +1R, where decisions 36 and 39 found every protective rule lost money on the old fleet.

Re-fitted on the current 35-pair fleet (`npm run fitexits`, 15m, 8,000 bars, 21 policies, first half
fits, second half judges, `data/reports/2026-09-28-fitexits-fleet.json`):

| policy | in sample | out of sample | vs current | out $ | markets better / worse |
|---|---:|---:|---:|---:|---:|
| current (floor +0.5R at +1R, trail from +1R) | −64.6R | +57.9R | — | 1,653 | — |
| **lock +0.25R at +0.5R** | −32.8R | +81.4R | **+23.5R** | 2,439 | **10 / 7** of 18 |
| lock +0.5R at +0.75R | −28.0R | +88.2R | +30.3R | 3,028 | 7 / 6 — the pool comes from UNIUSD and MUBARAKUSD |
| break-even at +0.5R, trail 25% | −34.7R | +80.3R | +22.4R | 2,564 | 10 / 6 |
| break-even at +0.5R | −61.9R | +65.5R | +7.6R | 2,174 | |
| every stall variant | | | −0.2R to −27.5R | | |

Three early locks beat the current policy in both halves; the one with the widest breadth is
adopted: **`floorAtR 0.5, floorKeepR 0.25`** — once a trade has shown +0.5R its stop never sits below
+0.25R; the trail from +1R is unchanged and takes over above it. Of the eight trades that prompted
this, three (peaks +0.74, +0.68, +0.54) would have banked +0.25R instead of −1R; five peaked below
+0.5R and nothing measured protects them without costing more elsewhere.

This contradicts decision 36 (break-even at +0.5R cost 44R on the old ten-pair fleet). Both are
true of their fleets; the current fleet's trades are shorter and reverse sooner, and a lock that
was too early for the old one is right for this one. The per-market fits (AKEUSD, AVAXUSD…) are
noted and not adopted — decision 43.

**Revisit when** the fleet changes materially, or the 100-trade review shows the lock firing on
trades that then ran.

## 51. The trail arms at +0.5R

Asked, after decision 50, whether the trail could arm below +1R: a trade that peaks at +0.9R and
turns keeps only the +0.25R lock. Six early-trail variants fitted on the current fleet against the
deployed policy (`data/reports/2026-09-28-fitexits-trail.json`, 15m, 8,000 bars, halves, breadth):

| policy | in sample | out of sample | vs deployed | out $ | markets better / worse |
|---|---:|---:|---:|---:|---:|
| deployed (lock +0.25R at +0.5R, trail from +1R) | −25.8R | +81.2R | — | 2,490 | — |
| **trail from +0.5R** | −16.9R | +89.4R | **+8.2R** | 2,799 | **8 / 3** |
| trail from +0.75R | −19.3R | +79.6R | −1.6R | 2,538 | 6 / 4 |
| trail from +0.5R, 50% give-back | −26.4R | +71.9R | −9.3R | 2,215 | 3 / 9 |
| trail from +0.75R, no size steps | −27.6R | +68.7R | −12.5R | 2,098 | 4 / 6 |
| steps 1.5R/3R (unchanged trail) | −23.6R | +87.6R | +6.4R | 2,750 | 8 / 2 |

Arming at +0.5R with the normal 40% give-back is better in both halves and on 12 of the 15 markets
it touches (UNIUSD, AKEUSD and ZECUSD keep their own `trailAfterR 1.5` from decision 36 and are
unaffected). A wider give-back at that level is worse; +0.75R is a wash. Adopted: **`trailAfterR
0.5`**. From +0.5R the stop keeps 60% of the peak, so the +0.88R NEARUSD peak that prompted the
question would now hold +0.53R instead of +0.25R. The size steps at 1.5R/3R look worth a fit on
top of this and are not stacked unmeasured.

**Revisit at** the 100-trade review, alongside decision 50.

## 52. One exit policy for every pair: the per-symbol overrides come out

The owner's goal: every pair armed with the same suitable lock and trail. UNIUSD, AKEUSD and
ZECUSD still carried decision 36's override (`trailAfterR 1.5`, no steps, no stall), fitted on the
old fleet. Judged on those three markets, the global policy of decisions 50–51 against the override
(`data/reports/2026-09-28-fitexits-overrides.json`, 15m, 8,000 bars):

| market | global: in / out / $ | old override: in / out / $ | trades |
|---|---|---|---:|
| UNIUSD | −5.2R / **+25.7R** / 577 | −28.6R / +18.1R / 215 | 433 |
| AKEUSD | +44.4R / **+18.3R** / 855 | +28.3R / +12.8R / 635 | 153 |
| ZECUSD | −12.1R / +17.2R / 590 | −16.2R / +20.9R / 708 | 127 |

Two of three better in both halves under the global policy, the third split (better in sample,
3.7R worse out). The overrides are removed; `exitBySymbol` is empty. Per-market winners the fit
proposed (break-even + tighter trail on two of them) are not taken — decision 43.

Every pair now runs: stop 1.0×ATR (4.0 for structure-anchored-vwap, decision 43), lock +0.25R at
+0.5R, trail from +0.5R keeping 60% of the peak (70% past 2R, 80% past 4R, ×0.6 after a 45-minute
stall), targets 2/4/6R with everything on the last, reversal above 0R.

## 53. No scraps, and one position per symbol

Review of the twelve hours after decisions 50–52 went live (15 closed trades on the VM):

- Every trade that showed +0.5R banked a gain — eight of eight, from +0.33R to +1.59R (six `trail`
  exits, two locks). Not one "green then red" in the band the new rules cover.
- The seven losses were all −1R, five of them **within three to six minutes of entry** and never
  green. Entries, not exits.
- Net −$14.61 on fees of $26.63: the trades earned +$12 gross and paid twice that to the exchange.
- **Six of the fifteen were scraps.** After two full-size positions (about $2,400 notional at 5×,
  $480 margin each) the wallet is spent, and the next signals were funded at what was left:
  $43, $10 and $33 of notional with $0.35, $0.08 and $0.28 at risk against an intended $30. They
  cannot earn their R in dollars and they pay fees; the six of them lost $13.80 — the whole net loss
  of the window.
- **Two scanners opened the same AKEUSD short on the same bar** (#489, #490: identical entry, peak
  and exit), doubling one idea to 5.4% of equity at risk; `maxPositionsPerSymbol` was 2.

Two rules, both about capacity rather than edge:

1. **`paper.minSizeShare 0.5`** — a trade the margin can fund at less than half its intended size is
   refused ("margin funds only 23% of the intended size") instead of taken as a scrap. Code default
   0 (off) so nothing else changes; the VM runs 0.5.
2. **`risk.maxPositionsPerSymbol 1`** — a second scanner agreeing on a symbol does not add a second
   position. The reversal logic already handles the opposite side.

Neither is measured for edge; both remove trades that cannot pay their fees or double-count an
idea. They will show up as more "margin" rejections on the Signals page, which is the honest
picture of a $1,000 account carrying this fleet (audit finding 6).

## 54. Scanners carry their profile and their reading; the Learn page says it is advisory

Audit in `docs/ML-SCANNERS-AUDIT-2026-09-28.md`. The learned model steers nothing (decision 37) and
its page now says so. Scanners are handled as what they are: each carries a stored profile of what
it produced when run (plan / signal / levels / silent / broken, with the counts), how it is read
(entry channel, timezone, derived rule, overrides — editable on the detail page), and its health
row. `POST /api/scanners/:id/profile` and `npm run profile` both write `script_profile`. Nothing in
the fleet changes; the next step is evidence on the page (halves, breadth, cohort verdicts) and an
enable switch that refuses to skip the lifecycle.

## 55. The daily pair hunter: screen in halves, promote without a click

The owner asked for a daily hunter: any pair doing well in the market is tested and added for
trade. The incubator already was that machine — a daily screen of the library on the forty most
liquid perpetuals, a shadow book, a cohort gate — but two things kept it from ever adding a pair:
the screen judged on one run (profit factor, windows up, a stress test) and had never asked whether
both halves held, and promotion waited for a click that in 157 candidates and 100 shadow pairs was
never made.

Changed:
- **Screen in halves.** A candidate now needs a positive R per trade in each half of its screen
  history on its own (`incubator.screen.requireBothHalves`, on). Fewer candidates, honest ones.
- **Automatic promotion.** `incubator.promote.auto` (on for the VM): every pair the cohort gate
  proposes is promoted immediately, in gate order, until the weekly (2) or fleet (40) limit stops
  it. The gate itself is unchanged — thirty shadow trades over fourteen days, PF ≥ 1.2, most weeks
  positive, half the cohort's markets positive — so nothing reaches the fleet on a backtest alone.
- **The hunt runs in the bot.** The screen still runs in its own process; when it finishes, the bot
  judges the shadow book, promotes, writes the digest (`incubator.lastHunt`) and sends it as an
  alert (Telegram once the token is set). The Incubator page shows the digest and whether
  auto-promotion is on. A click on "Re-judge now" runs the same hunt.

This reverses decision 17's propose-and-approve, at the owner's request. What protects the fleet
is now the gate and the limits, not the click; the review of promoted pairs is the demotion rule
(`incubator.demote`) and the 100-trade review.

## 56. Markets today: a pair is only traded when the market itself is suitable

The owner's rule, after the hunter: it is not enough for a scanner to be good — the pair (PUMP, SUI,
SEI, ONDO, any of them) must be worth trading *that day*, and a market that is not paying is ignored.
The fee study made half of this measurable already: on 15m the majors cannot pay a round trip, and
the fee filter was refusing them one signal at a time.

`risk.marketGate`, judged for every fleet and incubator market at start and every hour, with the
verdicts on the Overview page and on every rejection. A market is out today when any of:

- **illiquid** — 24 h turnover under `minTurnoverUsd` ($1M);
- **too quiet** — 15m ATR as a share of price under `minAtrFeeMult` (4) round-trip fees, i.e. a
  1×ATR stop that cannot pay 0.118% — the fee filter's arithmetic applied to the market before a
  signal is spent on it;
- **not paying** — at least `minTrades` (5) closed trades on it in the last `lookbackDays` (14),
  live and shadow books together, with profit factor under `minPf` (1.0).

A market the bot has no candles for gets no volatility opinion, not a block. Exempt list for
markets the owner wants regardless. The gate rejects at entry (`market: …`), so open positions are
never touched, and nothing here changes what the scanners compute — it changes where their
signals are allowed to become trades.

What is measured and what is not: the turnover and the fee floor follow from arithmetic that has
been checked against the exchange. The "not paying" rule is the owner's; whether recent
profitability on a market predicts the next fortnight is being tested on the fleet-wide survey
(halves per market) and will be reported. Until then the rule stands because the owner asked for
it, and because a market where the book has lost five trades in two weeks is at worst a market
the bot sits out.

## 58. Containment after the architecture review: exposure is what the exchange confirms

An external architecture review (28 Sep, baseline `c9a2f49`) reproduced five defects with the fake
exchange. The four that would cost money first are closed here; the larger ones (a transactional
outbox, one strategy spec across live/replay/walk-forward, deployment tuples, research off the
trading thread) are queued behind it.

1. **Protection outlives the paper book.** The executor now keeps a confirmed-exposure count per
   position (entries filled minus exits, stops and targets filled). When the book closes a position
   that the exchange still holds — an exit rejected, or filled in part — the bracket is **not**
   cancelled: the stop is resized to what is left, the position is recorded as *stranded* and shown
   in red on the Exchange page, and the executor sends a reduce-only market order for the rest at
   once and on every sweep until the exchange confirms zero. Only then does the bracket go. Recovery
   rebuilds exposure from the ledger, so a restart cannot forget a stranded position.
2. **Execution settings do not change at runtime.** The executor reports the mode it was built with;
   a config change to `execution.mode`, `allowProduction` or `bracket` is refused with 409 and the
   reason; a restart applies it.
3. **One order for the emergency.** Exchange close-all now pauses entries, lets queued execution work
   settle, flattens, then reconciles, and leaves entries paused. A paper reset is refused while the
   exchange holds anything for the book.
4. **The voided entry reaches the dashboard** (the SSE reducer drops it), and the paper `closeAll`
   takes the caller's clock — which was the flaky weekly kill-switch test: the kill-triggered closes
   were stamped with wall time and, on a Monday, rolled the test's risk week.

Tested against the fake exchange: rejected exit keeps every bracket order and strands the full
size; partial exit strands the residual with the stop resized to it; the sweep closes the rest and
only then cancels; a config edit cannot relabel the running executor. 214 tests pass.

## 59. AlgoAlpha and BigBeluga researched; fifty pairs enter the shadow book; single-run candidates set aside

Full report in `docs/ALGOALPHA-BIGBELUGA-2026-09-28.md`. Neither author publishes a trade plan;
half their catalogue does not run here (library imports, syntax, hangs); their signals are states
and are now read at the rising edge (decision 57). Surveyed in halves on 8 markets, everything
loses on 15m and 1h and 4h has pockets — 10 scanner × timeframe cells positive in both halves with
breadth, four of them convincingly. The 50 pairs that pass the screen in halves were recorded as
candidates and admitted to the shadow book (44 at 4h, 6 at 1h); the gate decides. The 162 older
candidates screened on a single run were set aside for the daily screen to re-judge under decision
55, and `incubator.maxShadow` rose to 150.

### 56a. The gate judges the whole liquid universe, and "not paying" counts live trades only

The Markets-today panel showed 13 allowed and 18 out because the gate only ever judged the 31
markets the fleet and incubator scan; Delta India lists 220 USD perpetuals, 40 of them above the
$1M/24h floor. The gate now judges the scanned markets plus every perpetual above the turnover
floor, and each verdict carries `tracked` so the panel keeps the scanned ones as pills and lists the
liquid-but-unscanned ones (PUMP, SEI, ONDO, SUI and the like) on one line — the pool the daily hunt
draws from. The "not paying" rule now counts the live book and its archive only (`bt IN (0, -1)`):
shadow trades belong to unproven scripts and say nothing about the market. Turnover is shown to two
decimals so a market just under the floor (HYPE at $0.96M) reads as such. The floor itself stays at
$1M; with ~$2.4k notionals $0.5M would be enough and would admit 55 markets — the operator's call.

### 56b. The book rule: a market is tradable when crossing its book is cheap, not when yesterday was busy

Measured on Delta's live books for a $2.4k market order in and out: HYPE ($0.96M/day) and TAO
($0.57M) cost 0.13–0.16% round trip, the same as SOL; PUMP ($13M/day) costs 0.35%, three times
ETH; AIN, WIF, PEPE and COOKIE cost 0.30–0.34%. The $1M turnover floor blocked the first two and
admitted the rest, so turnover is dropped as the tradability test. The gate now reads each
market's level-2 book on every refresh, walks it for `probeNotionalUsd` ($2.5k, the live book's
average notional) both ways, and blocks when spread + slippage + fee exceeds `maxBookCostPct`
(0.25%), or when either side cannot fill the notional within 25 levels ("thin book"). The
"too quiet" test now compares ATR with the market's own round-trip cost instead of the flat fee,
so a wide book needs more movement to qualify. Turnover stays only as a dead-market guard at
$0.25M. An unreadable book gives no opinion rather than a block. The book cost and spread show
in the Markets-today tooltip. Not a scalper's rule: for holds of hours on 15m–4h the cost only
has to be paid a few times over by the normal move; a scalper would need spreads under 0.02%,
which on this exchange means the majors plus HYPE and TAO.

## 60. Operator demotion, and the incubator screens every market the gate allows

Two findings from the stop review and the combinations check (docs `DEAD-ON-ARRIVAL-2026-09-28.md`,
`COMPOSITE-CLAIM-CHECK-2026-09-29.md`) needed a lever the system did not have.

**Operator demotion.** A live pair could only leave the fleet after the gate proposed it. Three
scanners were shown to be misread rather than losing on a fair sample — Adaptive ATR% Extension's
"Up Warn" is an over-extension warning traded as a long, Machine Learning RSI AI's "ST Flip" is an
ungated visual, Volume SuperTrend AI's "Trend Signal" is a per-bar state — and re-surveyed under
corrected readings they still have no edge at 15m. Waiting for the gate would have cost more
trades. `POST /api/incubator/:id/demote` (admin, "To shadow" on the Incubator page's live rows)
moves a live pair to the shadow book at once: the market leaves the scanner's live list, the
scanner is switched off when that was its last market, open positions keep their exits, and the
pair must pass the gate again to return. Twelve pairs were demoted this way on 2026-09-29.

**Every allowed market is screened.** The daily screen covered the turnover top-40 above $1M, so
markets the gate now admits on their books (HYPE, TAO, and the rest of the 57 allowed today) were
never screened and could never enter, while the fleet traded 18 markets. The screen's universe is
now the gate's allowed set (decision 56b), most liquid first, capped by `incubator.universeTop`
(raised to 100 on the VM); the turnover top-N remains only as the fallback before the gate has
judged. Tokenized stocks and metals that Delta lists as perpetuals pass the book rule and are
therefore screened too; excluding them is a one-line `exempt`-style list if the operator wants it.

### 60a. Crypto only

Delta lists 34 tokenized stocks, ETFs, indices and metals as USD perpetuals (xStock, bStocks,
PAXG, XAUT, SLVON). They pass the book rule, so the widened screen and gate would have admitted
them. They trade around US market hours, gap at the open and carry none of the behaviour the
scripts were profiled on, so they are out: `risk.marketGate.cryptoOnly` (default true) blocks
them in the gate ("not crypto") and keeps them out of the universe the screen draws from. The
marker is the product description (xStock / bStocks / Gold Token / Silver / ETF); Venice Token
(VVV) is crypto and does not match. The six shadow and candidate rows the incubator held on
SNDKB, SOXLB and SLVON were retired with that note; no fleet scanner and no open position was on
a tokenized market.

## 61. The LuxAlgo Library imported; PineTS 0.10.0 assessed, not yet adopted

**Library.** luxalgo.com/library publishes 806 indicators with their Pine source embedded in each
page (MPL-2.0 for the library's own implementations, CC BY-NC-SA 4.0 for the TradingView-published
ones; non-commercial use is what the bot does). 355 were already in the script library under their
TradingView ids; the other 442 were imported from the pages (`source: luxalgo-library` in the
manifest, with `family`, `license` and `tradingviewUuid`). Under the current runtime 407 of them
run on the first try (359 emit alerts, 122 draw shapes); 35 fail, 16 of them on the `Index -1`
lazy-evaluation bug that PineTS 0.10.0 fixes and 8 on `request.security` of non-Delta symbols
(SPX, VIX). Nothing was profiled or admitted by hand: the daily screen (decision 60) covers them
slice by slice and the gate decides, as for every other script. The strategy-style newcomers worth
watching in the screen are AMD POC Trade Setup, No-Wick Retest Levels, Asia Sweep Reversals,
Session Sweep & iFVG RR, Value Area Reversion Signals, MSS Sweeps, EQH/EQL FVG Breakouts and
PDH/L FVG (CRT). The library also runs an MCP server (mcp.luxalgo.com/mcp, keyless) whose
`library_get_source_code` tool fetches the same sources on demand; Quant (app.luxalgo.com/quant)
is a chat coding agent inside their chart with no API — a strategy written there is Pine that can
be pasted into `scripts/pine` and screened like any other, and their strategy alerts can reach a
webhook, which this bot does not expose.

**PineTS 0.10.0** (2026-09-25; installed 0.9.34) fixes bugs that touch signal logic: `?:` and v6
`and`/`or` are now lazy (what the `ltm-short-circuit` patch works around), `ta.crossover`/
`crossunder` inside a ternary test passed as a call argument never returned true, pivot ties and
`na` windows now follow TradingView, `input.timeframe` overrides were ignored, plus indentation and
`switch` parsing fixes. Measured in an isolated worktree: the fleet's 16 scanners produce identical
alert and shape counts on BTCUSD 15m × 1500 bars under both versions; 151 of the 620 scripts the
registry marks incompatible run under 0.10.0 (55 with alerts), 469 still do not (library `import`,
Pine v4 and older, `request.security` to non-Delta symbols, hangs). Not adopted yet: the upgrade
changes the engine every scanner runs on and the fleet parity was measured on one market and one
timeframe. Adoption is the operator's call ("upgrade pinets"); the worktree with the comparison
stays under the session scratchpad until then.

## 62. Fibonacci Structure Engine 2.1 tested; a runtime patch for `array.get(...).field` in an `if`

The author republished the script on 2026-09-28 as a rewrite (2.1.0; the library held 1.5.2). The
new version failed under PineTS with "liquidity is not defined": a field read straight off
`array.get(arr, i).field` in an `if` test loses the array's binding (both 0.9.34 and 0.10.0;
reproduced minimally). A general patch rule (`if-array-get-field`) reads the element into a
local first, same value and order. The script's structured alerts (`schema_version: 2`,
`events[].type` buy/sell with entry, stop and target; target/invalidated/expired as exits) are
now parsed by the extractor. Survey on the VM's exit settings, 15m/1h/4h × 8 markets, in halves:
15m −0.088R over 464 trades (no market positive in both halves), 1h −0.130R over 300, 4h +0.074R
over 152 with the first half +0.267 and the second −0.075, two markets (AVAX, DOGE) positive in
both halves. The same shape as 1.5.2: a 4h pocket, nothing that carries a book. It stays in the
library for the daily screen; not a fleet candidate on this evidence.

### 61a. PineTS 0.10.0 adopted

Parity of the fleet's 16 scanners between 0.9.34 and 0.10.0 was measured on four pairs — BTCUSD
15m (1,500 bars), ETHUSD 1h (1,500), SOLUSD 15m (1,500), XRPUSD 4h (1,200) — with identical
alert, shape and label counts on every scanner. The server now depends on `pinets ^0.10.0`
(its own `server/node_modules` copy; the dashboard's chart keeps the runtime it was built with).
216 tests pass. The compatibility report carries the 0.10.0 rows for the 620 scripts that were
marked incompatible: 151 run now. The six source patches stay; the lazy-evaluation one is
harmless under the new runtime. Deployed with `npm ci` on the VM, since a pull alone does not
change installed packages.

## 63. Analytics learns in R: expectancy with a band, breakeven, costs, stop anatomy, give-back

The first week of paper trading was read by hand: every question the operator asked (are the
stops draining the book, is the expectancy real, what do fees take, how much does the trail give
back) needed a script. The Analytics page now answers them first, from the journal, in R so the
live and shadow books read the same way (`GET /api/learning`, `server/src/analytics/learning.ts`,
pure and tested):

- expectancy with a 90% band on the mean, and a verdict that only says "paying" when the whole
  band is above zero and "failing" when it is all below — everything else is "undecided", which
  is a call for trades, not a decision;
- the win rate the exit policy needs to break even (from the average win and loss in R) next to
  the win rate achieved;
- the share of gross winnings that costs consumed;
- stop anatomy: how many stops never moved (peak under +0.3R), how many died inside the first
  bar, median life;
- where the R goes by exit reason, with the median peak and the give-back (peak R − realised R);
- cumulative R with distance from the peak, hold time versus R, hour of entry in IST versus R;
- the incubator pipeline: stage counts, shadow age, the last hunt.

Grouped by scanner, pair or timeframe, sorted by the lower band. The dollar tables stay below.
The shadow book is shown over the last 30 days and in R only: its $10M purse makes its dollars
meaningless (decision 60 note).


## 64. Three books, one vocabulary

The UI said "paper", "simulated fills", "live", "shadow" and "backtest" in ways that overlapped:
the header called the money book "Paper · simulated fills", the Incubator called it the "live
fleet", Analytics called its trades "Paper trades" next to "Backtest", and the shadow book's
dollars appeared beside the account's. The vocabulary is now fixed (SYSTEM.md, "The three books"):
**Account** (paper / dry run / live), **Shadow book** (evidence, R only) and **Backtest**. One
`BookBadge` component renders them everywhere — the header shows the account's mode with its
meaning on hover, page subtitles say which book they show and where the others live, Analytics
and the learning section label their toggles Account (paper) / Shadow book / Backtest, and the
Incubator's fleet panel is "In the account". Nothing in the data changed.

### 64a. Scanners list shows each scanner's books

Each scanner row and card now carries its books (decision 64): an Account badge with the number
of markets it trades in the account, a Shadow badge with the number it is proving in the shadow
book (proposed pairs counted there, named on hover), or a dash when it trades nowhere. A "Book"
filter (all / in the account / in the shadow book / not trading) sits beside the author filter.
The server's scanner view carries `books` from the incubator's pairs.

## 65. The LuxAlgo family adopted: verdict engine, survival rule, exit lab, regime features, library sync

Five things from `docs/LUXALGO-TOOL-FAMILY-2026-09-30.md`, each measured before it was kept.

**Go-live rule with a survival Monte Carlo.** LuxAlgo's Prop Firm Sim, run over the 66 live
trades with the fleet's own halts as the ruleset (15% daily, 30% max loss, 30 days, 22.5
trades/day, 1% risk): halt in 88.5% of paths, max drawdown median 38%, 95th percentile 43%. The
same idea now runs inside the bot (`server/src/analytics/golive.ts`: stationary block bootstrap of
the journal's R series through the halts, deterministic under a seed, tested) and the Learning
section shows the rule as six checks with their numbers: closed trades ≥ 200, lower 90% bound of
E[R] after costs > 0, P(halt in 30 days) ≤ 10%, simulated 95th-percentile drawdown inside the
alert line, no halt in the window, alerts configured. Keys stay unset until all six are green.

**Exit lab with the LuxAlgo trails.** The 66 live entries reconstructed on 1-minute paths and
replayed under chandelier (peak − k), sigmoid-transition, Elder SafeZone and statistical trailing
stops beside the current policy. Nothing wins the second half; the current policy (lock +0.25 at
+0.5, keep 60/70/80%) is the worst on these paths at −12.3R, the balanced candidate is
"chandelier 0.75R from 1R" at −1.4R (first half +2.0, second −3.4, beats the old live rule in
5 of 8 windows). Too few entries to change anything; the rule stays in the lab as the one to
keep measuring.

**Regime and chase recorded at entry.** Four features join the entry-time set: the move over the
three bars before entry in the trade's direction (ATR), the signal bar's range (ATR), Kaufman's
efficiency ratio over 20 bars, and the 14-bar choppiness index. The stop study found first-bar
stops follow a burst; the composites check wanted a trend/range reading. Both are now on every
trade so the journal can split by them; nothing gates on them yet.

**Edge Stats on Delta bars.** LuxAlgo's open-source statistics engine runs on Delta 1-minute
bars through its CSV adapter (`_research` notes; not deployed). On 54 UTC sessions of BTC, ETH
and SOL it answers session questions with N, a 95% CI and a halves check, and refuses anything
under ten sessions — the discipline the incubator wants. Delta's history endpoint caps a pull at
80,000 one-minute bars (55 days), so the sessions are few; its verdicts today are "undecided".

**Library sync.** `npm run library:sync` reads the LuxAlgo Library sitemap and imports what the
manifest lacks; `OUT=data` writes into `data/library/` (manifest and Pine files), which the
registry now reads as an overlay after the repo's own library, repo entries winning. A weekly
timer on the VM runs it; nothing it imports is enabled, the daily screen finds the newcomers.

## 66. The whipsaw gate, measured: an efficiency-ratio floor turns the 1h fleet positive in both halves

The four stops of 30 September were one hourly-reversing session read from both sides. The
backtest engine gained a gate that refuses an entry when the entry timeframe's Kaufman efficiency
ratio over 20 bars is under a floor (or its 14-bar choppiness index over a ceiling), and the
survey judges every cell under several floors from the same script run. Fleet of 16 scanners ×
12 account markets, ~80 days of 15m and ~160 days of 1h, the VM's exit settings, in halves
(`data/reports/2026-10-01-whipsaw-gate-survey.tsv`):

| timeframe | gate | trades | E[R] | first half | second half | cells positive in both halves | ΣR |
|---|---|---|---|---|---|---|---|
| 15m | off | 13,583 | −0.031 | +0.021 | −0.060 | 20 | −420 |
| 15m | ER ≥ 0.35 | 3,814 | −0.001 | +0.078 | −0.044 | 12 | −4 |
| 15m | ER ≥ 0.45 | 1,986 | +0.005 | +0.064 | −0.026 | 11 | +11 |
| 1h | off | 14,357 | −0.002 | +0.012 | −0.016 | 33 | −29 |
| 1h | ER ≥ 0.25 | 6,620 | +0.031 | +0.046 | +0.017 | 31 | +207 |
| 1h | ER ≥ 0.35 | 4,135 | +0.029 | +0.008 | +0.047 | 18 | +120 |
| either | choppiness ≤ 62 | — | no effect | | | | |

On 15m the gate removes most of the losses (Pulse Trend Radar −157R → −18R, Liquidity Trail
Matrix −115R → −42R) but the second half stays negative: a 15m stop does not survive the noise
whatever the filter. On 1h with ER ≥ 0.25 the fleet is positive in both halves, over half the
cells improve in the second half, and 25 scanner-market cells are positive in both halves with
at least eight trades each — including AI Predictive Flow on PIEVERSE and ZEC, Kinetic Momentum
on FIL, PIEVERSE and UNI, Session Killzones on ETH, PIEVERSE and ZEC, Supertrend Cluster on ZEC.
The choppiness index adds nothing. The gate is in the engine and the survey only; nothing gates
live yet. Measured, not adopted: turning it on cuts entries by about half and belongs with the
re-timing, which is the operator's call.

## 67. The scanner test, and signal labels as an allow-list

`npm run diagnose` (`server/src/cli/diagnose.ts`) is the scanner test the operator asked for: for
every script × market × timeframe, one script run, eleven judgements of the same events — the
fleet's settings, no costs, wider stops, a 1R target, our levels only, the script's own exits, the
efficiency gate, every signal inverted, longs only, shorts only — plus the excursion profile and
the record per signal label, and a verdict that names the cause the numbers support with the fix
to try. First batch: the fleet's 16 scanners and all 26 WillyAlgo scripts on 12 account markets at
15m, 1h and 4h (`data/reports/2026-10-01-scanner-test-batch1.tsv`).

What it found on the first 880 cells: 120 pay as read; 93 are positive before costs and negative
after (the cost-in-R rule, decision 66); 90 pay when every signal is read the other way — and
those sit on four markets (PIEVERSE, SAGA, FIL, EVAA) across twelve unrelated scripts, so they
are a market property (thin alts that reverse after a breakout), not sign errors; 15 are a label
mix, one channel of a script paying while its siblings lose; 14 pay only when the market moves
efficiently. Two scripts have no paying variant anywhere (FIA Trend Momentum, Dynamic RSI
Regression Bands); one never fires enough to judge (Mirage).

The label mix is fixable in the reading, so a scanner now carries `labels`: only entries whose
label starts with one of the listed prefixes open a trade; exits and info pass. Set from the
test's per-label record across all cells (n ≥ 500 each, the paying label positive in both halves
on the most cells): Kinetic Momentum Vectors → Bull Spike (+0.20R vs Bear Spike −0.09R); AI
Predictive Flow → Background Turned Bullish (+0.10R; its other eleven conditions ≤ 0); Session
Killzones → Asia Bull Breakout (+0.07R; the bear breakouts lose); Volume-Weighted S/R Zones →
BREAK UP (+0.10R vs BREAK DOWN −0.08R); Smart Money Breakout → Bullish Breakout Detected
(+0.08R vs −0.08R); Meridian Flow → LONG (+0.02R vs SHORT −0.09R). All six lists are long-side,
over a window (July–September 2026) that rose; the journal will say whether that holds. The lists
live in `scripts/specs.json` and on the scanner's reading panel. Fees are deliberately left for
later: this decision is about which signals fire.

## 68. Why there were no signals: PineTS 0.10.0 leaks per run; workers are now recycled

From the 0.10.0 deploy on 30 September the VM logged 35–39 worker crash-loop alerts a day (3–4 a
day before). On 2 October scans were running 15–20 minutes late, 13 of 23 fleet runs timed out at
90 s, and the few signals that arrived met a quiet market's fee filter. Measured locally with six
fleet scripts run eight times each in one worker on 1,000 bars: under 0.10.0 every run gets slower
(310 → 907 ms, 648 → 2,913 ms) and the process grows from 300 MB to 1.5 GB in 48 runs; under
0.9.34 both are flat. A long-lived worker therefore reaches its 1.5 GB cap, crashes mid-job, is
replaced, and the backlog times out. The pool now recycles a worker after `WORKER_MAX_RUNS` jobs
(24, `VNEDGE_WORKER_MAX_RUNS`), which bounds the leak at a few hundred MB; a fresh worker costs
under a second. The status page shows the recycle count. The runtime stays at 0.10.0 for its
fixes; the leak goes upstream.

### 67a. The re-read scanners, before and after

The eight scanners whose reading changed (six label allow-lists, Dynamic RSI inverted, FIA with a
4h higher timeframe instead of its 5-minute default) re-run through the scanner test on the same
12 markets and three timeframes (`data/reports/2026-10-02-scanner-test-reread.tsv`). Expectancy
improved in 22 of 24 scanner × timeframe rows:

| scanner | tf | before n / E[R] / cells both halves + | after |
|---|---|---|---|
| AI Predictive Flow | 1h | 4,038 / −0.012 / 2 | 413 / +0.128 / 4 |
| Session Killzones | 4h | 4,986 / +0.034 / 3 | 1,310 / +0.137 / 9 |
| Volume-Weighted S/R Zones | 1h | 1,210 / +0.028 / 2 | 335 / +0.168 / 7 |
| Smart Money Breakout | 4h | 228 / +0.066 / 3 | 118 / +0.274 / 3 |
| Kinetic Momentum Vectors | 1h | 426 / +0.193 / 4 | 302 / +0.282 / 3 |
| Meridian Flow | 4h | 387 / +0.042 / 5 | 194 / +0.150 / 5 |
| Dynamic RSI Regression Bands | 1h | 163 / −0.032 / 0 | 150 / +0.164 / 2 |
| FIA Trend Momentum | 4h | 39 / +0.199 / 0 | 1,314 / +0.086 / 5 |

FIA had been nearly silent because its "higher timeframe" input defaults to 5 minutes, below any
chart we run it on; with 4h it fires, and pays on 4h in 5 of 12 cells. Dynamic RSI's rejections
were being read as the move they describe; inverted, its 1h cells turn positive. The allow-lists
were chosen on this same history, so the halves check is the only guard; the journal decides.
All eight readings are live on the VM.

## 69. The sudden stop losses: every stop was costing 3% of equity, not 1%

The account's sizing mode on the VM was `quality`: notional = equity × a leverage chosen from the
signal's score, 5× when the script publishes no score (nearly all do not), halved to 2.5× by the
drawdown scaler once equity sat 10% under its peak. The stop then decides the loss: 2.5× equity ×
a 0.65–1.0% stop = 1.6–2.6% of equity, held under the 3% `maxStopLossPct` cap. The configured
`riskPerTradePct` of 1% is not consulted in that mode. Measured over the 78 closed account trades:
risk per trade at entry median 2.98% of equity (the cap), loss at the stop median 2.69%, 28 stops,
equity 1,000 → 1,071 → 868. Each stop was a third of the intended size's worth of account, which is
what "sudden" meant: one losing session took 10%.

The account now sizes in `risk` mode: one contract more than the stop allows for 1% of equity, the
3% cap still above it. Winners shrink in dollars by the same factor; R is unchanged, which is why
the journal's R statistics had not shown it. The go-live rule now carries a seventh check — risk
actually taken per trade, median of `risk_amount` over the equity at entry, must be ≤ 1.5% — and its
survival Monte Carlo runs on that measured figure instead of the configured one, which had been
flattering it by a factor of three.

## 70. The fleet re-timed to its measured cells, with the whipsaw gate live

The operator asked for whatever makes the bot function. The evidence of the week says: a trade
must cost under 0.10R (decision 66's cost table), the 15m stop sits inside hourly noise, and on 1h
with an efficiency-ratio floor the fleet is positive in both halves (decision 66). Three pieces:

1. **A scanner trades explicit (market, timeframe) pairs.** `scanners.<id>.pairs` replaces the
   symbols × timeframes product in the engine (required series, warm-up, backtests, which scanners
   run on a bar close), the incubator (live rows carry each pair's own timeframe; promotion adds a
   pair, demotion removes one, the last switches the scanner off), the API and the Scanners page.
2. **The whipsaw gate is live.** `risk.regime.minEr` (0.25) refuses an entry when the entry
   timeframe's Kaufman efficiency ratio over 20 closed bars is below the floor; the Signals page
   shows "regime: choppy (efficiency 0.18 < 0.25)".
3. **The account trades 26 cells across 10 scanners** (`data/reports/2026-10-03-fleet-pairs.json`):
   the 24 one-hour cells positive in both halves with at least eight trades each under the gate,
   plus two 15m cells with a positive live journal (AI Predictive Flow on UNI, Smart Swing VWAP on
   AKE). Markets: AKE, ETH, EVAA, FIL, LINK, PIEVERSE, SAGA, UNI, ZEC. Every other live pair went
   to the shadow book, not retired, so its evidence keeps accruing; the scanners with no remaining
   pair are off. Expected trade rate falls from about 24 a day to about 4.

Caveats stated plainly: the 1h cells were measured under the old reading of the six re-read
scanners (decision 67), and the label lists and the gate have not been measured together; the
cells were selected on the same history the gate was chosen on. The journal decides; the go-live
rule stays red until it does.

## 71. One truth per number: the UI audit

The operator asked whether the tabs tell different stories, then asked for every difference to
be fixed. Every page endpoint was pulled under one session and cross-checked: equity, net, fees
and trade counts agreed across Overview, Trades, Analytics, Learning and the equity curve (78
trades, −131.62 net, 177.50 fees). Six numbers had more than one source. Each now has one.

1. **Peak and drawdown belong to the paper engine.** The ops monitor kept its own peak and never
   learned about the paper reset (it alerted on 25.3% from a peak the account no longer had while
   the Risk page said 19.0%); the risk manager kept a second peak; the Overview's "max drawdown"
   was the deepest trough of the closed-trade path, which could sit *below* the drawdown right
   now. The engine now tracks the peak since the reset and the worst drawdown from it on every
   equity observation (`paper.peakEquity`, `paper.maxDrawdownPct`, rebuilt from the equity table
   on first run, restarted by a reset). The Risk page, the ops monitor's alert, the Overview tile
   and the leverage scaling all read it.
2. **Closed versus open, not realised versus unrealised.** "Realized" included the banked legs
   and fees of open positions, so it never matched the Trades total. Stats now carry `closedPnl`
   and `closedFees` (the journal, what Trades sums) and `openPnl` (open positions' banked legs,
   fees and mark), with equity = initial + closed + open. The Prometheus gauges follow
   (`paper_closed_pnl`, `paper_open_pnl`).
3. **One "today".** The header and Overview counted trades closed since 00:00 UTC; the Risk
   page's day figure is equity now against equity at 00:00 UTC, open positions included, which is
   what the daily kill switch watches. The journal version is gone; the header and the Overview
   show the kill-switch figure.
4. **Analytics scanner table sums to its total.** It listed enabled scanners only while the
   total counted every closed trade; disabled scanners carried −151.63 of the losses, so the
   table showed +20.01 against −131.62. Every scanner with account trades has a row, tagged "off"
   when disabled.
5. **ML "account" samples.** The count was all time, trades before resets included (198 against
   78 on the Trades page). The Learn page now splits since-the-reset, earlier accounts, backtest.
6. **Go-live realised risk** was the median over the whole journal, so the switch to risk sizing
   (decision 69) would have taken months to show. It is the median of the last 30 closed trades.

**Not a conflict.** The 18 global symbols are the feed subscription list; the account trades the
nine markets in the live pairs; the market gate tracks 29. Different questions, not different
answers.
