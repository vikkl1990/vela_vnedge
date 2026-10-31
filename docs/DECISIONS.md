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
Confirmed by the operator on 18 October 2026: the account has joined the offer on Delta, so the
model matches the account and the flag stays on.

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
6. **The Learn page was stale.** Training had failed silently since 30 September: rule derivation
   read the four regime features (decision 66) off samples recorded before they existed and got
   `undefined`. Missing values now read as 0, as the model already did, and the page trains again.
7. **Go-live realised risk** was the median over the whole journal, so the switch to risk sizing
   (decision 69) would have taken months to show. It is the median of the last 30 closed trades.

**Not a conflict.** The 18 global symbols are the feed subscription list; the account trades the
nine markets in the live pairs; the market gate tracks 29. Different questions, not different
answers.

## 72. ADX and daily-range progress at entry; three LuxAlgo scanners to the test

An outside review proposed six LuxAlgo components, SafeZone first. Checked against the record:
SafeZone was already replayed in the exit lab (decision 67, three settings, nothing beat the second
half), the regime question is answerable from the journal, and three of the proposed entry systems
had never been through the scanner test. The reviewer accepted the revised order. Two of their
qualifications stand and are recorded here: the lab's SafeZone is an approximation of Elder's rule,
not source parity; and the worker does convert `strategy()` ledgers into events, so PineTS strategy
semantics matter for strategy scripts, though none of the ten live scanners is one.

**Two entry features join the journal.** `adx14` (Wilder's ADX, TradingView seeding) and
`day_range_used`, today's UTC-day range so far over the mean range of the last complete UTC days
(up to 20, at least 5). The second is built from the closed bars alone, which is the point: the
Average Daily Range script requests the day's high and low with lookahead on, so its historical
range-progress value knows the day's later extremes. A model trained before a feature existed now
predicts without the missing column and is retrained on load.

**Scanner test run** for Value Area Reversion Signals, MSS Sweeps and Market Structure Volume
Distribution on the nine live markets plus BTC, SOL and XRP at 15m and 1h
(`data/reports/2026-10-03-scanner-test-step2*.{tsv,md}`). None earns a place:

- *Market Structure Volume Distribution* has no signal channel at all (no alert, alert condition
  or shape; boxes and lines only). The reviewer's "Structure Volume Profile Setups" does not exist
  in the library. A scanner from it would need a rule of our own.
- *Value Area Reversion Signals* fires only its previous-day reclaims in practice (the current-day
  conditions never produced an entry). 93 trades over 22 cells: −0.09R, gross −0.04R, inverted
  −0.01R, one direction no better than the other. Too rare and no edge either way.
- *MSS Sweeps* was first measured on its ordinary Break-of-Structure alerts, which swamp the
  sweeps (2,110 trades, −0.06R, the bearish BOS channel −0.13R). The sweep channel itself is rare,
  about three a month per market on 1h: 95 trades over 23 cells, −0.04R, gross +0.01R, inverted
  +0.03R, first half +3.7R and second −7.4R. One cell stands out (AKE 15m, 13 trades, +0.60R) and
  one BTC trade carries +4.3R. Not evidence. Its spec now reads the sweep channel only
  (`labels: MSS Sweeps:, Higher Low MSS Sweep, Lower High MSS Sweep`), so any later look measures
  the right thing.

Found on the way: when a script fires `alert()` and an `alertcondition()` on the same bar, the
extractor keeps the alert() and drops the condition. Restricting `sources` to alertcondition for
such a script therefore yields nothing; the label list must name the alert() message head.

## 73. One reading contract across channels: the "dead scanner" diagnosis made attributable

An outside family-semantics review (research artifacts under `_research/family-semantics-20261003/`,
not tracked) reproduced eight reading defects against the extractor, the generic oscillator rule and
the profile classifier. Six were real and are fixed; two are declined with reasons.

**Fixed.**
1. *Same word, same meaning on every channel.* A "Bullish BOS" `alert()` was information (the
   INFO_ONLY class) while a "Bullish BOS" `alertcondition()` was an entry. Conditions now pass
   through the same class: BOS, CHoCH, divergence and the rest are context on both channels. The
   operator's label allow-list is the explicit opt-in: naming "Internal Bearish BOS" makes it an
   entry again. No live scanner traded such a label in the last 30 days.
2. *An informational alert() no longer silences the bar.* Only an alert() that carries a trade
   event owns its bar against its alertcondition twin.
3. *The allow-list decides before same-bar deduplication.* "Bullish BOS" could consume "Higher
   Low MSS Sweep" on the same bar before the label filter ran. Labels are checked as entries are
   read, on every channel.
4. *Stop-hit and close conditions are exits.* "Long Stop Hit", "Short Stop-Out", "Exit Long" become
   exit events for their side (`conditionExit`), never entries and never dropped. SafeZone's exits
   now reach the exit lab through the ordinary channel.
5. *State and diagnostic words carry no direction.* "Upward Fine-Interval Bias", "Bullish Regime":
   bias, regime, interval, sampling and noise are excluded from directional titles.
6. *Strength measures are not oscillators with a side.* ADX, DMI, ATR, choppiness, volatility,
   efficiency, Hurst and VIX panes are excluded from the generic oscillator rule, which had read
   ADX rising through 30 as "left oversold".

**Attributable zero results.** The scanner test no longer drops a cell that produced no entry. It
writes the row with the funnel and a cause: NO SIGNAL CHANNEL (plots only: a feature source), SILENT,
OUTPUT NOT MAPPED (drawn labels only), EXITS ONLY (an exit tool), or NO ENTRY READ with the raw
counts. The profile classifier has an `exits` kind for the same case. The batch incubator screen
counts only markets it actually ran before concluding a script is quiet.

**Declined.** Wyckoff "Markup Started" / "Markdown Started" stay unmapped: mapping a phase word to
an entry is the habit the review itself argues against; a Wyckoff entry needs a rule. Market
Structure Volume Distribution stays a feature adapter candidate, not a scanner.

The reviewer's recovery order is accepted as written: attributable status, role contracts, adapter
repairs with tests, prefix-honesty replay, measurement by role, shadow only on evidence. Steps 1
and 3 are this decision; step 4 (adding future candles must not change earlier signals) is the next
test to write; step 6 remains the family-lab holdout fix.

## 74. Bar closes are announced by the clock: the entry lag on thin markets

The operator asked whether entries and exits lag. Measured on the VM over eight hours of logs:

| step | liquid market (ETH) | thin market (PIEVERSE 1h) |
|---|---|---|
| bar close → scanner run | 0–5 s | 12 s to 53 min, median ~20 min |
| scanner run → signal | ~1 s (script 0.6–0.9 s) | same |
| signal → paper fill | 0 s, at the current mark | same |
| exit check | every websocket candle update, intrabar | on each trade |

The one real lag was the first row. The candle store only learned that a bar had closed when the
websocket delivered the first candle of the *next* period, which on a thin market is the next
trade; the scanner then read the bar's close long after the price had moved on. FIL reached 5
minutes, LINK 4, SAGA 1.4, PIEVERSE regularly 15–30 minutes. Two of the 26 live cells are on
PIEVERSE 1h.

**Fix.** The candle store announces a bar closed when its period has ended plus a 2.5-second grace
(`announceDueCloses`, ticked every second), exactly once, whichever of the clock or the websocket
comes first. Scanners on every market now run within about three seconds of the close.

**Not a lag, stated so the reading is right.** The paper account fills an entry at the current
mark the instant the signal exists; the few seconds a real market order would take are not
modelled (decisions 3, 13 and 40 chose candle fills over tape fills; decision 75 closes that gap). Exits are
evaluated on every websocket candle update of the forming 1-minute bar, so a stop is recognised
within websocket latency, not at the minute's end.

**Also fixed.** The "no bar close" alert flapped 45 times an hour on 1-minute series of thin
universe markets, which print nothing for minutes at a time. A 1-minute series is now stale after
ten minutes, not two. Had Telegram been configured, that storm would have been the operator's
whole inbox.

## 75. The latency window applies in candles mode too: no more fills at the signal instant

Decision 74 found the entry lag; this closes the part it had declared "not modelled". In candles
mode the paper account opened a position the instant a signal passed admission, at that moment's
mark. A real market order reaches the book `latencyMs` later and fills against whatever price is
there. The configured 1,500 ms never applied, because the pending-entry branch was tape-mode only
(an outside flow review of the deployed source said the same).

**Now, in every fill mode:** an admitted entry becomes *pending* and fills at the first price after
the window. In candles mode that price is the next 1-minute candle update for the symbol; when no
update arrives within a second of the window closing, the mark (the order is on the book; a quiet
tape is not a reason not to fill). The fill pays the spread the same way the immediate fill did:
through the live quote when one is fresh, otherwise the slippage assumption. Admission is re-run
at fill time, as in tape mode. A pending entry still expires after 60 s without any price.

The legacy test that asserted the immediate fill is replaced by two that assert the window. Tests
about other things pin `latencyMs: 0` and say so. Housekeeping now runs after a bar's own fills, so
the quiet-feed fill can never pre-empt the symbol's fresh price.

**What changes in the journal.** Entry prices will sit a tick or two worse on average than before
and signals will show `pending` for a second or two before `opened`. Nothing is re-written: trades
before this decision carry the old, slightly optimistic fill.

## 76. One reading for every book, pairs everywhere, and a check that could not run is a refusal

An outside flow review of the deployed source (commit 0176e01) listed six corrections. Four are
done here, one was done by decision 75 the same evening, one is recorded as open.

1. **The shadow book reads a scanner exactly as the account does.** The incubator's shadow runner
   passed `sources` and `edge` to the extractor but not `labels` or `invert`, so a scanner whose
   reading had been corrected (decision 67) was still measured the old way in the shadow book: its
   evidence described a different strategy from the deployed one. Both options now flow through.
   The shadow's deliberate differences stay: a $10M purse, relaxed caps, no account risk manager.
2. **The residual same-bar suppression.** An `alert()` entry that the operator's `sources` or
   `labels` excluded still claimed its bar and silenced an allowed `alertcondition()` on the same
   bar. Only an alert() entry that is actually kept claims the bar now. Tested both ways.
3. **Explicit pairs on every path.** Warm-up on refresh, the manual run-now button and the
   walk-forward validation jobs enumerated symbols × timeframes; validation could therefore
   describe cells the fleet never trades. All three use `pairsFor` (decision 70).
4. **A check that could not run is a refusal.** With the market gate on, a market it had not
   judged, or a verdict set older than three refresh periods, passed the risk gate as if judged
   allowed. Both are refusals now, with the reason in the signal row. Off still means no opinion.
5. **The latency window in candles mode** was the review's second qualification; decision 75.

**Open.** Position creation is not transactional (position row, fill row, signal action and the
emitted events are separate writes), and a reversal closes the existing position before the
replacement has passed quote, fee, risk and sizing checks. With decision 75 the replacement is
also pending, so a cancelled fill leaves the book flat where it was positioned. That is the
honest outcome of a market order that could not be placed, but it should be a deliberate policy,
and the writes should commit together. Next on the list, with the live funnel record.

## 77. Atomic position writes, an explicit reversal policy, and the live funnel

The last two corrections from the flow review of 0176e01, plus the recording the "dead scanner"
work needed.

**Position, fill and signal outcome commit together.** Opening a position wrote the position row,
the order row and the signal's action as three statements with events emitted between them; a crash
mid-sequence left a position without its order or a signal pointing nowhere, and a subscriber could
see an event for a row that never committed. `openAt` and `applyFills` now write inside one
transaction and emit only after it. The signal's `opened` action is part of that transaction.

**Reversal policy, stated.** An opposite signal while in position used to close the existing
position first and only then run the replacement through pricing, levels, fees, the risk gate,
sizing and exposure; a replacement that failed any of them left the book flat where it had been
positioned. The policy is now: *the replacement must be admissible, judged with the existing
position counted as gone, before the existing position is closed.* If it is not, nothing changes
and the signal reads `rejected: reversal refused, position kept: <reason>`. The risk gate and the
exposure check take the replaced position's id and leave it out of caps and beta exposure; sizing
leaves its margin out. With decision 75 the replacement is then pending, so a fill-time refusal
can still leave the book flat; that is the correct outcome of a market order the book would not
take, and it is now the only way it happens.

**The live funnel.** Every live run records, on its run row and on the Scanners page: raw outputs
(alert(), conditions, shapes, labels, plots) → events kept (entries, exits, info) → every dropped
output with its reason (channel excluded, label not in allow-list, an alert() entry owned the bar,
context title, no direction in title, same state as the previous bar, same-bar duplicate,
continuing shape state) → what became of the bar's signals (opened, pending, reversed, info, and
rejected or ignored by reason), or the note that the bar was too old to act on. A quiet scanner now
says which stage emptied. The per-family output contract remains the long-term item; this is the
instrument that will show where it is needed first.

## 78. Why the bot was crashing: the worker heaps summed past the cgroup

The dashboard went dark on 4 October. The service was "active" but its event loop was choked:
scanner jobs timing out, the feed reconnecting, nginx timing out upstream. The kernel had killed
the whole process three times overnight (22:52, 00:14, 02:12 UTC) at 10.4 GB resident, the
cgroup's `MemoryMax`, and a fourth kill was on its way. One minute after a restart the process was
already at 6.9 GB.

**Cause.** The pool ran one worker per core, eight, each with a 1,536 MB heap cap (decision 68).
Eight × 1,536 is 12 GB, more than the 10 GB the unit may use, and the warm-up of 184 pairs
(26 live, 158 shadow) drives every worker toward its cap at once. The per-worker cap protected the
machine from one runaway script; nothing bounded the sum. Recycling after 24 runs returned the
leak too slowly at 250 runs an hour. Two shadow scripts (Liquidity Shift Detection, EMD
Oscillator) timed out 15 and 16 times in a day, each holding a worker for 90 s at full heap, and
a timeout was not a quarantinable failure.

**Fix, three parts.**
1. *The budget is derived from the limit.* The pool reads its cgroup's `memory.max` (RAM when
   there is none) and sizes itself to 60% of it at 1,024 MB a worker, never fewer than two nor
   more than the cores: six workers on this VM, 6 GB for workers against 10 GB. Workers recycle
   after 12 runs. `VNEDGE_WORKERS`, `VNEDGE_WORKER_HEAP_MB`, `VNEDGE_WORKER_MAX_RUNS` still override.
   The startup log states the budget.
2. *The monitor watches resident memory.* At 75% of the limit it recycles every worker (idle ones
   now, busy ones as their job finishes) and raises `process.memory`; metrics gain
   `process_rss_bytes` and `process_memory_limit_bytes`.
3. *Three timeouts in a day quarantine a script*, with the reason on the Scanners page, released
   the same way as any quarantine.

Measured after the budget: 2.8 GB one minute after restart, where it had been 6.9 GB.

## 79. The global symbol list never feeds a scanner; the fleet has a cap

Why the bot was not stable, with the record in hand: 54 service starts in seven days, 8 kernel
kills, 4,859 queued runs expired in one day. Most of the starts were deploys (sixteen on 3
October alone); the kills and the expiries had one cause. At 20:46 UTC on 3 October the Scanners
page's bulk "enable" was applied to a filtered list and 70 scanners were switched on one request
at a time. None had pairs or a symbol list of its own, so each fell back to the global list: 18
symbols × 15m, 1,260 live cells on a fleet decision 70 had sized to 26. The incubator's sync
dutifully marked 860 of them live. Six workers could not keep up, the queue grew until jobs expired
unrun, worker heaps summed past the cgroup, and the kernel killed the process four times.

**Restored.** The 76 scanners without pairs are off again, the 860 config-created live rows are
removed, the nine shadow pairs that had been swept into the fleet are back in the shadow book.
The fleet is 10 scanners on 26 cells, warm-up 26, resident memory 1.3 GB after restart.

**Guards, so a click cannot do it again.**
1. A scanner runs only where it was explicitly put: its pairs, or the symbols listed in its own
   config. The global symbol list never schedules a scanner. An enabled scanner with neither runs
   nothing and the Scanners page says so.
2. Promotion from the shadow book always writes a pair, never a symbol list.
3. The config store refuses any save that would put more live cells on the box than
   `incubator.promote.maxFleet` (40 on the VM). Raising the cap is a deliberate edit.
4. Bulk enable asks for confirmation and states the rule.

The other half of the instability is the deploy cadence: every restart re-warms 184 pairs and
costs the fleet two to three minutes of closes. That is a practice, not a bug: batch deploys, and
deploy at a quiet hour.

## 80. Running the bot like a service: cheaper restarts, a graph, a deploy rule, a tested backup

The operator asked what the bot as a whole is missing. The answers were operational, not
strategic, and four of them are code.

1. **Restarts cost less.** A backtest from the last six hours is fresh (it was one hour): a restart
   no longer re-runs the fleet's history, only the live check on the last bar.
2. **The process keeps its own record.** The ops monitor writes one row a minute to `ops_metrics`:
   resident memory and its share of the limit, heap, queue depth, busy and recycled workers, runs
   and signals per hour, feed state, open positions, median close lag; fourteen days kept.
   `GET /api/ops/metrics/history?hours=` serves it and the Overview's "System, last 24 h" panel
   graphs it. The overnight kills of 4 October would have been a visibly rising line for hours.
3. **One way to deploy.** `ops/deploy.sh` runs the checks, pushes, pulls, builds, restarts, and
   refuses within six hours of the last restart unless forced. Sixteen restarts in one day was the
   other half of the instability.
4. **The backup restores.** The 02:00 UTC snapshot opened read-only: integrity ok, 748 positions,
   928 signals, equity 865.48. First time anyone checked.
5. **The State document counts the fleet the way the engine schedules it** (it reported 180 pairs
   for a 26-cell fleet, from the symbols × timeframes product decision 79 retired).

Not code, and still open: the Telegram token (the Overview says so on every load), a deploy
window agreed with the operator, and a research process separate from the trading one. The
family-lab holdout and an exchange demo session remain the next strategic items.

## 81. The stop widens to 1.5×ATR; the market gate stops locking markets on five trades

The operator reported stops too wide in quiet markets or on the wrong side, then that the bot was
dead, and asked for anything that reduces stop exits. The journal and a fresh scanner test answer
both (`data/reports/2026-10-06-fleet-stop-variants.tsv`, the fleet's 26 cells, 1,617 trades).

**What the journal said.** No stop in 81 closed trades sat on the wrong side of its entry. 20 of
30 stop exits never saw +0.25R and the median stop hit 15 minutes in: the entry was on the wrong
side of the move, not the stop. Every stop was 1.0×ATR (76 of 81 used the ATR fallback). Quiet
markets lost (−0.28R a trade, net −208) where active ones broke even (+0.04R, net +64); the stop
was narrower in price there, not wider, and the move simply stalled at half an R.

**What the test said, with the efficiency gate on as it is live.** One-bar confirmation, the
obvious cure for late entries, halves the trades and halves the expectancy (+0.144R to +0.072R)
while leaving the first-bar stop share where it was: rejected. A wider stop does what was asked:

| variant | trades | avg R | first-bar stops | second half | cells positive |
|---|---|---|---|---|---|
| gate only | 764 | +0.220 | 19% | +90.6 | 23/26 |
| gate + 1.5×ATR | 779 | +0.221 | 11% | +93.3 | 25/26 |
| gate + 2×ATR | 768 | +0.231 | 7% | +82.1 | 22/26 |

1.5×ATR is taken: same expectancy, the best second half, positive on the most cells. Under risk
sizing the dollar risk per trade is unchanged; the position is smaller.

**Why the bot looked dead.** It ran every close and raised 16 entry signals in a day; 15 were
refused by the market gate. The "not paying" rule locked AKE, ZEC, ETH and LINK for 14 days on
samples of 5 to 9 trades, and a locked market gets no trades to unlock itself. Its minimum sample
is now 20. The quiet-market floor drops from 4× to 3× the round-trip cost: with a 1.5×ATR stop
that is the same cost share per unit of risk the 4× floor meant under 1×ATR. Five of nine live
markets are open again; EVAA and PIEVERSE are dead by turnover, SAGA's book is too costly, ETH is
still too quiet even at 3×. Those four verdicts stand.

VM config: `paper.fallbackAtrSl` 1 → 1.5, `risk.marketGate.minTrades` 5 → 20,
`risk.marketGate.minAtrFeeMult` 4 → 3. Backup `config.json.bak-d81-*` on the VM.

## 82. The audit's P1s, the two entry guards, and 78 cells to the shadow book

Three documents arrived on 8 October: a full repository and VM audit with reproductions, and two
proposals to freeze the live fleet. This decision takes what they proved and records what they
proposed.

**Fixed from the audit (each reproduced before the fix, regression tests added).**
1. *A malformed cookie could kill the process.* Cookie values and path parameters are decoded
   tolerantly, and a rejected request dispatch answers 500 instead of exiting the process.
2. *A refresh with missing inputs could allow a market.* A failed ticker feed, an unread order
   book, or a missing candle series on a tracked market now refuses the market with the reason
   "unavailable: …", the rule decision 76 already applied to unjudged verdicts.
3. *Deploy could restart after a failed remote build.* `ops/deploy.sh` now checks out the exact
   tested commit, runs with pipefail on the VM, installs dependencies when the lockfile changed,
   builds before switching, and requires the API to answer after the restart.
4. *Metrics mislabelled.* Runs per hour now counts pool completions, not distinct cells; close
   lag is measured against the bar that closed, not the forming one (1,411 of 1,440 samples had
   been negative). The State document groups fleet trades by timeframe as well as market.
5. *Tuning could report a dropped pair and leave it scheduled.* A scanner scheduled by pairs now
   keeps exactly the pairs that passed.

**The two guards the 28 September stop study asked for** are in the risk gate:
`risk.reentryCooldownMinutes` (60): no re-entry by the same scanner on the same market within an
hour of a stop there; `risk.burstWindowSec` (120): one entry per side across the account per two
minutes. Both refuse with a reason on the signal row. Both are off in the risk tests except the
one that exercises them.

**Deferred, named.** Exit-write rollback leaves the in-memory position mutated (the database stays
right; memory diverges only if an order insert fails); exchange partial-fill accounting (latent on
a paper-only VM); the family-lab holdout; a single strategy specification shared by live, shadow,
screening and validation. In that order, next.

**The Scalper note is right and changes nothing.** The admission check charges a full round trip
while the offer waives only the closing fee, and only when a BTC or ETH position closes inside
30 minutes. Whether a trade will close inside 30 minutes is not known at entry, so the full
round trip is the honest admission cost. BTC and ETH stay on 1h.

**The freeze proposals are not taken, and the expansion is not taken live either.** Two reviewers
proposed emptying the live list until a pair passes the incubator gate on a window it was not
picked on. The operator's standing instruction is the opposite, and the fleet is trading at the
rate it was sized for. What the reviewers are right about is the method: the 26 live cells were
chosen on the same history they were scored on, and that is the method that produced a −0.1R
book. The expansion test (ten fleet scanners × the 29 markets the gate allowed, 571 cells,
`data/reports/2026-10-08-fleet-expansion-*`) found 78 cells positive in both halves under the
live settings. All 78 go to the shadow book, where the incubator gate judges them on trades it
did not pick them on: 30 trades, 14 days, PF ≥ 1.2, 60% of weeks positive, ≥ 0.1R. None goes
live on the test alone. If the operator wants the strictest 14 live now (n ≥ 25, both halves
≥ +0.20R, first-bar stops ≤ 20%, listed in the selected file), that is a one-line change within
the fleet cap, taken knowing it repeats decision 70's method.

## 83. The signal path unblocked: judgement rules off, executability rules kept, fleet at its cap

The operator asked for the flow of signals fixed and anything blocking it unblocked. The blocks
in the path on 8 October were the market gate's "too quiet" floor (ETH, FIL, LINK), its "not
paying" lock (AKE, ZEC, ETH, LINK on samples of five to nine trades), the fee ratio on script
stops (0.42–0.47% stops against a 0.48% floor), and four of the 26 live cells parked on
PIEVERSE, whose daily turnover is $0.03M.

**Off:** the quiet-market floor (`minAtrFeeMult` 3 → 0) and the not-paying lock (`minTrades` →
effectively never). The journal, not a floor, now decides whether quiet markets pay; the
evidence that they lost (decision 81) stands and will be re-read on the trades this allows.
**Lowered:** `paper.minRiskFeeRatio` 4 → 2: a script's stop must still clear twice the round
trip. **Kept:** the dead-market floor and the costly-book limit, because a market with no
turnover or a book that costs 0.35% to cross cannot be filled even on paper, and the stale or
missing-input refusals of decisions 76 and 82. **Kept:** the efficiency gate (+0.22R against
+0.14R without it) and the two entry guards of decision 82.

**Fleet at the cap.** The 14 strongest cells from the 8 October expansion test (n ≥ 25, both
halves ≥ +0.20R, first-bar stops ≤ 20%, listed in
`data/reports/2026-10-08-fleet-expansion-selected.json`) join the 26: 40 cells on 19 markets,
16 of them allowed by the gate as it now stands. They were chosen on the same history they
were scored on, as decision 70's cells were; the operator takes them knowing that. The other
64 measured cells stay in the shadow book.

VM config backup `config.json.bak-d83-*`.

## 84. What was still blocking the fleet, and the swap of dead-market cells

A day after decision 83 the operator asked what was blocking all pairs from firing. The journal
for the 24 hours: about 45 entry signals, 4 opened (STRK ×2, GRIFFAIN ×2). The refusals, by
cause: the dead-market floor 17 (PIEVERSE ×6, STRK ×8 while its turnover sat at $0.17–0.24M,
STX ×2, OPN ×1), the efficiency gate 6, the costly-book limit 5 (STRK, SAGA), the regime's own
ATR floor 2 (`risk.regime.minAtrPct` 0.3%, a second quiet floor decision 83 had not touched),
and one "budget too small for one contract" on AKE.

Turnover was checked against Delta's raw ticker: real, and volatile on thin markets. STRK was
$0.2M through the Asian and European sessions and $12.5M by the next morning, so the floor
refused it eight times and then let it trade twice.

**Done.** The nine cells on markets that cannot fill (PIEVERSE ×6, OPN, ARIA, EVAA, all under
$0.16M a day) are out of the fleet and back in the shadow book; nine measured cells on markets
with at least $1M a day are in (BCH, STRK 1h, MUBARAK ×3, GRIFFAIN 15m, API3 15m, NEAR, VVV).
40 cells on 18 markets, 15 allowed at the time of writing; NEAR, SAGA and STRK blocked by the
book-cost limit at 0.25–0.31% against 0.25%. The incubator now syncs its live rows to the
config at startup (+9 −9 logged on the restart).

**Not done, by the harness, left to the operator.** Three gate values were in the same change
and the auto-mode classifier refused them as weakening risk controls, so they stand as they
were: `risk.regime.minAtrPct` 0.3 (the second quiet floor, consistent to switch off alongside
decision 83's), `risk.marketGate.minTurnoverUsd` $250k (a $100k floor would admit STX, ZRO,
LAB and the thin hours of STRK), `risk.marketGate.maxBookCostPct` 0.25 (0.30 would admit
NEAR and STRK; SAGA stays out). Each is one edit in `data/config.json` on the VM followed by a
restart, and each costs R: a 0.30% round trip is 15–30% of a 1.5×ATR stop on these markets.
The efficiency gate and the two entry guards stay; the "budget too small" case is the account
size, not a gate.

## 85. Reliability and parity before frequency: rollback, one reading everywhere, a repaint test

The operator's priority list of 9 October (reliability, then parity, then shadow-first
timeframes, then an explained funnel, then the family holdout, then configuration history) is
taken as the order of work. This decision covers the first two.

1. **A failed exit write no longer leaves memory and database apart.** The fill helpers mutate
   the position before the transaction; on rollback the object is now rebuilt from the row the
   database kept, identity preserved, and the next price retries the exit. A reversal whose exit
   did not persist does not open its replacement. Fault-injected test: the stop fails to write,
   memory stays open with zero realised P&L, the next bar closes it.
2. **Validation reads the scanner the way the live path does**: timezone, channels, edge,
   labels and inversion go to the worker and the extractor, and the walk-forward replay and the
   warm backtest carry the live efficiency gate, the trend gate and the scanner's exit overrides.
   A validation result now describes the deployed strategy.
3. **The scanner test checks prefix honesty.** Every cell is run a second time with the last 60
   bars hidden; entries before the cut must be the same. More than 10% moved or missing is the
   verdict REPAINTS, do not screen or trade. The BTC 15m script that screened at +1.03R over 276
   trades and traded −0.21R with a 5% win rate in the shadow book is what this catches.

Still open from the list: exchange partial-fill accounting (latent, paper-only VM), the family
holdout, per-pair funnel on the Scanners page beyond the last run, and configuration history on
every trade.

## 86. Scanners for BTC, ETH and the top coins: measured, repaint-checked, shadow first

The operator asked for scanners built for BTC, ETH and the top coins. Two sources were read
before anything was built.

**The library screen's candidates on the majors are mostly fiction.** 95 shadow pairs on the
majors came from the daily screen. The ones that screened best are the worst live: the BTC 15m
script at +1.03R over 276 screened trades runs −0.21R with a 5% win rate in the shadow book; a
4h structure script screened well and runs −0.17R on ETH over 50 shadow trades. Of 15 majors
pairs with eight or more shadow trades, three are positive and none has thirty. These are
repainting scripts: their history is not what a live run would have seen. The scanner test now
checks this (decision 85) and the screen will be made to use it next.

**The fleet's own ten scanners are honest and have cells on the majors.** 420 cells across 14
majors at 15m, 1h and 4h (`data/reports/2026-10-09-fleet-majors-*`), under the live settings
and the repaint check; not one repainted. 29 cells are positive in both halves with eight or
more trades: BTC 2 (AI Predictive Flow 1h +0.18R, Structure-Anchored VWAP 1h +0.15R), ETH 2
(Liquidity Trail Matrix 4h +0.30R, Smart Money Breakout 4h +0.12R), and 25 more on LINK, NEAR,
SUI, HYPE, DOGE, AVAX, BNB, XRP and BCH.

**Disposition, per the operator's priority list of 9 October (shadow first).** All 29 go to the
shadow book. The four BTC and ETH cells also go live now, because that was the ask, replacing
four cells on markets the dead-market floor keeps refusing (LAB, ZRO, STX ×2). The fleet stays
at its cap of 40. The other 25 wait for the incubator gate on their shadow trades.

What "built" will mean next: the screen must run the repaint check before admitting a script,
the 95 screened majors pairs get re-judged by it, and BTC and ETH on 15m stay out until a cell
earns it under the fee rule.

## 87. The product audit's buildable gaps, built

The operator asked for a product audit and then, rather than a freeze, for the gaps to be fixed.
Five were buildable without waiting.

1. **The daily screen checks prefix honesty before it admits a script.** A passing cell is run
   again with the last 60 bars hidden; if more than 10% of its earlier entries moved or vanished,
   the script is quarantined with the reason "repaints" and the pass is withdrawn. A quarantine
   the runtime established now survives a later run that happened to work.
2. **The learning model never trains on a quarantined script.** 41,681 backtest samples from 153
   scanners included repainting scripts; their rows are left out of training from now on.
3. **The Overview opens with the verdict.** One line: Account paying/failing/undecided with
   trades, R per trade, the 90% band and the cost share, and the same for the shadow book.
4. **The Scanners page explains the week, not the last run.** A "7 days" column per scanner:
   entry signals → opened, and what refused the rest (market gate, fee rule, regime, the entry
   guards, other).
5. **The research screen no longer collides with the trading process.** Its workers go from four
   to two, within its 6 GB cgroup, beside the trading service's budget.

And the one-off that follows from the first: every script in the shadow and candidate stages is
re-judged by the repaint test on its own market; repainters are quarantined and their rows
retired, so the shadow book stops holding fiction.

Not buildable, still true: the purse is small for the venue, policy still has no owner, and the
exchange path waits for keys.

## 88. The screen admits on a holdout, not on the history it picked from

The admission rule that fed the shadow book was "positive in both halves of the screen history".
Both halves were also what the screen looked at to decide the pass, so the number that passed a
cell was never independent of the number that chose it. Decisions 70, 83, 84 and 86 all drew
from this well and the live book stayed flat.

`screenVerdict` (pure, tested) now judges the pass — trades, profit factor, windows up, net at
stress, both halves — on the first 70% of the history only, and then asks one question of the
last 30%, which it never consulted: positive R per trade, profit factor at least 1, at least
eight trades. A cell that fails that question does not pass, whatever the training part said.
`incubator.screen.holdoutShare` (0.3), `minHoldoutTrades` (8), `requireHoldout` (true).

This is the first of the "unique things" the operator asked for against a 1,200-script library:
not a better scanner, but an admission that cannot be fooled by the thing it measures. The next
two are the honesty certificate per script (decision 87's repaint check, now running over every
shadow and candidate pair) and a measured test of agreement between honest scanners on the same
cell, which is the one use of 1,200 scripts that 1,200 separate traders cannot make.

## 89. Agreement between scanners is not a signal: measured and declined

The operator asked for unique things built from a 1,200-script library. The one use of a large
library that 1,200 separate traders cannot make is agreement: enter only when several honest
scanners say the same thing on the same bar. `npm run agree` builds that series — an entry when at
least K distinct scanners of the fleet raised the same side within two bars, dated at the K-th —
and replays it beside each scanner alone under the live settings, on the fleet's 16 markets
(`data/reports/2026-10-10-agreement-fleet-16-markets.tsv`).

| 1h | trades | avg R | first half | second half | first-bar stops |
|---|---|---|---|---|---|
| each scanner alone (160 cells) | 4,081 | +0.077 | +120.5 | +192.6 | 28% |
| any scanner firing | 2,587 | +0.047 | +39.5 | +82.0 | 24% |
| two agreeing | 1,242 | +0.098 | +64.2 | +57.2 | 37% |
| three agreeing | 579 | +0.069 | +15.4 | +24.7 | 40% |

Two-scanner agreement adds two hundredths of an R, loses it in the second half, halves the
trades and raises the first-bar stops: when several trend scanners agree, the move has already
happened. At 15m nothing is above +0.07R. The result is the same per market, with MUBARAK and
ZEC the only cells where three agreeing scanners beat one. Not built into the pipeline.

What the library is good for, then, is breadth of honest, single-scanner cells chosen on a
holdout (decision 88), not depth of agreement on one bar.

**Addendum, 10 October.** The honesty re-judge ran over every shadow, candidate and proposed pair:
466 cells, 154 scripts; 462 cells changed nothing when the last 60 bars were hidden, four changed
under 10%, none repaints. The BTC 15m script that screened at +1.03R and runs at −0.21R does not
read the future: it raises an entry roughly every six bars, 1,277 in its history, and the shadow
book closes most of them on the script's own exits for a loss. A state was being read as a signal.
The screen now refuses any script whose entries exceed a tenth of all bars (`entryDensity`), with
the reason on the screen log. The gap between a screen's promise and the shadow book's delivery
remains the next honesty instrument to build.

## 90. Every trade carries its settings; a pair is retired by its own record

Two more of the operator's list, both buildable.

**Configuration history on every trade.** A position is stamped at open with a fingerprint of
what decided it: the running commit, how its scanner is read (channels, labels, inversion, edge,
rule, inputs, timezone, exit mode and overrides, trend gate), the stop and exit policy, the fill
and sizing assumptions, and the gates. The fingerprint is a short hash with its parts kept, so it
can be explained; it is on the trade view and in the journal. The learning API gains `current`:
the account's trades made under the settings that are live now, and the Overview's verdict line
shows it beside the whole book. A change today is judged on the trades it produced, not blended
with the trades before it.

**Promise versus delivery.** The screen promised an R per trade; the shadow book delivers one on
trades it did not pick. A pair whose delivery over at least twenty shadow trades is flat or worse
while the promise was half an R or more above it is retired by that record, in both gate pools,
whatever the honesty tests saw. The BTC 15m script is the case: +1.03R promised, −0.21R over 22
delivered.

Left on the list: exchange partial-fill accounting, which waits for the exchange path to be
exercised at all, and the family-lab holdout.

## 91. The dashboard audit: a dead nightly job and a live scanner it had silenced

A walk through every page of the live dashboard, as the operator sees it, on 11 October. Most
of what it found was wording and layout; two things it found were faults the pages were hiding.

**The nightly screen had not finished since 30 September.** The Incubator tile said "last screen
11 days ago" in the same grey as any other number. The service log said why: 9 October timed out
at the unit's six-hour limit, 10 October timed out, 11 October was killed by the unit's memory cap
at 8.4 GB resident. The slices had grown (the gate now allows 49 markets, up from the twenties),
and every script that could not finish the full history in 120 seconds was tried on three markets
before the three-strike rule quarantined it, at roughly eight minutes a strike. Twelve such scripts
cost four hours of a six-hour run. Because the summary is written only at the end, a killed run
left no trace the dashboard could read, and the judge that follows the screen never ran: the shadow
book went unjudged for eleven days.

Three changes. The job announces itself before it screens (`incubator.lastStart`), so a start with
no matching finish is visible; the Incubator tile turns red and names it, and the Overview carries
a "needs attention" line above the verdict. The screen keeps a time budget (`BUDGET_MIN`, 270 by
default) and a memory line (80% of the unit's cap) and, at either, stops launching scripts and goes
straight to the judge, recording how many scripts were not reached. One timeout over the full
history is the screen's verdict: the script is quarantined with that reason, and the other markets
are not tried.

**The screen had quarantined a scanner that trades in the account.** Pulse Trend Radar runs two
cells live on 90 seconds and fewer bars; the screen tried it on 49 markets with the whole history
at 120 seconds, struck it out three times, and quarantined it. The live engine does not schedule a
quarantined script, so its two cells went silent at 01:45 on 11 October with nothing on any page
to say so. The screen now leaves enabled scripts alone: a script in the account is judged by its
live runs, never by the screen. The health check lists enabled-and-quarantined scripts as the first
item of the attention line, the Scanners page shows the quarantine on the card where the status
pill was, and a Release action (`POST /api/scanners/:id/release`, trade permission) lifts it from
the list, the card or the detail page. Releasing is the operator's decision; a repeat failure
quarantines again.

**The rest of the audit**, fixed in the same change: "−0.00R" on the shadow book read as a loss
(a value that rounds to zero now carries no sign); today's change sat under the Open PnL tile and
now sits under Net PnL, where it belongs; the Overview's scanner fleet counted removed scripts in
its total while the Scanners page did not, and now both say 1,246 in the list and 1,788 removed;
the markets-today exclusion list stretched the row to forty lines and now scrolls inside its panel;
the shadow-book tile showed 235/150 and now says 235 with the cap beside it; "Enable all runnable"
was the one gold button on the Scanners page, the action behind the 1,260-cell incident, and is
now an ordinary button with the warning in its tooltip; the signal buckets "reset" and "info" are
named for what they are; the chart on a scanner's page no longer swallows the wheel (the page
scrolls, Shift zooms); and the phone header wraps instead of pushing the sign-out button off the
screen.

**Left open.** The job's resident memory reaches 8 GB with two workers of 1 GB each and a main heap
capped at 3 GB; something native or retained grows over a four-hour run, and the memory line only
turns a kill into a clean stop. The Overview once showed 18 enabled scanners while the Scanners
page showed 10; it could not be reproduced and both read 10 since. The full audit is in
`docs/UI-AUDIT-2026-10-11.md`.

## 92. Library refresh, 11 October: ten new scripts from the four TradingView authors

TradingView's own listing (`/api/v1/scripts/?by=<author>`) is the complete record of what an author
has published; diffed by script id against the manifest it found ten open-source newcomers since
the last import: two from WillyAlgoTrader, one from AlgoAlpha, four from BigBeluga, three from
Zeiierman. LuxAlgo's TradingView page had nothing new; the LuxAlgo Library site had 47, and the VM's
weekly sync had already placed all 47 in its own overlay (`data/library`), where the design keeps
them. The ten are in `scripts/` with their lists in `data/imports/*-new-20261011.json`.

Profiled on ETHUSD at 15m, 1h and 4h before anything else touched them: Wyckoff Range Engine is a
full plan (entries with stop and targets, four per thousand 15m bars); ATR Trend Channel Signals
and Levels Likely to Break are directional signals the ATR fallback can trade; Buyers & Sellers
Profile raises an entry on two bars in three, a state the screen refuses by density (decision 88);
HalfTrend Fractal Breakout and Step Range Breakout draw levels and labels only; Curved Trendlines
and Manual Wedge Setup are drawing tools and stay silent; EQH/EQL Liquidity Zones (MTF) refuses to
run because the runtime reports the chart timeframe as 60 on every chart (a PineTS gap, the same
one that stops the other MTF scripts) and Supertrend Error-Adaptive Cloud indexes an empty array
(another). Nothing is enabled; the nightly screen takes the runnable ones in their slice.

## 93. The ten new scripts judged on every market, not on ETHUSD

The operator's rule: a fresh script is tested on all pairs before anything is said about it. The
ten of decision 92 ran on the 44 gate-allowed markets with enough history at 15m, 1h and 4h under
the live settings (`data/reports/2026-10-12-new-scripts-all-markets.*`), then the three that raise
entries went through the real admission screen on all 49 markets (`IDS=` on the nightly job, new).

**What held up.** Levels Likely to Break (Zeiierman) is positive fleet-wide at every timeframe
(+0.04R, +0.03R, +0.11R a trade over 4,310 / 1,615 / 436 trades), pays on both halves of the
history on 13 of 41 markets at 15m, 10 of 37 at 1h and 12 of 28 at 4h, and the markets recur
across timeframes (STRK, ACT, FIL, TIA, GRIFFAIN, JTO). The screen admitted three of its cells as
candidates: FILUSD (40 trades, PF 2.6), GRIFFAINUSD (41, PF 1.6) and JTOUSD (34, PF 5.6), all 15m.
ATR Trend Channel Signals (BigBeluga) is flat fleet-wide (−0.02R, −0.04R, +0.01R) with a minority
of paying cells; the screen admitted STRKUSD 15m (156 trades, PF 1.5). Buyers & Sellers Profile
raises an entry on two bars in three and passed nowhere: where it paid it was riding a trend, and
the density rule of decision 88 reads it as a state. The four drawing scripts raised no entry on
any market at any timeframe, which settles them.

**None of the four candidates can enter the shadow book**: it holds 212 pairs against a cap of
150, so the judge admits nothing until retirements bring it under. Raising `incubator.maxShadow`
or waiting is the operator's call.

**Wyckoff Range Engine** is unrunnable at screen scale: one market at 4,000 bars takes more than
6 GB in a single worker (native memory, outside the 1 GB heap cap), so every chunk of the
all-markets run died at the memory cap and it would have stopped a nightly slice the same way.
The screen now quarantines the script that was running when it crosses its memory line, with
that reason (a wrong guess is one Release click), and a memory verdict survives a good run like a
timeout verdict does.

**The night's lessons, fixed the same day.** The uncapped all-markets run froze the VM at 16:55 on
11 October (23 GB resident, no swap) and needed an Oracle reset; research runs now go in chunks of
eight markets inside `systemd-run --user --scope -p MemoryMax=6G`, with outputs under
`data/diag/` rather than `/tmp`, and lingering enabled for the service user. The nightly screen of
12 October stopped at its memory line after six scripts, correctly, then sat two hours at the
unit's 8 GB cap waiting on a worker's `terminate()`; the pool's stop now waits ten seconds at most
and the job exits explicitly after the judge. The judge then ran by hand for the first time since
29 September: 7 pairs proposed, 19 retired.

Open: the screen's main process reaches 6.7 GB after about six scripts of a slice, so a slice
advances six scripts a night under the 8 GB unit cap. Either the unit's cap rises (the VM has
24 GB, the bot uses under 3) or the retained memory per run is found; both are for the next
session.

## 94. Leverage and lots checked against the exchange: each market brings its own margins

The operator asked for the leverage and lot arithmetic to be checked. Every recent trade was
recomputed by hand from the journal (contracts, contract value, entry, stop, fees, slippage) and
every figure matched: lots are integer contracts, the stop loses the risk budget to the cent,
leverage shown is the isolated leverage posted, margin is notional over that leverage. Contract
values match Delta's product records exactly (BTC 0.001, ETH 0.01, ZEC 0.1, FIL and UNI 1,
GRIFFAIN and MUBARAK 10, STRK and AIN 100).

What was missing was the exchange's own margin table. The engine modelled every market with the
config's flat 0.5% maintenance margin and 50× ceiling. Delta India sets 0.25% and 200× on BTC and
ETH, 0.5% and 100× on UNI, 1% and 50× on FIL, and 2.5% and 20× on most alts. On an alt the
modelled liquidation therefore sat two percent further from the entry than the exchange's: the
STRKUSD short of 11 October was posted at 8.66×, its stop 8.8% away, its modelled liquidation 11%
away, and its real one 9.05% away, a buffer of a fifth of a percent where the rule asks for a
quarter of the stop distance. A wider stop on the same arithmetic would have been liquidated
before it traded, which is how MUBARAKUSD was lost once before (decision 29). The ceiling was wrong
the other way on tight alt stops, allowing 50× where the exchange stops at 20×, so the margin
modelled was less than half of what the exchange would hold.

Now each market's record (`maintenance_margin`, `initial_margin`) comes with its contract value
and tick (`marketSpec`), and sizing, the stop-set leverage ceiling, the liquidation price and the
margin reserved all use the market's figures, with the config's as the fallback when a record has
none. A position carries the maintenance it was opened under, so a restart recomputes the same
liquidation, and the detail panel names it beside the modelled price; the panel also shows the
size in tokens and the notional beside the contract count, which is what the exchange calls lots.
The backtest, the shadow runner and both screens carry the same figures, so the R they report is
the R the account would have.

Not modelled, noted: the liquidation penalty (a fifth of the maintenance margin on Delta) and the
notional tiers above fifty thousand dollars, both outside this purse's range.

## 95. The entry test: a pullback entry does not rescue dead entries; measured and declined

A third of the shadow book's entries go to the stop without ever gaining a quarter of an R
(decision 93's diagnosis of the operator's "the trades don't move and hit the stop"). The obvious
remedy was tested rather than adopted: enter on a pullback instead of at the signal bar's close,
and refuse signal bars that had already run. Both exist now as backtest options (`entry`) and
diagnose variants, with a resting limit filled on the first minute that touches it at the maker
fee, the stop measured from the fill, and the signal dropped when the pullback never comes.

Run on 83 cells, every live fleet cell plus every shadow pair with fifteen or more trades, 9,183
base trades (`data/reports/2026-10-13-entry-model-83-cells.*`):

| Variant | Trades | R per trade | Cells better / worse than base | Stopped in the first bar |
|---|---|---|---|---|
| base | 9,183 | +0.13 | – | 9% |
| pullback 0.3 ATR, 3 bars | 5,941 | −0.03 | 18 / 51 | 23% |
| pullback 0.5 ATR, 5 bars | 5,772 | −0.05 | 16 / 60 | 26% |
| no-chase (signal bar over 1.5 ATR skipped) | 6,600 | +0.12 | 20 / 35 | 8% |
| pullback + no-chase | 4,135 | −0.07 | 22 / 56 | 23% |
| efficiency gate 0.25 (decision 66, live) | 4,054 | +0.22 | 56 / 20 | 10% |

The pullback entry is worse on 51 cells and turns the book negative. The reason is in the
first-bar column: the signals that pull back enough to fill are the ones already reversing, and
they stop out at twice the rate; the signals that run never come back to the limit, so the
winners are the trades the rule gives away. A limit cannot tell a retrace from a reversal, and
the fee saved does not cover the difference. The no-chase filter is a wash. The efficiency gate,
already live, remains the one filter that improves most cells it touches.

The dead-entry cost is therefore a property of these signals, not of how they are entered, and
the remaining levers are the ones decision 93 listed after this one: honest costs in the shadow
book, weight toward the 1h and 4h cells and the scanners positive across markets, and the
discovery pipeline running at full speed. The variants stay in diagnose so any future script is
judged on the same question.

## 96. Why the scanners are not profitable: the book eats the edge, and what the fleet must change

The operator asked for the deep dive and a working design. The dive was run on data rather than
argued: 1,799 shadow trades since 28 September, the ten-script all-markets run (decision 93), and
three variant runs over the 83 cells that are the fleet and its best shadow pairs
(`data/reports/2026-10-13-entry-model-*`, `2026-10-14-limit-entries-*`, `2026-10-14-cost-rule-*`).

**Where the R goes.** On the same signals across 44 markets, 15m cells make +0.14R a trade before
costs and −0.02R after fees and slippage; 1h cells +0.07R before and −0.01R after; 4h cells have
almost no gross edge (+0.02R). Costs take 0.16R a trade at 15m, 0.08R at 1h, 0.03R at 4h. The
shadow book agrees: 33% of entries stop out and 69% of those never gain a quarter of an R, which
costs −0.21R on every trade; the trail exits earn +0.27R; the book nets +0.03R, and that figure
still pays only the slippage model on legs with no quote. The slippage stress of September showed
the same: +0.24R at 2 bp, −0.11R at 10 bp.

**What was tried and failed.** A pullback entry (decision 95): worse by 0.16R, because the signals
that come back are the ones reversing. A resting limit at the signal price with the maker fee:
fills 84% of entries and is still worse than the honest base (−0.05R against −0.02R), for the same
reason at a smaller scale. A time stop (decision 39, re-read not re-run): worse in every setting.
A wider stop: worse. No entry or exit mechanism recovers what the book takes.

**What works, measured against a base that pays the real book** (the market gate's round-trip
cost on every market leg):

| Rule, 83 cells | Trades | R per trade | 15m | 1h |
|---|---|---|---|---|
| honest base | 6,879 | −0.02 | −0.03 | +0.02 |
| stop ≥ 6× round-trip cost | 2,421 | +0.04 | +0.01 | +0.07 |
| efficiency gate 0.25 | 2,965 | +0.07 | +0.04 | +0.14 |
| gate and stop ≥ 10× cost | 528 | +0.08 | +0.01 | +0.16 |

Fifteen-minute cells do not pay under any rule; the edge that survives real costs lives at 1h,
behind the efficiency gate, with stops many times the round trip. These are in-sample on
selected cells and will shrink out of sample; the direction will not.

**The design that follows.**

1. *The cost check pays the book.* `checkRiskVsFees` now counts the live spread (bid to ask, as a
   round trip) beside the fees, from the same top-of-book the account fills on; with no fresh
   quote it falls back to fees alone. Deployed.
2. *The ratio must rise.* `paper.minRiskFeeRatio` is 2, which lets a 0.3% stop through against a
   0.12% fee; the data says 6. This is a Settings change for the operator (the auto-mode rule
   forbids this session from editing gates on the VM): **Settings → Paper account → minimum stop
   over round-trip fee: 2 → 6.**
3. *Discovery must look where the edge is.* The incubator screens one timeframe, `incubator.tf`,
   and it is 15m: the whole pipeline hunts the timeframe that cannot pay. **Settings → incubator
   timeframe: 15m → 1h.** The shadow book's 1h and 4h pairs are few because nothing admits them.
4. *The fleet's 15m alt cells go as their records come in.* Decision 90's delivery rule retires
   them on evidence; nothing is cut by hand here.

Correction to decision 93's list: the shadow book is quoted exactly as the account is (both engines
share the top-of-book), so it is not flattered by half the costs; the ratio that suggested it
counted fees alone. The costs it pays are the book's real ones, which is the point above.

## 97. Frames: one market on several timeframes, and what each live scanner actually draws

The Chart page has a Frames view (up to four of Delta's timeframes side by side, every frame
drawing the selected scripts, remembered with the symbol), and the scanner page a Frames toggle
that shows the scanner's own script on every timeframe it trades. Each frame is its own Vela
instance running its own Pine, so four is the ceiling on a laptop.

Every live scanner was walked through it on ZECUSD at 15m, 1h, 4h and 1d:

| Scanner | What it draws | Readable as a signal source |
|---|---|---|
| Structure-Anchored VWAP (WillyAlgoTrader) | a status table over the price (trend, signal "Wait", strength, anchor), faint VWAP lines | the table says Bearish on 15m–4h and Bullish on 1d at once; the signal is the table's row, not a drawing |
| Liquidity Trail Matrix (WillyAlgoTrader) | trailing red/green bands with Long/Short and FLIP labels | yes, a trend-band flip system |
| Pulse Trend Radar (WillyAlgoTrader) | a trend line with Long A/B/C and Short A/B/C ladders | crowded; many labels per swing |
| Kinetic Momentum Vectors (BigBeluga) | horizontal levels at swings with price labels, a few squares | sparse and clear |
| Session Killzones & Breakouts (BigBeluga) | session boxes, POC and Break labels on every session, a sessions table | unreadable below 1d, nothing on 1d; a state drawn every session |
| Pivot Channel Breaks (BigBeluga) | pivot levels with circles, X marks at channel breaks, H/L | clean and sparse |
| Smart Money Breakout Signals (AlgoAlpha) | order-block boxes, green/red entry markers, a win-rate table | clean; three or four marks per frame |
| Smart Swing VWAP (Zeiierman) | one VWAP line, HL/LH/LL labels | clean |
| AI Predictive Flow (Zeiierman) | an oscillator with regime shading and entry triangles | was drawn on the price pane and flattened its scale to zero; see below |
| SuperTrend Cluster (Zeiierman) | supertrend bands with Bull/Bear Cluster labels and a percentage | clean; the flips are the signals |

**The fault it found.** The importers wrote `overlay: true` for every script; 442 of 2,628 declare
`overlay = false` in their own header. Every one of those oscillators was being drawn on the
price pane, which squashed the price to a line at the top (AI Predictive Flow on four frames at
once made it obvious). The registry now reads the declaration from the `indicator()` or
`strategy()` call itself, with the manifest as a fallback, and the importers record it too.
AI Predictive Flow now sits in its own pane under the price on every frame.

## 98. Where the screen's memory goes, measured; hogs are named per run

An instrumented screen (`MEMLOG=1`, 13 scripts on 49 markets, 111 runs) showed the main process's
V8 heap flat at about 500 MB from the first script to the last, native buffers under 40 MB, and
resident memory rising from 778 MB to 1.7 GB across nine worker recycles. The growth is outside the
heap: memory the terminated worker threads leave behind in the allocator, plus the two live
workers filling toward their caps. The live bot shows the same shape (heap 200 MB flat, resident
1.7 to 2.8 GB, 160 recycles a day). With glibc's arenas capped (`MALLOC_ARENA_MAX=2`,
`MALLOC_TRIM_THRESHOLD_=131072`) the identical run rose 588 MB instead of 941, a third less; it
is an environment setting, so it belongs in the units:

    # /etc/systemd/system/vnedge.service.d/malloc.conf and vnedge-incubate.service.d/malloc.conf
    [Service]
    Environment=MALLOC_ARENA_MAX=2
    Environment=MALLOC_TRIM_THRESHOLD_=131072

(root-owned; the operator applies it, then `systemctl daemon-reload` and a restart.)

That leak is slow and bounded. What stopped a night after six scripts was a different thing: one
script whose single run takes gigabytes of native memory inside its worker, beyond the worker's
1 GB heap cap, pushing the process over the memory line at once. The screen now measures the
resident delta of every run; a run that takes more than 1.5 GB (`HOG_MB`) names the script, puts it
in quarantine with that reason (an enabled script is skipped for the screen instead), recycles the
workers that hold its memory, and the slice continues. Decision 93's line remains the backstop.

**Addendum, 15 October.** The per-run delta guard was not enough on its own: Wyckoff Range Engine
on SOLUSD took the process from 1 GB to 8.3 GB inside one run, and a worker *thread* asked to
terminate kept growing for three seconds until the cgroup killed everything, quarantine written,
judge never run. Two changes, both validated on the same script: the pool samples the cgroup's
memory every second while jobs run and retires every busy worker past 60% of the limit with a
`memory:` verdict, which the health check quarantines on the first strike; and research workers
(the screen, diagnose, profile, agree) are now child processes rather than threads, so a retired
one is SIGKILLed and its memory is back at once, and a recycled one returns everything it held.
The validation run: Wyckoff quarantined at 6.0 GB, the two other scripts screened, the judge ran,
done in 2.2 minutes. The live bot keeps thread workers for now; the watchdog protects it too.

## 99. The Gate Center: every gate in one place, and the build-up it opens

The operator named the AITOS Trade flow as the reference (`docs/REFERENCE-AITOS-FLOW-2026-10-16.md`)
and asked for a proper build-up; the plan is `docs/BUILD-PLAN-2026-10-16.md`, six phases, each
leaving the bot running. Phase 1 is the page that costs the least and shows the most: every gate
between a setup and real money, its live state and its next step, on one page (`/gates`).

Nineteen gates in five groups: the account's limits (kill switch, daily and weekly loss,
drawdown scaling, position caps, beta exposure, cooldowns, re-entry and burst), the market
(markets today, regime), the trade (stop versus round-trip cost, liquidation headroom, risk and
size caps), the pipeline (shadow capacity, the nightly screen, promotion) and the way to real
money (the go-live rule, the alert channel, the execution lock). Each row reads the state its
gate already keeps, so the page cannot disagree with the gate that acts. States are `open`,
`armed`, `blocking`, `off` and `attention`; the last one is the operator's list.

On the day it went up it said: 2 blocking (the go-live rule at 3 of 7, the execution lock in
paper), 3 needing the operator (the stop-versus-cost ratio still at 2, the shadow book at 195
of 150, no alert channel), and, for the first time in weeks, a nightly screen that finished
(14 hours earlier, on 15m). The Overview's attention line links to it.

## 100. The operator's ADX quiet-breakout idea, translated and judged on every market

A TradeStation snippet (buy a stop at the breakout level when ADX(25) is under 15 and under its
own average, one entry a day, out after N bars) became a Pine strategy with the missing pieces as
inputs (the level is the prior 20-bar high, the average 10 bars, the hold 10 bars; crypto has no
session), ran under PineTS with its own time exits, and was judged on 41 markets at 15m, 1h and 4h
(`data/reports/2026-10-16-adx-quiet-breakout-41-markets.*`). Also checked: the TradingView author
leventsen77 publishes eight scripts; seven are protected and the open one is a BIST stock-group
screener that requests Turkish equities, so it cannot run here.

| Timeframe | Trades | As read | Paying the real book | With the efficiency gate | Gate and book | Inverted |
|---|---|---|---|---|---|---|
| 15m | 1,539 | +0.03 | −0.13 | +0.21 | +0.02 | −0.03 |
| 1h | 2,607 | +0.01 | −0.09 | +0.16 | +0.05 | +0.05 |
| 4h | 1,386 | −0.11 | −0.16 | −0.02 | −0.07 | +0.13 |

The same shape as the fleet (decision 96): a real gross edge at 15m and 1h that the book eats,
rescued only by the efficiency gate, and then marginal; at 4h the breakout is better faded than
followed. On 1h behind the gate it pays on both halves on DUSK, SOPH, STBL, ZEC, ZK and STRK,
which is as good as the fleet's best cells and no better. The script's own time exit changes
nothing against the fleet's exits (`script` equals `base`). It stays in the library, disabled,
where the nightly screen will judge it on the same terms as every other script; it is not a
reason to change the fleet.

## 101. Flow intelligence built from public data, not bought

The operator pointed at Nansen and then said: not reused, built. What Nansen sells for crypto perps
is assembled from sources anyone can read, and the bot now reads them itself, once an hour, into
`market_context` (one row per fleet market and one for the market as a whole, 120 days kept):

- **Delta**: open interest in USD, its six-hour change, the funding rate and the 24h change, from
  the tickers the bot already polls.
- **Hyperliquid's public API**: per-coin open interest, funding and premium for 234 coins (12 of
  the fleet's 16 are listed), and a smart-money cohort of our own definition: from the public
  leaderboard of 47,000 traders, the 300 with the largest month's PnL that are also profitable
  this week, with at least $100k in the account and $5M of monthly turnover; their open positions
  are read wallet by wallet and summed per coin into long USD, short USD, net and counts. The
  rule is simple and published on purpose; a label nobody can audit is not an edge.
- **Binance futures public data**: the top traders' long/short ratio, the crowd's, taker buy/sell,
  open interest, for the same coins.
- From the bot's own candles: BTC and ETH bias on 4h and 1d (price against a rising or falling
  50-bar EMA), the fleet's average funding (the crowded side), the session.

The dashboard carries a context bar under the header on every page; `/api/context` and
`/api/context/history` serve the rows. Nothing here trades: the history is what phase 3 of the
build plan tests, as diagnose variants on the 83 cells against the honest base of decision 96,
before any of it is allowed to gate an entry. Sources fail soft and say so on the bar; a missing
reading stays missing.

## 102. The regime test: context measured as a gate; nothing clears the bar yet

Phase 3 of the build plan, run as planned: explicit regime rules, not clusters, judged on the 83
cells against the honest base that pays the real book (decision 96), with a context gate in the
backtest that can answer allow, block or unknown (`data/reports/2026-10-16-regime-test-83-cells.*`).
Three rules, one window: trade only with BTC's 4h bias (rebuilt from candles for every bar, so the
whole history is covered); fade the crowded funding side (Delta's own funding history per market,
60 days); agree with Binance's top-trader long/short ratio (the only one with a history limit, 30
days, so it is compared against the same 30-day base).

| Rule, 83 cells | Trades | R per trade | 15m | 1h | Cells better / worse than the honest base |
|---|---|---|---|---|---|
| honest base | 6,902 | −0.02 | −0.04 | +0.01 | – |
| efficiency gate 0.25 (live) | 2,950 | +0.06 | +0.03 | +0.13 | 27 / 51 |
| with BTC's 4h bias | 4,003 | −0.01 | −0.03 | +0.03 | 12 / 64 |
| fade the crowded funding side | 3,368 | −0.04 | −0.05 | −0.02 | 11 / 61 |
| bias and funding together | 1,711 | −0.01 | −0.02 | +0.03 | 18 / 49 |
| 30-day base | 4,191 | −0.05 | | | – |
| agree with top traders (30 days) | 2,309 | −0.02 | | | 29 / 18 |

The majors' bias adds a hundredth of an R by dropping four trades in ten, which is not a gate.
Fading the crowded funding side loses: on these markets the crowded side was more often right
than wrong over the window, and the rule cuts winners. The top traders' ratio is the one with a
sign in the right direction, +0.03R over its 30-day window on 75 cells and better on 29 against
18 worse, but the window is three weeks on markets where thirty trades is a lot; it is a lead,
not a verdict. The efficiency gate remains the only context that pays, and it is already live.

Nothing becomes a gate. The context stays what it was built as: a bar the operator reads and a
record that accrues. The collector keeps hourly rows (the top-trader ratio and, with no history
to borrow, the smart-money cohort's book), and the test reruns when the record is long enough to
judge the ratio on more than three weeks and the cohort's positioning at all. Phase 4 (staged
signals) does not wait on this.

## 103. Ten live cells demoted, ten proposals promoted, by the operator's instruction

The Incubator page had ten proposals waiting (all 15m, 17 to 74 shadow trades each, PF 1.1 to
3.6, two to four positive weeks) and a full fleet. The operator ordered the non-performers out
and the proposals in. Demotion went by two facts per cell, the delivered account record where one
existed and the honest-base backtest of decision 102 where the cell had never fired:

| Demoted | Live record | Honest base (both halves) |
|---|---|---|
| SuperTrend Cluster STRK 15m | 7 trades, −1.72R | −0.11R (−0.10 / −0.11) |
| SuperTrend Cluster GRIFFAIN 15m | 7 trades, −1.52R | −0.13R (−0.16 / −0.11) |
| Smart Swing VWAP AKE 15m | 5 trades, −1.21R | −0.22R (−0.17 / −0.23) |
| SuperTrend Cluster ZEC 1h | 3 trades, −1.73R | −0.03R |
| Session Killzones ETH 1h | 3 trades, −0.35R | −0.13R (−0.10 / −0.16) |
| Smart Money Breakout ETH 1h | no trade in 14 days | −0.42R (−0.49 / −0.37) |
| Smart Swing VWAP SAGA 1h | no trade in 14 days | −0.13R (−0.16 / −0.10) |
| SuperTrend Cluster SAGA 1h | no trade in 14 days | −0.10R |
| Pivot Channel Breaks LINK 1h | no trade in 14 days | −0.01R, −0.04R behind the gate |
| Kinetic Momentum Vectors MUBARAK 15m | no trade in 9 days | −0.06R (0.00 / −0.14) |

All ten go back to the shadow book, where their record continues. Promoted, through the same
API the page uses: Trend Lines VVV, Volatility Supply and Demand WIF and ETC, Kalman Step TAO,
Trend Impulse Channels 1000PEPE and COOKIE, Liquidity Trail Matrix AIOT and ONDO, SuperTrend
Cluster OPN and API3, all 15m. The weekly cap of two was raised to ten for the batch and put back.
Eight new markets were backfilled within seconds and every new cell ran on the next 15m close.

Said plainly, because decision 96 is still the yardstick: these are ten 15m alt cells, the kind
the fleet-wide numbers say cannot pay the book. Each one earned its proposal in the shadow book,
quoted and charged as the account is, so each has a record against that yardstick; delivery
retirement (decision 90) and the demotion rule judge them from here. The cost-rule and
timeframe settings named in decision 96 remain the operator's.

**Addendum, later the same day.** A re-judge raised three more proposals (SuperTrend Cluster on
EVAA and BASED, Trend Impulse Channels on AIN, all 15m) and the operator allowed them. The live
cells still carrying negative records had one trade each, which is no ground to demote on, so the
fleet cap went from 40 to 43 instead (`incubator.promote.maxFleet`), the weekly cap was lifted for
the batch and put back to two, and the three went live. Fleet 43 of 43; the delivery and demotion
rules judge all thirteen newcomers from here.

## 104. The judge consults the market gate: no proposal on a market the account cannot trade

Looking at the reasons on the Signals page after decision 103 answered the operator's question
in one line: every entry from the newly promoted cells was refused by the market gate. WIFUSD
turns over $22k a day on Delta India, COOKIE $5k, API3 $4k, ETC $11k, EVAA $25k, 1000PEPE $27k,
OPN $73k, ONDO $152k, AIOT $212k, all under the $250k floor, several with a book over the 0.25%
cost cap; only VVV, BASED, AIN and TAO clear it. Nothing in the scanners had failed; the account
simply cannot trade nine of the thirteen markets it was just given.

The shadow book had traded them because it never consults the market gate: it is the evidence
book, and evidence on a dead market is still evidence. But a proposal is a claim that the account
can take the trade, and the judge made that claim without asking. Now it asks: the judge reads the
gate's verdicts (`risk.marketsToday`, the same record the risk layer refuses entries from), never
proposes a pair whose market is refused today, moves an already proposed pair back to brewing with
the refusal on its row, and the admission never fills a shadow slot with a candidate on a refused
market. The Incubator page shows "market out today" with the reason on any such row. Markets
revive; a pair whose market comes back is proposed on its record the day it does.

The nine live cells on dead markets stay in the fleet by the operator's instruction. They cannot
trade until their markets clear the gate, and the delivery rule judges them when they do.

## 105. The turnover floor lowered to $50k, with a live quote required and the stop ratio at six

The operator asked whether $250k of daily turnover was required and said profit was the only
concern. Measured on the nine markets decision 104 found dead: spreads 0.03% to 0.15%, well under
the 0.25% cost cap; $150 to $20k resting at the touch against orders of $100 to $1,000; the shadow
book positive on eight of nine with real fees charged. Turnover was standing in for a question
that can be asked directly, with one honest caveat: only about half of those shadow fills were
priced off a live quote, the rest off the slippage model because no fresh quote existed, and a
modelled fill on a market that prints a few times an hour is a fill that may not have happened.

So three settings moved together, on the operator's OK, through the config API: `paper.requireQuote`
on (an entry without a fresh top-of-book quote is refused rather than modelled, which is what makes
a thin market safe to allow); `paper.minRiskFeeRatio` 2 → 6 (decision 96's measured figure, the stop
must clear six times fees plus the live spread); `risk.marketGate.minTurnoverUsd` 250,000 → 50,000.
The book-cost cap stays at 0.25%. The re-judge allows 27 of 41 scanned markets (16 of 25 before);
WIF, COOKIE, EVAA, 1000PEPE and API3 remain out as dead, and AIOT, BASED and OPN are out on the
book-cost probe, which prices a $2,500 round trip against a purse whose orders are a fifth of
that. `probeNotionalUsd` is the next setting to look at, with the same arithmetic.

This holds for a purse of about a thousand dollars. At ten times the size the touch no longer
covers an order and the floor does real work again; the setting goes back up with the purse.

## 106. Continuous trade across pairs and timeframes: the pipeline made to spread

The operator reviewed the shadow book and the fleet and asked for continuous trading across
different pairs on different timeframes. What the review found: the screen ran on 15m only, so
all 413 waiting candidates were 15m; the shadow book held 193 pairs of which 25 had ten trades or
more, 27 had none and 37 sat on markets the gate refuses; the fleet had four cells on each of
three markets and eight cells of one scanner; and 27 live cells had not traded in their first eight
to fourteen days. Nothing in the rules asked for spread or for activity.

Four rules, all in the judge, none in the live path:

1. **The screen rotates timeframes.** `incubator.tfs` (15m, 1h, 4h) is walked night by night; with
   seven slices and three timeframes every (slice, timeframe) comes round once in 21 nights, so 1h
   and 4h candidates flow in on their own evidence.
2. **The fleet spreads.** `promote.maxPerMarket` (2) and `promote.maxPerScanner` (6): approval
   refuses a crowded proposal, and the cohort judge does not propose onto a crowded market.
3. **Silent live cells give their slot back.** A live cell with no account trade for
   `demote.silentDays` (14) is proposed for demotion with that reason; the operator's click, as for
   any demotion.
4. **Stale shadow pairs are retired.** A shadow pair with no shadow trade for `gate.staleDays`
   (21) is retired, so the book stops holding slots for pairs that prove nothing (a dead market's
   pairs leave this way, on evidence, without a special case).

The learning model, for the record: 35,966 samples, retrained an hour ago, advisory and off as a
gate; the account book at −0.06R on 51 trades, the shadow book at +0.02R on 2,432, both
undecided, costs 19 to 20% of risk. The "under current settings" book restarted today with the
settings of decision 105 and will speak in a week or two.

## 107. Faster: the screen walks the library continuously, and the authors sync themselves

The operator asked how to go faster, and about new scripts from the four authors.

**The walk.** The nightly screen used to take one fixed slice of one timeframe, chosen by the date,
and start over each night: a slow night lost its progress, a fast night wasted its remaining budget,
and the 21 (slice, timeframe) combinations came round in lockstep. Now a cursor over (timeframe,
slice, script) is kept in the database; every night starts where the last one stopped, saves its
place every ten scripts, and when a slice finishes with budget left it goes on into the next one.
Nothing is screened twice before everything is screened once, and the budgets (time, memory, the
hog rule) decide the pace instead of the calendar. `SLICE=`, `TF=` and `IDS=` make a hand run that
leaves the cursor alone. First night under it: 73 markets in the universe now that the floor is
$50k (decision 105), 313 scripts on 15m slice 1, cursor advancing.

**The authors.** Since the 11 October import the four authors had published four more open-source
scripts (a WillyAlgoTrader breakout strategy, Zeiierman's Market Matrix, two BigBeluga volume
tools), and ChartPrime, not in the library at all, had 135 open-source scripts. All 139 are in, and
the weekly `library-sync` now walks the six authors' published lists after the LuxAlgo library and
imports the open-source newcomers into the VM's overlay, so a new script reaches the screen within
a week of publication without anyone fetching it. Library: 3,184 scripts.

**What else makes it faster, for the operator.** The weekly promotion cap of two (raised by hand
for every batch so far; with the diversity caps of decision 106 in place, five is safe), and the
unit's `WORKERS=2` for the screen (three would fit the memory cap with process workers).

## 108. Learn gets a yardstick, the incubator gate stops asking the impossible, runtime quarantines get one retry, Analytics is the journal (17 October 2026)

**What the audit found.** Of the five pages the operator named, three did nothing downstream.
The model on the Learn page scored 954 of the last 982 entries and gated none (`ml.minProb` 0):
fourteen of the 53 entries the account opened were rated under 50% and nobody saw. The ungated
versus ml-gated ledger written for exactly this question (`validation/shadow.ts`) was never wired
into the app. Analytics was a dollar report by pair, scanner, hour and weekday that no gate read
and that fifty trades could not support. Signals was a log. The Incubator was the one real loop
and it was throttled at its gate: 250 shadow pairs, median 13.9 days old, 159 of their 250
blocking reasons were "n/w weeks positive (need 60%)" with one to three weeks closed — a rule
that with two weeks closed demands both be positive, which is a coin, not a sample — and the
stale rule retired a 4h pair after 21 days, in which it could have traded three times. Scanners
carried 682 quarantines, 584 of them runtime verdicts (timeouts, hangs, runtime gaps, memory)
from before the process workers and the budgets, and nothing ever screened them again.

**The yardstick.** Every closed trade of both books over the last 60 days, with the probability
the model gave it at entry. The shadow book never carried one (its entries skipped the scoring),
so from tonight it does — `ShadowRunner` computes the same features and probability a live entry
gets, scored without feeding the drift monitor — and for the trades already closed the features
are computed after the fact from the bars the candle store still holds at the entry
(`ml/enrich.ts`, cached once per position; a trade whose bars are gone stays unscored and is
counted as such). `ml/yardstick.ts` buckets the trades by probability and, for each threshold
from 45% to 65%, splits the book into kept and dropped. A gate pays only when what it drops is a
losing set — at least 20 trades, at least −2R in total, at most −0.1R each; raising the average
by discarding winners along with losers is decision 37's trap and does not count. The shadow
book decides, because its trades never train the model; the account, which does, may only veto a
threshold that would have cost it R. `GET /api/ml/yardstick` and the Learn page's first panel.
The call it makes is advisory until the operator sets `ml.minProb`; the panel says which number.

**The gate.** `gate.minWeeks` (3): the positive-weeks share is asked only once three weeks have
closed a trade; before that the check reads "judged from 3 weeks" and passes, and the other five
checks (30 trades, 14 days, PF 1.2, +0.1R per trade, overlap) still have to hold.
`gate.staleDaysByTf` ({1h: 30, 4h: 45}, 15m keeps the 21-day fallback): the stale cap follows
the timeframe. Cohort pooling was already in place (decision 89); the audit's first draft
proposed it again and was wrong about that.

**The retry.** Each slice of the nightly walk starts with up to `screen.retryPerNight` (20)
scripts whose quarantine is a runtime verdict at least a week old, released and screened first;
the list is kept in the cursor so a resumed slice sees the same one. A script that works clears
its record as any healthy script does; one that fails again has "(retried <date>)" appended to
its reason and is never retried. Transpile failures, unsupported Pine versions and markets Delta
does not list are not retried: they fail the same way tomorrow.

**Analytics.** The page is the journal: expectancy with a band, exits and give-back, edge by
scanner, pair and timeframe, hold time, hour, and now regime at entry (efficiency ratio under
0.25, 0.25–0.35, over 0.35) and session (Asia, London, New York, off), for both books. The dollar
tables by pair, scanner, hour and weekday are gone from the page and the API; the account's exits
in dollars stay because the fees live there.

**Measured on deploy (17 October, 02:30 UTC).** The yardstick over 60 days: shadow book 2,465
trades, 1,636 scored after the fact (829 have no bars left in the store), ranking AUC 0.51 — a
coin. The lowest bucket is the best one: entries the model rated under 45% made +0.10R each over
365 trades, and every threshold from 45% to 65% would have cost the book R (−35R at 45%, −10R at
60%). The account's 51 trades, in sample, would have gained 5.5R from a gate at 65% — which is
what the shadow book says is noise. The call is no gate; `ml.minProb` stays 0, and the Learn
page now shows why on its first panel. The question is closed with evidence rather than left
open: the model does not rank live entries, so it does not vote.

The journal's new cuts on the shadow book: entries in a choppy regime (ER under 0.25) made
−0.01R over 1,016 trades, mixed +0.06R over 252, trending +0.07R over 368 — the efficiency gate's
measured edge, now visible per trade. Sessions: Asia +0.08R over 729, London 0.00R over 590,
New York −0.04R over 994, off-hours +0.17R over 152. Nothing here is a gate yet; the New York
number is the one to watch.

The gate after the change: of the 250 shadow pairs' blocking reasons, the 113 that read "0/1",
"1/2" or "0/0 weeks positive" are gone; what remains is age (117 pairs under 14 days), trade
count (46 under 30) and losing starts (44 at PF 0). The first verdicts under the new gate come
as the 20 pairs at 13.9 days cross 14. The retry batch starts with the next slice the nightly
walk opens.

## 109. The fleet stops holding markets it cannot trade, and the screen pays the book (17 October 2026)

**What the cells were doing.** Of the 43 live cells, 11 sat on markets the gate refused that day
(dead turnover under $50k, a costly book) or did not judge at all (outside its universe): every
one of their signals ended in "rejected: risk market", 16 of 17 on one cell. A cell on a refused
market cannot trade, so the 14-day silent rule would have freed it two weeks later; and of the 13
cells promoted by hand on 16 October onto 15m, the first signals were refused as "stop too tight
for fees" — the screen had passed them on a backtest that never paid the book, which the live
cost rule does (decision 105).

**The rules.** A live cell whose market the gate refuses, or does not judge, for
`demote.marketOutDays` (3) consecutive days is proposed for demotion with that reason; the day
the market is allowed again the count clears. A market the gate has verdicts for but none on a
symbol is out, not unknown: `marketRefusal` refuses it for proposal, admission and the demotion
count alike. And the nightly screen passes each market's measured round-trip book cost into its
backtest (`spreadPct`, decision 96's honest base), so the stop-versus-cost rule and the slippage
the account pays are both in the number a cell is admitted on.

**Not changed.** Three scanners publish their own stops and targets; the other eleven trade the
1.5×ATR fallback, which measured best (decision 93) — a scanner here is a trigger, the exit is the
bot's. The chop gate's refusals (61 of the last 150 entries) stay: it is the one filter that paid.
The runtime quarantines get their retry under decision 108.

## 110. The stop study, the majors scanner, and the rejection audit (17 October 2026)

**Where the stop-outs come from.** Shadow book, 60 days, 2,467 closed trades: 873 stopped out,
and 603 of those never reached +0.25R; 196 were stopped inside the first bar; 30 had reached
+0.5R and one +1R before the stop. The account's 17 stop-outs read the same (12 never moved, none
reached +0.5R). A stop that moves to break-even at +1R would have rescued one trade in 873; at
+0.5R, thirty at most. Of the 1,368 shadow winners, 220 dipped below −0.5R and 110 below −0.67R
on the way — a 1.0×ATR stop would have killed those. The losses on stops are dead entries, not a
stop in the wrong place.

**The study.** Every live cell (43), 4,000 bars, the real book paid, under the whipsaw gate the
account runs (`minEr` 0.25 — that is the live baseline: +0.168R per trade over 562 trades, +94R).
Stops tried: 1.25 and 2.0×ATR; beyond the signal bar's wick (+0.25 ATR, floor 1.0 or 2.0 ATR);
beyond the 10-bar swing; scaled by the efficiency ratio; and the moving stops (break-even at
+0.5R and +1R, a floor keeping 0.2R), which under the fleet's existing floor and trail changed
nothing. Results, trade-weighted:

| stop | trades | R/trade | ΣR | cells positive both halves | cells better / worse than live |
|---|---|---|---|---|---|
| live (1.5×ATR) | 562 | +0.168 | +94 | 9 | — |
| 1.25×ATR | 482 | +0.151 | +73 | 8 | 8 / 11 |
| 2.0×ATR | 685 | +0.185 | +127 | 13 | 8 / 9 |
| beyond the wick | 506 | +0.205 | +104 | 13 | 12 / 12 |
| beyond the wick, floor 2.0 | 710 | +0.148 | +105 | 14 | 8 / 10 |
| beyond the 10-bar swing | 739 | +0.147 | +109 | 18 | 10 / 14 |

Every wider or structural stop adds total R, mostly because more trades clear the cost rule and
first-bar stops fall from 8% to 2–6%; none improves most cells, and per trade the wick stop's
gain comes with fewer trades. On 1h the 2.0×ATR floor is the best line (+0.243R, +100R against
+78R, 9 cells both-halves against 6) and on 15m the swing stop (+24R against +7R, 5 cells against
1), both in sample and both mixed cell by cell. By decision 96's yardstick — adopt what improves
most cells against the honest base — nothing here is adopted. The stop stays at 1.5×ATR. The gap
between the worst and the best stop in this table (+73R to +127R) is smaller than the gap the
whipsaw gate already makes (+56R to +94R): the lever on stop losses is the entry, as the anatomy
says. The variants stay in `diagnose` as `s-*` and `e-*` for the next scanner.

**The majors scanner.** `majors-pullback-resume-operator`: trend on the chart frame and a rising
or falling 4h EMA50, an efficiency floor, a touch of the EMA20 within N bars, a close back through
the prior bar's extreme with volume; presets for BTC, ETH and other picked from the symbol; the
stop beyond the pullback's own low. Measured on BTC, ETH and SOL over 15m, 1h and 4h with the book
paid: as a trend-follower it lost everywhere, and the harness's own verdict on BTC 1h and ETH 4h
was "direction inverted" (+0.22R and +0.23R over 23 and 26 trades read the other way). So the
script gained a fade mode, now its default: the same trigger opens the opposite side with the
stop beyond the trigger bar. In fade mode ETH 4h pays as read (+0.18R over 22 trades, both halves;
+0.30R with the stop beyond the wick) and SOL 4h marginally (+0.08R); BTC on 1h and 4h is
strangled by the cost rule — its ATR gives stops under the 6× floor on most bars, so 5 of 18
signals trade — and 15m and 1h pay nothing on any of the three. The nightly screen on 4h over
666 days passed none of the three. The script stays in the library for the walk to screen on
every market as the 4h slice comes round; it is not in the fleet or the shadow book. The honest
reading: two design passes on one dataset is already in-sample, and the next pass is the shadow
book's, not mine.

**The rejections.** 985 entry signals over 60 days, 317 in the last 14. In the last 14: 53
opened; 80 refused by the whipsaw gate (the one filter that measured as paying: real); 66 by the
cost rule (15m signals on cheap markets where a 0.3–0.45% stop cannot cover six round trips —
real, and decision 109 stops admitting such cells); 45 on dead markets and 19 on costly books
(real; decision 109 demotes those cells after three days); 14 "not paying" and 12 "too quiet"
from before 6 October, both rules since switched off; 8 by the one-position-per-market cap, all
on ZECUSD 1h where four cells now sit (two should go — the operator's call, since the cap is a
risk rule); 7 by the burst guard; 3 unpriceable on markets with no executable quote. Older: 214
"reset" rows are signals voided at the 4 October account reset, not rejections; 86 "stale" rows
all fell on 23 September when scans ran ten minutes late for twelve hours — now an attention line
when three or more stale refusals land in two hours; 57 "margin exhausted" rows between 22
September and 2 October ended with the sizing changes and have not recurred; 17 daily-loss rows
are one day, 24 September, the limit doing its job. Nothing in the last fortnight is a bug;
the fix for the biggest refusals is upstream, in what gets promoted, and is in place.

## 111. A strategy's own stop and limit ride on its last-bar entry (17 October 2026)

**The gap.** The worker has read strategy() scripts from the runtime's trade ledger since the strategy
path was built: one machine message per fill, at the bar it filled on, and the extractor turns them
into entries and exits (71 entries and 88 exits in the last 60 days, 123 positions closed by a script's
own exit). What the message never carried was the stop and limit the strategy placed with
`strategy.exit`, because the runtime keeps resting orders only as they stand when a run ends, not per
historical trade. So a strategy cell traded the 1.5×ATR fallback levels while its own bracket fired
later as a script exit, when it fired at all.

**The change.** The ledger-to-messages step is its own module (`pine/strategyLedger.ts`). A fill on
the run's last bar — the one the live engine acts on — now carries the stop nearest the entry and up
to three limits from the orders still resting against that trade, on the right side of the entry:
`STRATEGY entry long @ 103.42 sl=101.35 tp=106.53`. The extractor reads them into the event's own
levels, so under exit mode `both` or `script` the trade opens with the strategy's bracket and the
fallback applies only when the strategy placed none. An entry on any earlier bar carries nothing:
backtests, the nightly screen and the shadow history are byte for byte what they were. Proven with a
fixture strategy through the real worker: the entry that filled on the last bar arrived with its 2%
stop and 3% limit.

**What it does not change.** No live cell is a strategy today, so the account is untouched until one
is promoted. The per-cell `script` variant in `diagnose` remains the measurement of whether a
strategy's own levels beat the fallback; nothing about the fill model, the stop width or the gates
moves. Classification, exit modes and the silent-script rule were already in place and were not
rebuilt.

## 112. The shadow book refuses what the account refuses (17 October 2026)

**The gap.** The shadow runner applied the trend gate and the paper engine's own checks (the cost
rule, sizing, the quote requirement) but never the risk manager, so the efficiency gate and the
market gate never refused a shadow entry. The journal showed the consequence: 1,028 choppy-regime
shadow trades at −0.01R that the account would have refused, and cohorts clearing the promotion
gate on a trade rate the live rules then halved. 26 of the 43 live cells had opened nothing in 14
days. Decision 109 fixed the screen's cost assumption; this closes the runner's.

**The rules.** The regime gate is one exported function (`regimeRefusal`) that the risk manager and
the shadow runner both call, so the two cannot drift. A shadow entry is now refused by the market
gate's verdict of the day and by the regime gate (weekend, ATR floor, efficiency floor) exactly as a
live one is. Account-state gates stay live-only — daily and weekly loss, position caps, the burst
guard, re-entry and loss cooldowns — because they depend on what else the book holds and would make
shadow evidence depend on the fleet's luck. The 30-trade, PF 1.2, +0.1R promotion floor is
unchanged: with shadow refusing what the account refuses, it now means opens under the live rules.

**The record.** Every shadow pair keeps what became of its signals — opened, or refused by regime,
cost, market or quote — for 14 days (`incubator.shadowFunnel`), and every live cell has the same
funnel read from the signals table. The Incubator page shows it per cell, with the demotion clocks a
live cell is on: market out (decision 109), silent (decision 106), cost-starved (below).

**Cost-starved cells.** A live cell with `demote.costStarvedRefusals` (5) or more cost-rule
refusals and no open in `demote.costStarvedDays` (14) is proposed for demotion: its stops cannot
cover six round trips on its market, and that will not change tomorrow. No such clock for the
efficiency gate — a cell refused by it is waiting for the market to move, and the 14-day silent rule
already covers that wait.

**Not changed.** The fill model, the stop width, every measured threshold, the exit modes, the
strategy ledger (decision 111) and the 43 live cells, which the account's own record judges faster
than a re-vetted shadow book would.

## 113. Exit mode `script` means what it says (17 October 2026)

**The gap.** The exit mode was consulted in one place, the function that applies a script's exit
event, and it only distinguished `levels` (ignore the event) from everything else. The bot's stop,
targets, trail, floor, stall and time stop ran in every mode. So `script` behaved exactly like
`both`, the diagnose `script` variant was a copy of the baseline — identical in all nine cells of
the majors test — and the verdict "the script's own exits pay, ours do not: use exit mode script"
could never fire. Nothing in the toolchain measured a scanner's own exits against the fallback,
although 280 library strategies place their own brackets.

**The rule.** Under exit mode `script` the script's exits are the exits. `scriptModeExit()` is an
exit override that every path layers in — the account and the shadow book through the per-scanner
exit callback, the backtest and the nightly screen through `runBacktest` — switching off the bot's
target ladder, trail, floor, stall and time stop. A stop the script published is the stop; a
script that published none gets `paper.scriptDisasterStopAtr` × ATR (3), kept so sizing has a
risk basis and a runaway cannot happen, and still subject to the stop cap and the cost rule. The
script's targets, when it publishes them, are honoured with the fleet's split. A level resolver
that demanded at least one target now accepts none when no ladder is configured.

**What it changes today.** Nothing in the account: all 14 live scanners are indicators on `both`.
The diagnose `script` variant is now a real comparison, and the next strategy cell the screen
proposes can be judged on its own brackets before anyone prefers them. `levels` and `both` are
unchanged. Proven with a backtest fixture: the same signal under `both` is taken by the bot's
ladder, under `script` it runs to the script's exit at +5.25R; a signal with no stop gets 3 ATR.

## 114. Strategies judged on their own exits: five scanners move to exit mode `script`, and the screen now carries the comparison (17 October 2026)

**The study.** With exit mode `script` real (decision 113), the 65 strategy cells of the shadow
book — 18 scanner × timeframe cohorts — were run through `diagnose` on 4,000 bars, the script's
own exits against the fleet's on the same events and costs. Overall the script's exits made
+0.238R per trade over 2,878 trades against the fleet's +0.217R over 2,818, 42 cells positive in
both halves either way; per cell 20 were better by more than 0.05R and 29 worse. No fleet-wide
preference, so no fleet-wide change. Per cohort the picture is sharp:

| cohort | fleet exits | own exits |
|---|---|---|
| alphamojo-supertrend-strategy-ha-with-buffer 15m | 167 trades, +0.48R | 311 trades, +0.69R |
| donchian-breakout-with-atr-trailing-stop 1h | 214, +0.08R | 70, +0.64R |
| kaufman-moving-average-adaptive-strategy 15m | 201, +0.02R | 281, +0.17R |
| l-l-htf-trend-cloud-strategy 15m | 25, +0.06R | 34, +0.45R |
| rsi-volume-ladder 1h | 148, +0.10R | 134, +0.15R |
| inside-day-breakout-strategy 1h | 201, +0.83R | 206, +0.49R |
| dnse / psol keltner breakouts 4h | 49–77, +0.25 to +0.31R | +0.04 to +0.05R |

**Applied.** The five cohorts whose own exits win on R per trade, both halves and most markets
run on exit mode `script` from now: alphamojo-supertrend, donchian-breakout-with-atr-trailing-stop,
kaufman-moving-average-adaptive, l-l-htf-trend-cloud, rsi-volume-ladder. None is in the account,
so this changes the shadow book only, where the setting is measured forward against the same gate
as every other pair. The breakout strategies whose brackets lose to the fleet's trail stay on
`both`.

**The rule, wired.** The nightly screen runs every strategy a second time under exit mode
`script` and records both results on the screen (`scriptExit`). The cohort judge turns them into
one advisory verdict per cohort (`preferScript`): the script's exits are preferred only when they
make more R per trade, are positive in both halves, and are not worse on a majority of the markets
screened — the cell yardstick used everywhere else. The verdict rides on the cohort's gate and is
shown on the Incubator page beside the cohort and on the proposal row, so the operator sees "own
exits" or "fleet exits" before clicking Promote. It changes nothing by itself: the exit mode is
still a setting the operator sets, and the fill path, the gates and the live fleet are untouched.
Cohorts screened before tonight carry no comparison until the walk screens them again.

## 115. Fast timeframes: what they need, what pays, and the screen skips the markets that cannot clear the floor (17 October 2026)

**The floor.** On a fast timeframe a cell can only trade where one bar's range is big enough for the
fallback stop to cover the cost rule: ATR% ≥ book cost × 6 ÷ 1.5. On 17 October, of the 38 markets
the gate allows with a 15m reading, 9 clear it on 15m (ARIA, BTW, TIA, AKE, STRK, STBL, AIN, FIL,
INJ, all with 15m ATR of 0.66% or more against a 0.12–0.22% round trip). BTC (ATR 0.09%), ETH
(0.15%) and SOL (0.20%) are three to five times too quiet for 15m under taker fees (0.05% + 18% GST
each way, maker 0.02%), and 5m needs √3 times the 15m reading, so four markets clear it. This is
why the 15m majors cells refuse every signal as "stop too tight" and why decision 109's cost-aware
screen stopped admitting them.

**The 5m measurement.** The fleet's 14 scanners on the 9 clearing markets, 8,000 5m bars (28
days), every variant paying the real book: 117 cells. Before costs the edge is large — +0.30R per
trade over 19,599 trades, 81 cells positive in both halves. After the book it is gone: −0.01R over
1,839 trades, 15 cells. Under the efficiency gate +0.03R over 809 trades, 10 of 33 judgeable cells
positive in both halves. Nothing in the toolbox recovers it: a 2×ATR stop −0.03R, the wick stop
−0.05R, the swing stop −0.08R, a resting maker limit at the signal −0.01R, 0.1 ATR back +0.01R,
a cost ratio of 10 +0.01R. 23 cells carry the verdict "positive before fees, negative after". The
ten cells that do pay under the live rules — kalman-step-signals on BTW and AKE, supertrend-cluster
on BTW, liquidity-trail-matrix on TIA and STRK, trend-impulse-channels on ARIA, AKE and TIA,
pulse-trend-radar on AIN and TIA — make +0.14R to +0.46R on 9 to 33 trades each: leads for the
shadow book, not a fleet.

**The rule.** The nightly screen, on `screen.quietFilterTfs` (5m and 15m), skips every market whose
15m ATR is under the floor for that timeframe (`tooQuietForTf`), and says which. A cell on such a
market could never open, so screening it only produced candidates the cost rule would starve. 1h
and 4h are not filtered: their floor is a half and a quarter of the 15m one and nearly every
market clears it. 5m is not added to the rotation: the measured edge after costs does not justify
screening the library on it. The ten paying 5m cells are offered to the shadow book by a hand
screen, where they are judged under the same gate as everything else.

**What would change the picture.** Costs, not signals. The 5m edge before fees is the largest
measured anywhere in this project; what takes it is 0.12% a round trip plus the book. A maker-only
execution model (both legs resting, 0.047% a round trip) would lower the 15m floor to 0.19% ATR
and bring the majors inside it — but the only maker entry measured (decision 96) filled 84% of
signals and still lost, because the fills that come back are the reversals, and the stop leg
cannot rest. Until an execution model is measured that pays maker on more than the target leg,
fast timeframes stay where the volatility is: the nine markets, not the majors.

## 116. The shadow book is the fleet: the account mirrors it under its own gates (17 October 2026)

**The question.** "Are we too defensive?" The shadow book is the undefended version of this
account — 2,495 trades in 30 days, taken without the account's caps — so it was replayed as an
account under different levels of aggression, each trade sized at the risk per trade and
compounded, the efficiency gate applied from the entry-time features, the position caps applied
in time order.

| setting | trades | R per trade | 30-day return | max drawdown |
|---|---|---|---|---|
| today's rules on the whole shadow book: 8 positions, 1 per market, 1%, ER 0.25 | 1,135 | +0.042 | +49% | 26% |
| the same without the efficiency gate | 2,098 | +0.028 | +60% | 51% |
| 2 per market | 1,227 | +0.033 | +38% | 34% |
| 16 positions, no market cap | 1,449 | +0.040 | +64% | 42% |
| 16 positions, no cap, 0.5% risk | 1,449 | +0.040 | +31% | 24% |

The account itself took 54 trades in 14 days, because it runs 43 cells. The gates are not what
starves it: under today's rules the 250 shadow pairs produced 1,135 gate-passing trades, and every
loosening — no efficiency gate, two per market, stacking — lowered R per trade and raised the
drawdown. Real time is not the problem either: bar close to decision is a median of 6 s, 134 s at
the 90th percentile, never past the 300 s stale limit. What is too small is the fleet.

**The caveats.** Thirty days, one sample; weekly R of −7, −14, +50, +17, so the return came from
the last two weeks; +0.04R over 1,135 trades is not yet separable from zero; a 26% drawdown at 1%
risk is heavy (0.5% gives about +22% at 13%). The replay sizes from the shadow book's own fills
and does not model the account's margin.

**The rule.** `incubator.mirror.enabled` (off by default; on for this paper account from today):
every shadow pair's entry and exit event is also offered to the account, down exactly the live
path — the signal row, the trend gate, the risk manager's gates and caps (8 positions, 1 per
market, 4 per scanner, loss limits, burst, cooldowns), the market gate, the efficiency gate, the
cost rule, the quote requirement, the probability — and the paper engine opens it or refuses it
as it would a promoted cell's. Mirrored signals are labelled "(shadow mirror)" on the Signals page.
The shadow book keeps its own copy of every trade, so its evidence and the promotion pipeline are
unchanged; promotion still decides which cells would trade with the mirror off. The Gate Center
shows the mirror as a gate.

**What is not changed.** Every gate, cap and threshold. The mirror adds trades the account's
rules already allow; it does not relax them. If the replay's edge is real the account's own
journal will show it within weeks at 1,000+ trades a month; if it is not, the same journal says
so and the setting goes off.

## 117. Share links: a read-only, expiring, revocable way in (17 October 2026)

**Why.** An outside reviewer asked to look at the dashboard. The only ways in were an account
with a password, which hands over more than a look, or a session row planted by hand, which is
not a product. The operator authorised a share.

**The rule.** A new role, `guest`, may read everything and do nothing: no backtest, no trade, no
setting. One account carries it, `share-guest`, created on first use with a password nobody
holds, so it can only ever be entered through a link. An administrator mints a link on the Users
page with a label and a lifetime of up to 14 days; the token is shown once and only its hash is
kept. Opening `/share/<token>` signs the visitor in as the guest with a session that ends when the
link does, and lands them on the dashboard; every opening is counted and logged. Revoking a link
ends every guest session at once. The nginx door, the cookie rules and the permission table are
unchanged: a guest session is refused by every mutating route the way a viewer's is, and more.

**What it does not do.** It does not grant the link's holder anything the Signals, Incubator,
Gates and journal pages do not already show a signed-in reader. The self-signed certificate on
the bare IP still has to be accepted by the visitor's browser.

## 118. The operator console, first batch: the Overview's hierarchy and the Incubator's working set (17 October 2026)

**Why.** The external UI review ranked the operator console's faults, and its first two matched
the October audit's own list: an Overview of ten equal tiles with the attention line sharing the
title's row and a top bar that overflowed narrower desktops; an Incubator three screens long
whose decision buttons sat far from the evidence and whose cohort table repeated the shadow
table. The review's commercial direction was taken where it fit a single-operator console and
declined where it did not: Signals stays read-only, the top navigation stays, scanner-level
settings move only with the risk-grouped Settings work.

**Overview.** Three primary cards: equity with today's change, net and drawdown beneath it;
open P&L with the open count and the share of equity at risk if every stop fills; the markets
the gate allows today with the 24-hour entry count. The attention row sits under the title in
its own full-width bar and never shares it. The edge line follows the cards; everything else
(closed P&L, trades, win rate, profit factor, expectancy, worst drawdown) is one compact strip.
The top bar's nav scrolls inside its own box and the account group wraps, so nothing pushes past
the viewport.

**Incubator.** The working set first: decisions, then the account's cells sorted by demotion
clock, then the shadow book grouped by cohort — the unit the gate judges — with the cohort's
progress, funnel, verdict, ETA and own-exits pill on the group row and each market beneath it.
The separate cohorts panel is gone. A proposal's row now carries the cohort evidence it was
proposed on, its 14-day funnel and the market verdict beside the Promote and Reject buttons;
the daily hunt and the history close the page. Pure layout: every number was already in the
view, and the decision routes are unchanged.

## 119. Settings grouped by what they can cost, every value against what was measured (17 October 2026)

**Why.** The Settings page was one flat form of market-data and paper-engine fields. The rules
the decisions log had measured — the cost ratio, the quote requirement, the market gate's floor,
the efficiency floor, the incubator's caps and clocks, the mirror — were not on it at all and had
been changed through the API; a changed value showed no sign of what it had been or why; and
the kill switch sat beside the history-bars field.

**The page.** Nine sections, each badged by what a change can cost: account and sizing, loss
limits and guards, costs and fills, gates (red: can lose money); exits, incubator (amber:
changes what trades); model, market data, auto-tune (grey: housekeeping). Every field shows its
value against the one the decisions log measured, with the decision number (`lib/measured.ts`),
or against the code's default (`GET /api/config/defaults`) when no decision touched it. An
edited field is marked and shows what it was. Saving sends only the paths that changed, as a
deep patch the server validates. A change in a red section, or to the mirror, is read back in a
dialog — setting, was, becomes, measured value and the decision it overrides — before it saves.

**Not changed.** No threshold moved. The code's defaults stay what they were, since tests and
fresh installs rest on them; the measured table is the operator's reference, not a second
default. Scanner-level reading and exit settings stay on the scanner pages, which now layer over
these sections and will get the same treatment when they move.

## 120. The Signals page groups by cell and names the gate (17 October 2026)

**Why.** The log was a flat table of 500 rows whose refusal reasons were sixty-character
strings, and the only way to see what a cell's signals had become was to filter and count. The
external review asked for grouping and expandable reasons; the audit had asked for the same.

**The page.** Read-only, and it says so first: a signal is the record of a decision the gates
already made, and nothing on the page can open a trade. The default view groups the loaded
window by cell — one scanner on one market and timeframe — with the cell's own funnel on the
group row: signals, opened, and the refusals by gate as short pills (regime gate, cost rule,
market gate, no quote, capacity, guard, halted, stale, model gate). A group opens to its signals,
each with its gate as a short name and a "why" that shows the full reason and links to the Gate
Center. The flat table stays one switch away for sorting and the scanner pages still use it.
Groups sort by opened, then signals, so the cells doing something come first.

## 121. The phone, and a Decisions page: what waits for the operator on one screen (17 October 2026)

**Why.** The operator checks in on a phone and works on a desktop. The phone showed the desktop's
tables scrolled sideways and a nav of fourteen pills; the desktop showed the decisions in three
places — the Incubator's proposals, its live cells' clocks and the Overview's attention line.
The external review asked for one ranked surface with the evidence and the controls together
and a phone limited to the few views that matter.

**Decisions.** `/decisions`: a stat strip (to decide, proposals, clocks due, attention), then
three groups of cards — faults from the attention line, the gate's proposals with the cohort
evidence, the 14-day funnel, the market verdict and the own-exits verdict beside Promote and
Reject, and the live cells whose demotion clock is half way or due with their clocks and a "To
shadow now" for an administrator. The same routes and confirmation dialogs as the Incubator, so
nothing bypasses them. The Overview's attention row links here. The Incubator keeps the full
tables and the shadow book.

**The phone.** Under 720 px a bar at the bottom holds Overview, Decisions, Positions and Signals
and sits above the safe area; the account's status row hides behind it, the nav pills still
scroll. Positions already fell back to cards; the grouped Signals table now does too, each cell
a block with labelled values, and the Decisions cards stack full width. No primary view scrolls
sideways on a phone. The shared pieces of the Incubator — evidence, funnel, clocks, the clock
rank — moved to one module so both pages read the same numbers.

## 122. The cost-floor stop: a near-miss cost refusal is a real refusal (17 October 2026)

**Why.** The mirror's first ninety minutes offered the account 16 of the shadow book's entries
and the cost rule refused 14, several by a hair (a 1.19% stop against 1.26% needed, 1.25%
against 1.32%). Over the fortnight, 41 of the account's 99 entry refusals were the cost rule,
11 of them within a quarter of the required distance. The aggressive reading: widen the stop to
the floor, size to the wider stop, take the trade. Before turning that on, measure it.

**The study.** `diagnose` gained `cf75`, `cf50` and `cf0`: every entry whose own stop (the
script's, or the 1.5×ATR fallback) sits inside the cost floor is widened to the floor when it
was already at least 75%, 50% or any part of the way there, with the same book cost and the same
ratio of six as the account. The baseline is `spread`, the account's own refusals. Thirty cells
behind the fortnight's near-miss refusals, 15m and one 1h, 4,000 bars.

| variant | trades | sum R | marginal trades | R per marginal trade | cells better / worse |
|---|---|---|---|---|---|
| spread (the account) | 610 | +3.0 | | | |
| cf75 | 916 | −8.6 | +306 | −0.038 | 15 / 14 |
| cf50 | 1,557 | −26.3 | +947 | −0.031 | 13 / 17 |
| cf0 | 4,081 | −72.5 | +3,471 | −0.022 | 13 / 16 |

**Verdict.** Every widening loses: the nearer the entry was to clearing the rule, the worse its
marginal trade. The cost rule is not refusing good trades by a rounding margin; it is refusing
entries whose move is too small to pay for, and giving them a wider stop only adds a smaller
loser. No code change beyond the study. The rule stays at six, and the near-miss refusals on
the Signals page are real rejections, as the rejection audit of decision 110 found for the rest.

## 123. Scalping the majors on 1m: there is nothing to scalp at the account's costs (17 October 2026)

**Why.** The operator asked for the scalp logic on BTC and ETH from the 1m data. 180 days of 1m
bars for both, 20 April to 17 October, 259,200 bars each, pulled from Delta. Costs as the account
pays them: 11.8 bp per round trip as a taker, 4.7 bp as a maker; the book on the majors is
negligible. The study is under `_research/scalp-majors-20261017/`.

**The structure.** A 1m bar moves 3.4 bp on BTC and 4.4 on ETH; 5m moves 7.5 and 9.8; an hour
26 and 33. Autocorrelation of 1m and 5m returns is −0.01 to −0.02 at every lag; the variance
ratio runs 0.94 at 5 minutes to 0.85 at 4 hours on BTC, 0.96 to 0.91 on ETH. That is mild mean
reversion worth about one basis point, against a cost of five or twelve. After a 5m move of 2.5
to 3.5σ the next 15 minutes give back 1.2 bp on both; a break of the 60m range continues by
nothing on the upside and reverts 1 to 2 bp on the downside. By hour of day the only pocket is
16 to 19 UTC, where a 2σ move gives back 5 to 7 bp over the next 15 minutes.

**The simulations.** Every rule run bar by bar on the 1m history, entry at the next open, the
stop checked before the target in a bar, a time stop, both halves reported.

| rule | BTC taker | BTC maker | ETH taker | ETH maker |
|---|---|---|---|---|
| fade a 2–3σ 5m move, stop 1.5–2σ, target 1–1.5σ, 30 min | −0.69 to −0.97R | −0.27 to −0.39R | −0.51 to −0.76R | −0.21 to −0.31R |
| ride a 2.5–3.5σ move, 2σ stop and target, 60 min | −0.71 to −0.76R | −0.30 to −0.34R | −0.52 to −0.56R | −0.23 to −0.24R |
| 60m range breakout, 1.5–2 ATR stop, 1.5–4 ATR target | −1.34 to −1.80R | −0.57 to −0.77R | −0.91 to −1.26R | −0.37 to −0.54R |
| fade a 2.5σ move with the stop at the account's 0.71% floor, 1:1 | −0.12R | −0.02R | −0.16R | −0.06R |
| fade a 2σ move in 16–20 UTC, pure 15 min time exit | +2.4 bp gross, −9.4 net | −2.3 bp | +4.7 bp gross, −7.1 net | −0.0 bp |

The gross edge of every scalp rule is within a basis point of zero; the net is the fee. The
only rule that clears the cost rule's floor, the 0.71% stop, is flat before fees and loses after.
The 16–19 UTC pocket is real in the sense that it is positive in every month of the seven and
in both halves, but it is 2 to 5 bp gross against a 4.7 bp maker round trip, and the second half
is a third of the first.

**Verdict.** There is no scalp on BTC or ETH at this account's costs, as a taker or as a maker.
The majors' 1m and 5m returns carry about a basis point of reversion and no momentum; a scalp
needs ten. Nothing to build. The majors remain a 4h question (decision 110's fade scanner), and
the cost rule that refuses their 15m signals is refusing correctly, as decision 122 found for
the alts.

## 124. The exit study: the trail gives back too much (17 October 2026)

**Why.** The account's 59 closed trades net −0.038R: +0.022R gross, −0.061R of fees. Its
winners leave by the trail at +0.51R on an average peak of +0.91R, its losers at −0.93R, and at
a 61% win rate that is zero. The shadow book reads the same, +0.59R kept of a +1.09R peak. The
trail arms at +0.5R and gives back 40% of the peak, 30% past +2R and 20% past +4R, with the
stall rule tightening it by 0.6 after 45 minutes. The question was whether keeping more of the
peak pays, measured, not whether it feels right.

**The study.** `diagnose` gained an exit set: the same entries, the account's costs and the
book paid, the stop checked before the target and the trail moved only after a bar's exits, on
1m sub-bars as the live engine runs. Every cell with ten or more closed trades in the last 30
days in either book: 72 cells, 40 of them with ten or more trades under the account's rules,
4,410 trades, 15m, 1h and 4h.

| variant | R per trade | sum R | Δ vs the account | cells better / worse | both halves positive |
|---|---|---|---|---|---|
| the account's exits | +0.029 | +130 | | | 13 |
| give back 25% (20/15 past 2R/4R) | +0.037 | +166 | +36 | 22 / 7 | 16 |
| give back 15% (12/10) | +0.047 | +209 | +79 | 29 / 5 | 17 |
| give back 15%, runner steps unchanged | +0.045 | +201 | +72 | 28 / 5 | 17 |
| give back 10% (8/6) | +0.053 | +237 | +107 | 35 / 3 | 17 |
| give back 5% | +0.064 | +284 | +155 | 36 / 2 | 19 |
| give back 60% | +0.028 | +120 | −9 | 13 / 16 | 13 |
| arm the trail at +1R | +0.031 | +135 | +5 | 16 / 13 | 14 |
| arm at +1R, give back 25% | +0.033 | +145 | +15 | 16 / 10 | 13 |
| arm at +0.3R, give back 15% | +0.030 | +139 | +9 | 18 / 17 | 16 |
| half off at +1R, rest trails | +0.021 | +92 | −38 | 3 / 18 | 11 |
| all off at +2R | +0.023 | +102 | −28 | 5 / 18 | 10 |
| no stall rule | +0.031 | +138 | +8 | 9 / 3 | 13 |
| floor +0.5R once +1R seen | +0.029 | +130 | 0 | 0 / 0 | 13 |

The gain is on 15m and on 4h alike (15%: +39R on 23 cells and +35R on 15 cells), and it comes
from the early trail, not the runner steps: 15% with the steps left alone keeps nine tenths of
it. Arming later, taking partials and fixed targets all lose. The profit floor never binds,
because the trail at 40% already sits above it.

**The caveat.** The curve does not turn: 5% beats 10% beats 15%. At 5% of a 2.4% stop the
trail sits 0.12% behind the peak, which is one 1m bar's range on an alt, and the live engine
sees every update of the forming minute, not only its close, so a trail that tight would fire
in the market more often than in the study. The study is trustworthy where the give-back is
wider than the minute's noise, 15% and above; below that it flatters.

**Decision.** Propose `trailGiveBackPct` 15 with `trailSteps` [[2, 12], [4, 10]], from 40 and
[[2, 30], [4, 20]]. It is a risk setting on the shared paper config, so the operator authorises
it; nothing changed on the VM in this decision. The shadow book, at 2,500 trades a month,
measures the change forward under the live engine's granularity within two weeks; the 10%
step is the next question only if the forward reading matches the study.

**Applied.** The operator authorised it the same evening ("apply"). Set on the VM through the
config route at 18:04 UTC on 17 October: `trailGiveBackPct` 15, `trailSteps` [[2, 12], [4, 10]].
Open positions take the new give-back from their next 1m bar; a trail only ever tightens, so
no open stop moved against a trade. Forward reading: the shadow book's trail exits from 18 October
on, against the +0.59R of +1.09R peak they kept before.

## 125. A bar watermark per pair: a deferred or skipped bar's exits are still read (18 October 2026)

**Why.** An external architecture review made six claims about the code. Checked against the
source: the shadow book's missing gates and the symbols × timeframes expansion were out of date
(decisions 112 and 82), the paper-first account state and the absence of one strategy spec are
real but matter at live execution, ML training in-process is real and small. The one claim with
a live consequence today: a run is dispatched per closed bar, a bar that closes during the
previous run is deferred and only the newest request survives, a queue past 500 skips the bar,
and the run that finally happens read events from its last bar only. A script exit raised on a
superseded bar was never seen. Stops and targets are the paper engine's own on 1m bars, so the
loss was confined to script-exit events, which decisions 113 and 114 made real for five cohorts.

**Decision.** `scanners/watermark.ts`: each live pair, in the fleet and in the shadow book,
remembers the last bar it acted on (`scanner.liveMarks`, `incubator.liveMarks` in kv, so a
restart neither replays nor skips). A run reads events from the bar after that mark, at most two
bars back, which is what the live job evaluates. Exits and information from a superseded bar
pass to the engine; entries on one are dropped and counted in the funnel as `entry: superseded
bar`, since they are stale by definition. A bar too old to act on still advances the mark.
Neither the paper-first write nor the strategy spec is changed; both go on the list for before
live execution.

## 126. The quarantine, worked: 304 of 690 scripts come back (18 October 2026)

**Why.** `script_health` held 690 quarantined scripts, a quarter of the library. The operator asked
whether they could be fixed or converted. The verdicts, grouped: 405 for time or memory (213
"never finishes", 180 "timed out 3× in 24 h", the rest memory), 124 "does not transpile", 92
"PineTS runtime gap", 35 "needs a market Delta does not list", 34 "Pine version the runtime does
not support".

**The slow ones were judged on the wrong history.** The compat and screen verdicts came from
4,000-bar runs; the live engine runs on 1,500. Every one of the 405 was run again on BTCUSD 15m at
1,500 bars under a capped scope on the VM: 246 ran on the first pass (median 375 ms, p90 2 s),
and of the 159 that fell to the run's own memory guard 48 more ran with two workers instead of
four. 291 of 405 run at the live bar count. 65 need more than two gigabytes of heap apiece at
1,500 bars and stay out; the live pool gives a worker one. The compat tool takes `WORKERS=` now.

**The parser gaps are five shapes.** The failing lines were sampled rather than guessed:
`import` of a library (48, 25 of them `TradingView/ta`), Pine's continuation lines inside brackets
or starting with an operator (24 plus the comma and colon cases), `for int i = …` and `series
float x` qualifiers (12), `type` and `method` used as variable names (10), and Pine v4 (31).
`pine/compat.ts` lowers each: continuation lines are joined onto their statement with trailing
comments dropped, comment-only lines removed (PineTS tokenises them and their depth breaks the
block around them; `//@version` and the other annotations stay), qualifiers dropped, the two
identifiers renamed outside strings, v4 lifted to v5 by the published migration table with every
untyped `input()` typed by its default, and `request.financial` and its kin lowered to `na`, which
is what TradingView returns for a perpetual too. Each is a patch rule, applied before the
specific ones.

**Measured, not assumed.** The 250 transpile, version and runtime-gap scripts on 300 BTCUSD 15m
bars: 60 ran before the patches, 73 after, 13 fixed, none broken. The 216 scanners the fleet and
the incubator run: 212 ran before and 212 after, no regression, and the 32 whose alert counts
differed between the two runs gave identical output when run raw and patched on identical bars.
Two earlier drafts failed that check and were not kept: re-indenting comment lines broke a live
script, and removing `// @version=5` written with a space broke another; the version annotation
is now matched with the space allowed.

**What stays out.** 48 scripts import a library, and a library's source needs its own script id,
which the facade does not resolve by name; 35 ask for SPY, VIX or another series Delta does not
list; 11 request a timeframe PineTS does not have (1S, 10, 480, 720: its list is fixed); 65 are
memory hogs; the rest are runtime gaps inside PineTS (`e.slice`, `syminfo.param`, variables the
transpiler loses). The library import is the one worth another pass, with the `TradingView/ta`
source inlined, once its id is found.

**Decision.** The 304 scripts that now run, 291 at the live bar count and 13 by the patches, are
released through the product's release route and go back to the nightly screen, which re-judges
them at 4,000 bars with its own retry rule; a repeat verdict quarantines again. The patches
reach the live engine on the next restart; no live script's output changes.

## 127. 164 scripts retired from the library for good (18 October 2026)

**Why.** After decision 126 the quarantine held 386 scripts. The operator asked that the ones that
are not useful be removed permanently. "Not useful" is read as "cannot run on this stack by
nature", judged from each script's latest error, not its old verdict:

| retired | n | why it can never run here |
|---|---|---|
| series Delta does not list | 60 | `request.security` on SPY, VIX, DXY, WALCL and the like |
| memory beyond the live worker | 69 | over two gigabytes of heap at 1,500 bars; a live worker has one |
| imports a data library | 23 | chess data, Forex Factory calendars, COT, machine-learning libraries |
| timeframe PineTS does not have | 9 | seconds bars and minute counts outside its fixed list |
| hangs at the live bar count | 1 | |
| Pine v2 and v3 | 2 | the lift covers v4 only |

**Kept.** 192 remain quarantined: 143 runtime gaps inside PineTS (variables the transpiler loses,
`e.slice`, `syminfo.param`), 24 gaps that appear only on the long history, and 25 that import
`TradingView/ta`, which one inlining pass could bring back. 30 Pine v4 scripts whose verdict
predates the lift were released for the screen to re-judge.

**How "permanent" is kept.** A manifest status `removed`, with the reason and the date, on each
row; the source file deleted. The row stays because the weekly library sync treats every manifest
id as known, so a removed script is never re-imported; the registry never loads a removed row, so
it is absent from the library, the screen and the dashboard. The health rows went through the
release route. 354 scripts whose source TradingView does not publish are a separate, older set,
still listed as unavailable; they could go the same way on a word.

## 128. The stop-outs, worked through: decided early, unpredictable at entry, and cutting them early loses (18 October 2026)

**Why.** The account's closed trades read 69, net −79 dollars, 38 of them in fees; 28 left by the
stop at −0.93R, 39 by the trail at +0.58R. The operator asked for the deep dive and the fix.

**Anatomy.** Account stop-outs: average peak +0.18R, 68% never reached +0.25R, median hold 109
minutes, stops 2.5% wide, half of them shorts. Shadow book, 30 days, 898 stop-outs: peak +0.12R,
62% never reached +0.25R. From the recorded paths of 2,460 trades: thirty minutes after entry the
eventual stop-outs sit at a median −0.46R, 47% already at or past −0.5R, 88% under water; the
eventual winners sit at +0.25R with 2% at or past −0.5R. At an hour, 64% of stop-outs are past
−0.5R and 93% under water, 64% of winners are past +0.25R.

**Nothing at entry predicts them.** 1,665 shadow trades of the last 30 days with the enriched
features, cut into terciles on eleven features plus side, hour block, weekday and timeframe: the
stop rate sits between 28% and 38% in every bucket. The only tilts are in R, not in stops: with
the 200-bar trend +0.22R against +0.02R, shorts +0.30R against longs +0.01R, 4h cells stopped
25% of the time against 37% on 15m. The yardstick's AUC of 0.51 (decision 108) is the same fact.

**The early cut, measured.** The path numbers suggested closing a trade at −0.5R inside its first
hour. Built as `paper.earlyCut` (off by default) and run on the 72 exit-study cells, 4,544 trades,
the account's costs, 1m sub-bars:

| variant | Δ sum R | cells better / worse |
|---|---|---|
| cut at −0.5R inside 30 min | −24 | 4 / 10 |
| cut at −0.5R inside 60 min | −39 | 6 / 13 |
| cut at −0.5R inside 120 min | −58 | 7 / 16 |
| cut at −0.4R inside 60 min | −64 | 5 / 18 |
| cut at −0.6R inside 90 min | −42 | 5 / 13 |
| cut at −0.7R inside 240 min | −48 | 4 / 18 |

Every variant loses, on 15m and on 1h. The sampled path sees a winner's position every few
minutes; the 1m bars see every touch, and far more winners touch −0.5R on the way than the path
suggested. The same run confirms decision 124's next step: a 10% give-back is +31R over the
applied 15%, 21 cells better and one worse.

**Verdict.** A stop-out here is a dead entry, not a stop placed wrong (110), not a stop too tight
for the fees (122), and not a trade that should have been cut sooner (this). The levers that
move the book are which cells trade (the gate) and how much of a winner is kept (124). The early
cut stays in the code as a study option and off. `earlyCut` is a risk setting; it is never set
without the operator.

## 129. "Smarter take-profits", tested: the floor, the ladders and per-scanner overrides all lose; the trail is the only lever (18 October 2026)

**Why.** A reviewer's note on smarter take-profits proposed an earlier profit floor, per-scanner
target overrides, the script's own targets over the fleet ladder, and warned against tighter
ladders. The operator asked for it to be tested. Same 72 exit-study cells, 41 with ten or more
trades under the account's costs, 4,511 trades, 1m sub-bars, the applied 15% trail as the base.

| variant | Δ sum R | cells better / worse |
|---|---|---|
| floor at +0.3R keep +0.15R | −112 | 5 / 30 |
| floor at +0.4R keep +0.2R | −68 | 8 / 20 |
| floor at +0.3R keep +0.1R, trail armed at +0.3R | −66 | 11 / 23 |
| script targets ignored, or widened only | 0 | none of the 41 cells' scripts publish a target |
| ladder 1.5R / 3R / 6R in three legs | −8 | 0 / 6 |
| ladder 1R / 2R / 4R in three legs | −29 | 0 / 14 |
| ladder 2R / 4R / 6R, half at the first | −6 | 0 / 4 |
| everything at +1R | −73 | 0 / 22 |
| everything at +1.5R | −26 | 1 / 15 |
| trail give-back 10% | +30 | 20 / 3 |

**Per-scanner overrides, out of sample.** For each cell the exit with the best first-half R was
chosen from seven candidates and judged on the second half: +133R, against +132R for the fleet
default on the same cells and +159R with hindsight. Choosing exits per cell on the past transfers
nothing to the future; the gap to hindsight is the in-sample illusion. The one global change that
holds on the second half is the 10% give-back, +153R against +138R.

**Forward reading of decision 124.** Shadow trail exits entered after the change: 16 so far, keeping
79% of their peak and +0.70R per trade, against 52% and +0.56R in the week before.

**Verdict.** An earlier floor gives runners away for a small lock and loses on three cells in four;
every fixed ladder loses; the scripts in the fleet publish no targets to use; per-scanner target
settings cannot be chosen from history. The trail's give-back remains the only exit setting that
pays, and 10% is its next step, on the operator's word once the forward sample is in.

**Applied, and the account's own ledger replayed.** The operator authorised the 10% give-back on
18 October ("go ahead"); set through the config route at 16:47 UTC: `trailGiveBackPct` 10,
`trailSteps` [[2, 8], [4, 6]]. The account's 80 closed trades were then replayed through the live
exit engine on 1m candles (`npm run replay`, policies brought up to date), with their real fills,
stops and sizes and the account's costs:

| policy | total | per trade | win rate |
|---|---|---|---|
| as they actually ended | −4.81R | | |
| trail 40%, steps 30/20 (as traded until 17 October) | −5.68R | −0.071R | 60% |
| trail 15%, steps 12/10 (decision 124) | −1.66R | −0.021R | 61% |
| trail 10%, steps 8/6 (deployed) | −0.98R | −0.012R | 61% |

43 of the 80 trades end differently under the deployed trail: 35 keep more, the largest a runner
that the 40% trail still held open at the 48-hour horizon and the 10% trail banked at +1.13R, and
8 keep less, the largest a +1.65R runner cut to +0.42R. The gain on this ledger is +4.7R over 80
trades, smaller per trade than the 72-cell study because the account's result is set by its 28
stop-outs, which no trail touches. The optimistic reading (targets before stops in a bar) gives the
same figure, so the number does not depend on the bar-order assumption.

## 130. The conjunction test: two scanners agreeing on a bar is not a better signal (18 October 2026)

**Why.** A reviewer asked for the measurement behind "combine indicators to raise the win rate":
an entry only when two scanners enter on the same closed bar, same side, same market and
timeframe, judged on the nightly screen's own path and against each component alone on
identical history. `npm run conjunction` is the harness; nine pairs chosen among scanners that
share shadow cells with trades in the last 30 days, 33 market cells, 4,000 bars, the fleet's
current exits, book cost paid, each conjunction run both ways (each scanner's levels gated by the
other's entries).

| conjunction | tf | components alone, R per trade over trades | conjunction, R per trade over trades |
|---|---|---|---|
| SuperTrend Cluster + Structure-Anchored VWAP | 15m | −0.05 / 21, −0.05 / 16 | no joint entry in 4 markets |
| Trend Impulse Channels + Smart Swing VWAP | 15m | +0.16 / 126, −0.18 / 29 | 1 trade |
| AI Predictive Flow + Pivot Channel Breaks | 15m | −0.22 / 17, −0.13 / 28 | 1 trade |
| Trend Impulse Channels + Smart Money Breakout | 15m | +0.13 / 112, −0.20 / 10 | 1 trade, stopped |
| Order Block Detector + Trend Impulse Channels | 15m | +0.09 / 85, +0.13 / 51 | +0.31 / 7 |
| Pivot Channel Breaks + SuperTrend Cluster | 15m | +0.08 / 14, −0.03 / 19 | +0.10 / 3 |
| Trend Pullback Guard + Volatility S&D Zones | 15m | −0.20 / 21, +0.05 / 104 | −0.51 / 3 |
| Trend Continuation Signals + Trend Tracer | 4h | +0.03 / 172, +0.14 / 107 | +0.45 / 14 |
| Donchian Breakout + Momentum Bands Breakout | 1h | +0.12 / 70, +0.38 / 131 | +1.23 / 38 |

**Result.** None of the nine clears the screen on any market; none beats its better component on
the cell yardstick (higher R per trade, both halves positive, not worse on a majority of markets).
Summed, the conjunctions make +54R where their better components make +108R on the same history.
Seven of the nine produce between zero and seven joint entries over 4,000 bars: agreement on a bar
is rare, which is the sample collapse the yardstick exists to catch.

**The one with substance.** Momentum Bands gated by the Donchian breakout on ZEC 1h: 26 trades at
+1.00R, both halves positive, holdout +0.90R, 4% stop-outs, against Momentum Bands alone at +0.50R
over 74 trades, which passes the screen. The conjunction is better per trade and worse in total,
+26R against +37R, because it drops two thirds of the trades, and it cannot be screened on 18
training trades. A filter that raises R per trade by discarding most of a passing cell's trades is
not more edge; it is less of the same edge.

**Verdict.** Agreement between scanners adds nothing the screen can use, which is what the
composite study of 29 September and the family lab (decision 45) found by other routes, and what
decision 128 implies: the entry side carries no separable signal. Scanners stay separate cells.
Measurement only; nothing promoted, no setting changed.

## 131. The published scores of the WillyAlgo scripts carry no outcome information (18 October 2026)

**Why.** A reviewer set out the scoring engines of three WillyAlgoTrader scripts, Precision Sniper's
ten-factor confluence, Pulse Trend Radar's four-factor grade and Liquidity Trail Matrix's five-factor
retest score, and suggested the score as an entry filter or a sizing input. The extractor already
reads a `Score:` field and the grade in a label; the question was whether either separates
outcomes. The diagnose tool's record per label now splits by the published score band.

| script | reading | trades | R per trade | win rate |
|---|---|---|---|---|
| Pulse Trend Radar, 9 cells | grade B | 108 | +0.051 | 67% |
| | grade C | 459 | +0.059 | 61% |
| | grade A or A+ | 0 in 4,000 bars | | |
| Liquidity Trail Matrix, 12 cells | band flip, score 0 | 250 | +0.054 | 62% |
| | retest, score 80 and above | 232 | +0.044 | 66% |

Precision Sniper has no shadow trades to read (decision 130's queue), and its score gates its own
alerts before the extractor sees them, so it cannot be split after the fact.

**Verdict.** Neither score separates anything under the fleet's exits: the lowest grade matches the
middle one, the top grades never fire, and a retest the script rates 80 or better earns the same as
a flip it rates zero. This is the same finding as decision 128 for the entry side at large, now on
the two scripts whose authors rated their own signals. The scores stay captured as features; they
gate nothing and size nothing.

**Precision Sniper, the threshold lowered.** Its score gates its own alerts, so the split needed
the gate opened: `Min Confluence Score` 1, preset Custom, C grades shown, run on the five markets
the screen judged it on, 15m, 4,000 bars, the account's costs. Its alerts carry the score and the
extractor reads it.

| grade (score of 10) | trades | R per trade | win rate |
|---|---|---|---|
| A (6.5 to 7.9) | 315 | +0.073 | 62% |
| B (5 to 6.4) | 65 | −0.091 | 48% |
| C (under 5) | 30 | +0.043 | 43% |
| A+ (8 and above) | none in 4,000 bars | | |

All 410 at +0.050R; the script's own default (B and above) at +0.045R; A alone at +0.073R. The
order is not monotonic, B is the worst band on 65 trades and C is positive, so the tilt toward A is
what 65 trades of noise look like, not a gate. Same verdict as the other two.

## 132. The incubator rebuilt around the cell: each scanner, timeframe and market judged on its own (18 October 2026)

**Why.** The operator asked for the incubator to treat each scanner × timeframe × market as its own
unit, and the audit of the same day found three silent faults in the cohort design as it ran: the
shadow book stuck at 256 cells against a cap of 250 since a cohort admission overshot it on
16 October, with no admission since; passing candidates going stale under an 8-day eligibility
window while the nightly walk truncated at 140 of 318 scripts; and cells returning from the account
restarting their evidence from zero, so Trend Impulse Channels read 23 trades over 2 days with 172
shadow trades in the month.

**What changed.**
- The gate's `pool: 'pair'` mode, kept since decision 29, is the mode: `judgePair` on every cell,
  admission per cell by screen score. Decision 29's objection, that one market needs months to
  reach 30 trades on 1h and never on 4h, is answered by per-timeframe floors: `gate.minTradesByTf`
  and `gate.minDaysByTf` beside the existing `maxDaysByTf`, so a 4h cell is asked for a sample it
  can produce in its window rather than one it cannot.
- Pair-mode admission takes a per-scanner cap at each timeframe (`admit.maxPerScannerTf`, the
  cohort market count as the fallback), so one strong screen cannot fill the book.
- A passing candidate stays eligible for `admit.candidateMaxAgeDays`, default 30, long enough for
  the walk to come round and re-screen it.
- A cell demoted to the shadow book, by the gate or by hand, keeps the `since` of its original
  admission, so the shadow trades it earned before promotion count again.

**Settings applied on the VM.** `gate.pool` pair; `gate.minTradesByTf` { 1h: 20, 4h: 12 };
`gate.minDaysByTf` { 1h: 28, 4h: 45 }; `gate.maxDaysByTf` { 1h: 90, 4h: 150 };
`admit.candidateMaxAgeDays` 30; `admit.maxPerScannerTf` { 15m: 5, 1h: 8, 4h: 12 }; `maxShadow` 400,
which clears the overshoot and admits the queue by score. The 4h floor of 12 trades is thin
evidence by the fleet's standard and is the price of judging 4h cells one at a time; the gate's
profit-factor, positive-weeks and R floors still apply to it.

**What this does not change.** The screen, the shadow runner, the demotion rules, the exits and
the promotion caps are as they were. The cohort code stays for `pool: 'cohort'`.

**Promotion unrestricted (19 October).** The operator: "allow, don't restrict the promotion". The
caps that held the fleet to two promotions a week, 43 live pairs, two cells per market and six per
scanner are set to 1,000 each through the config route, with auto-promotion on, so every cell the
gate proposes goes live as proposed. The first proposal under the per-cell gate, ML RSI on
MUBARAK 15m, was approved the same way: the fleet is 38 pairs. The account's own risk caps, the
position and burst limits and the daily and weekly loss stops, are unchanged and still bound what
the fleet can do with the account.

## 133. The hybrid entry: a higher-timeframe signal filled on a lower-timeframe break (19 October 2026)

**Why.** The operator wanted execution on a lower timeframe and signals from a higher one. Built as
an entry model in the backtest (`entry.breakAtr`, `entry.breakBars`): the signal is read on its own
timeframe, and a stop order rests just beyond the signal bar's extreme in the trade's direction; it
fills on the first lower-timeframe bar that crosses it, as a taker, or lapses after a number of
signal bars. A signal whose move never continues is never taken. Measured on 118 cells on 1h and 4h
with 15m sub-bars, the account's costs, against the direct entry.

| | trades | R per trade | sum R | both halves | cells better / worse |
|---|---|---|---|---|---|
| 1h direct entry, 64 cells | 2,235 | +0.164 | +367 | +0.12 / +0.20 | |
| 1h break, 4 bars | 1,657 | +0.108 | +179 | +0.10 / +0.12 | 25 / 33 |
| 1h break, 8 bars | 1,828 | +0.113 | +206 | +0.10 / +0.12 | 27 / 32 |
| 4h direct entry, 45 cells | 4,683 | +0.066 | +311 | +0.06 / +0.07 | |
| 4h break, 4 bars | 3,411 | +0.097 | +330 | +0.11 / +0.08 | 20 / 20 |
| 4h break, 8 bars | 3,607 | +0.095 | +343 | +0.11 / +0.08 | 21 / 21 |

**Verdict.** On 1h it loses half the result: the signals that do not continue are not the losers,
and the ones that do continue are bought higher. On 4h it raises R per trade and holds in both
halves, but the cells split exactly evenly, which is not a change the yardstick can accept. The
entry model stays in the backtest and in diagnose (`h-break*` variants); nothing in the fleet uses it.

## 134. The cross-timeframe gate, and a backtest that filled strategies at prices they could not get (19 October 2026)

**The gate.** A reviewer's prompt asked for a higher-timeframe scanner to gate a lower-timeframe
scanner's entries, measured on the screen's path. `npm run conjunction` takes a five-field line for
it and reads the higher scanner two ways with no look-ahead: its signal state (the side of its last
entry until an exit or an opposite entry) and its open position under the fleet's exits. Six pairs
on the lower scanner's own markets; five ran, the sixth timed out on its first market.

| gate | lower scanner alone | gated by the higher signal | joint entries |
|---|---|---|---|
| SuperTrend Cluster 1h → Trend Impulse 15m | +0.175R × 407, sum +71 | +0.157R × 159, sum +25 | 47% |
| Structure-Anchored VWAP 1h → Smart Swing VWAP 15m | −0.072R × 85 | −0.125R × 39 | 46% |
| Momentum Bands 1h → SuperTrend Cluster 15m | +0.073R × 73 | no trades | 0% |
| Inside Day Breakout 1h → Trend Impulse 15m | +0.181R × 394, sum +71 | +0.158R × 42, sum +7 | 9% |
| Trend Tracer 4h → Momentum Bands 1h | +0.305R × 242, sum +74 | +0.312R × 180, sum +56 | 68% |

None beats its better component; none improves its lower scanner as a filter; one clears the screen
on one market. Summed, the gated readings make +88R where the lower scanners alone make +216R on the
same history. The position reading keeps almost nothing: under the 10% trail a higher-timeframe
trade is open for a few hours at most. The higher timeframe's direction does not select the lower
timeframe's winners, which is decision 102's finding for BTC's 4h bias, decision 130's for
same-timeframe agreement, and decision 128's for the entry side at large.

**The flaw it surfaced.** Inside Day Breakout Strategy 1h made +1.45R a trade in the study's
backtest and +0.03R over 23 trades in the shadow book. Its daily data was read correctly (PineTS
returns yesterday's high on all 189 intraday bars tested). The cause was the backtest: it filled a
market entry at the price the event carried. For an alert script that price is the close; for a
strategy's stop order it is the breakout level, recorded after the bar had closed far beyond it.
Inside Day Breakout's entries sat a median 60% of the bar's range better than the close. The live
engine acts after the close and buys at the ask; it never gets that price.

Fixed: a market entry in the backtest fills at the signal bar's close. Inside Day Breakout on five
markets goes from +0.90R a trade to +0.13R, beside its +0.03R forward. Across the shadow book, the 22
strategy cells with five or more forward trades had screens promising +0.44R and delivered 0.00R;
the 37 indicator cells promised +0.21R and delivered +0.17R. No strategy cell is live: the gate
judges forward trades and none passed.

**Clean-up.** Screens computed from now carry `fill: 'close'`; a strategy candidate without that
stamp is not admitted until the nightly walk re-screens it (50 candidates). The 100 strategy cells in
the shadow book are left to the gate: the delivery rule retires a cell whose forward R is at or
below zero and 0.5R short of its screen once it has 20 trades, which these will meet. Every study
in this log that screened strategies before today (decisions 113, 114, 129 to 133) compared
variants on the same flattered entries, so their relative verdicts stand; their absolute R on
strategy cells was too high.

## 135. Reversals pay; script exits fill at the market (19 October 2026)

**Why.** On the majors' 4h cells the shadow book's largest exit by count was the reversal: 72 trades
closed at −0.15 to −0.17R with a peak of 0.2R, about 12R of BTC's and ETH's 30-day deficit. A
reviewer named it the one exit question left. Measured on the 72 exit-study cells plus the BTC and
ETH 4h cells, the account's costs, 1m sub-bars, the deployed exits, with the fill fixes below.

| cells | reversals as now | never reverse | only above +0.5R | only above +1R |
|---|---|---|---|---|
| all 48 with 10+ trades | +208R | +144R (7 better / 17 worse) | +143R | +143R |
| 15m, 25 cells | +87R | +87R | +86R | +86R |
| 4h, 21 cells | +114R | +52R (1 / 9) | +52R | +52R |
| 4h BTC and ETH, 10 cells | +27R | +22R | +22R | +22R |

**Verdict.** Keep reversals as they are. The per-exit view was misleading: a reversal closes a trade
at −0.15R that would otherwise ride to a −1R stop, and the flip that follows is a trade in its own
right. Removing them costs 62R on 4h and nothing anywhere gains. This replaces decision 8's hint,
measured on a different fleet, that reversing less might help.

**The fill fixes, from the same review.** Decision 134 made backtest entries fill at the signal
bar's close. Two exits had the same flaw. The backtest's reversal exit filled at the opposite
signal's own price; it now fills at the close, as the live engine fills it at the quote. And a
script's exit, in the backtest and in the live paper engine, filled at the price the script
reported: for a strategy that is the level its stop or limit passed inside a bar that had already
closed, which no order placed after the close can get. A script exit now fills at the market when
it is acted on, the close in the backtest and the mark live; a target hit keeps its level, since a
resting limit fills there. This changes the paper results of the five strategy cohorts on their own
exits (decision 114) from today; their earlier own-exit trades were filled at levels they could not
have had.

**Shadow book enlarged (19 October).** On the operator's "increase shadow": `incubator.maxShadow`
400 → 600 and `admit.maxPerScannerTf` 15m 5 → 8, through the config route, with the judge run at
once: 26 cells admitted, 426 in the book, 174 slots free. The cap no longer binds. Of the passing
candidates left, 71 sit on markets the market gate refuses today (decision 104 keeps them out) and
18 are strategy scripts waiting for a re-screen under decision 134's fill pricing. The book now
grows at the rate the nightly screen produces passes, and that screen runs two workers and
truncates at about 180 of 318 scripts a night; at 400 cells the VM ran at a load of 0.06 with 2 of
24 GB in use.

## 136. A daily report, from the books, every day (19 October 2026)

**Why.** The operator: "I need a daily thing, no need to wait." The system had a daily summary in
the ops monitor (equity, the day's P&L, the top scanners), but it only goes out by Telegram and
Telegram is not configured on the VM, so it reached no one.

**What.** `analytics/daily.ts` computes one row per UTC day straight from the positions table and
the incubator's event log, so every past day is available at once and today reads as it happens;
nothing is stored. Per book: trades closed that day, net of fees, fees, R per trade and summed,
stops and trail exits, the share of the peak the trail exits kept (decision 124's number), the best
and worst scanner; the shadow book split by timeframe; the incubator's admissions, proposals,
promotions, retirements and demotions; the account's equity at the day's close. `GET
/api/reports/daily?days=N` serves it, the new Daily page shows 30 days with the last seven against
the seven before, and the ops monitor's daily message at 00:00 UTC is now this report for the day
that closed. On a phone the two tables stack into labelled cards.

**To have it on the phone each morning,** Telegram needs `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` in the service's systemd drop-in on the VM, set by the operator; the message then
arrives at 00:00 UTC (05:30 IST).

**ML, re-read on 19 October (decision 108's yardstick, 30 days).** The training set is 41,426
backtest rows and 307 live ones. The global model's walk-forward AUC is 0.58. 36 of 112 per-scanner
models show 0.60 or better, but their holdouts are a median 30 trades and the best six are measured
on 10 to 19; with no signal at all about 18 of 112 would reach 0.60 on holdouts that small. Forward,
on 1,740 scored shadow trades, the probability's AUC is 0.52 and no threshold pays: the trades it
rates below 45% made +0.11R each, the best bucket in the book, and every cut from 45% to 65% loses
27 to 62R. On the account's 94 scored trades the AUC is 0.48. The model stays a recorded feature;
it gates nothing and sizes nothing (`minProb` 0, `useAsScore` false).

## 137. Retraining and refactoring the model: nothing raises the forward AUC (19 October 2026)

**Why.** The operator asked to retrain or refactor the ML layer to improve its AUC. Two things
could plausibly help: better training data (the model learns from 41,426 backtest rows and 307
live ones, while the shadow book's forward trades, filled as the account fills, are not in its
training set) and new information (a cell's own track record, which the features never carry).

**The test.** Seven candidates, each trained only on data known before the test period, scored on
the newest shadow trades; backtest rows from the test period were excluded, since they replay the
same market moments. Two splits: the newest 30% of 1,665 shadow trades (500) and the newest 50%
(833). Script: `_research/ml-retrain-20261019/experiment.py`.

| candidate | AUC, newest 30% | AUC, newest 50% | sum R from dropping its lowest third |
|---|---|---|---|
| the current setup (backtest and live samples) | 0.488 | 0.518 | −35.6 / −64.7 |
| shadow trades only | 0.465 | 0.497 | +2.2 / −17.3 |
| shadow trades and backtest samples | 0.458 | 0.504 | −43.3 / −67.2 |
| the cell's own track record only | 0.506 | 0.515 | −8.0 / −43.3 |
| features and track record, logistic | 0.487 | 0.499 | −13.4 / −48.2 |
| features and track record, boosted trees | 0.541 | 0.502 | +0.2 / −35.7 |
| rule: the cell's last ten trades' mean R | 0.486 | 0.495 | −16.3 / −18.2 |

**Verdict.** Nothing clears noise: the best figure, 0.541 for boosted trees, falls to 0.502 on the
other split, and no candidate's lowest third is worth dropping. Training on shadow trades separates
the top half's R from the bottom half's on the first split (+0.22R against +0.04R) and barely on
the second; the cell's recent record, the one new piece of information, predicts its next trade no
better than chance. The model stays as it is, a recorded feature that gates and sizes nothing.
This is decision 128's finding a fourth way: the information is not at the entry.

## 138. Sizing by margin instead of by equity: a lead worth a forward check (19 October 2026)

**Why.** A reviewer set out that sizing is equity-based (the stop costs `riskPerTradePct` of equity,
free margin is a cap, `maxStopLossPct` caps any stop at 2% of equity) and that sizing to a share of
posted margin would be a different, unmeasured risk model. The description of the code is exact.
One thing it leaves out: leverage is lowered until liquidation sits beyond the stop
(`leverageForStop`), so under a fixed margin per trade the dollar risk is roughly constant for wide
stops and shrinks in proportion to the stop for tight ones, where leverage meets the market's cap.

**The test.** R does not depend on size, so any sizing rule can be re-scored on closed trades: under
margin sizing each trade's dollar result is its R times margin × leverage × stop distance, scaled so
the average risk equals today's 1% of equity. Shadow book, 2,611 trades; account, 111. Units are 1%
of equity.

| | equity sizing (now) | margin sizing | margin sizing, weights capped 0.25×–2× |
|---|---|---|---|
| shadow book, total | +115 | +225 | +216 |
| shadow book, worst drawdown | −71 | −37 | −36 |
| first half / second half | −12 / +127 | +70 / +147 | +59 / +148 |
| account, total | −7.6 | −5.3 | −5.3 |

**Why it helps, and why it is not yet a verdict.** By stop width the shadow book's R per trade is a
U: +0.07R for stops under 0.72% (where fees take 0.15R of every trade), −0.05R and −0.01R for the
middle half, +0.17R for stops of 2.3% and over. Margin sizing shrinks the tight-stop trades to about
half and lifts the widest to about 1.6×. But the gain is concentrated: +103 of the +105 comes from the
widest quartile, the ten largest single-trade gains make 63 of it, and within cells of 15 or more
trades it is better in 22 and worse in 16. Plain stop-width sizing gains more in total (+381) without
the drawdown improvement, which marks it as a bet on the same few big winners.

**Decision.** Nothing changes yet. The comparison is re-run on the shadow trades closed after today;
if margin sizing still wins in total and in drawdown over two weeks of new trades, it becomes a
sizing mode (fixed margin of about 2.7% of equity per trade, leverage set as now, the 2% stop cap
kept) for the operator to switch on. The units for that are already measured here.

**The forward check is on the Daily page (19 October).** Each day's row carries "If sized by margin"
beside the summed R, for the account and for the shadow book: the same trades re-scored with
decision 138's weights (leverage × stop distance over 0.3765, capped 0.25×–2×). The stat strip
keeps the running totals from 20 October, the first full day after the measurement. Two weeks of
that column decide whether margin sizing becomes a mode to switch on.

## 139. Trackers: cells the operator wants watched, traded in the shadow book outside the incubator (19 October 2026)

**Why.** The operator asked to shadow-trade the WillyAlgoTrader scripts on BTC, ETH, XRP and SOL
with a separate tracker. The incubator would not do it on its own: it admits cells by screen score,
retires them on its clocks, and mirrors them into the account.

**What.** A new incubator stage, `tracked`. The shadow runner trades tracked cells with the same
engine, gates and costs as every shadow cell. The gate never promotes, retires or ages them; they
hold no shadow slot; the nightly screen skips them; the mirror never copies them into the account;
the Daily page's shadow row leaves them out. A tracker (`incubator/tracker.ts`, kv `trackers`) is a
named set of scanners × markets × timeframes: saving one marks every cell that is not already in the
shadow book or live as tracked; a cell that is keeps its stage and is read as a member. Removing a
tracker returns its tracked cells to candidates with no screen, so only a fresh pass could admit
them. `GET/POST /api/trackers`, `DELETE /api/trackers/:id`; the Trackers page shows the totals since
the tracker began, a script-by-market grid, a market-by-timeframe grid and every cell that has traded.

**First tracker.** "WillyAlgo on the majors": the 27 runnable WillyAlgoTrader scripts (the 28th is
quarantined) on BTCUSD, ETHUSD, XRPUSD and SOLUSD, on 15m, 1h and 4h: 324 cells. Some of the 27 are
tools that publish no entries (a trade calculator, volume profiles, an almanac); they stay in and
show as silent.

**Trimmed the same night.** With 753 cells the shadow runner's bar-close burst took the service past
its memory guard (60% of the 10 GB limit) and about 11 of 311 runs a bar were killed mid-run; no
account run failed, live runs going first. The runner now keeps the last error per scanner
(`stats.lastErrors`), which is how the cause showed. The tracker keeps the 19 scripts that produce
entries on these markets; the 7 silent tools (also the slowest, 0.7 to 2.2 s a run) and Gold
Breakout 15m (a PineTS gap on `strategy.closedtrades.entry_bar_index`) were released, and saving a
narrower set now returns the dropped cells to the candidates. 228 cells; the next bar ran 312 runs
with no error at 3.5 GB.

## 140. A memory kill is blamed on a script only when it ran alone (19 October 2026)

**Why.** At 06:15 UTC on 19 October, with the tracker's cells added to the shadow book, a bar-close
burst took the service to 6,678 MB, over the pool's memory guard (60% of the 10 GB limit). The guard
retires every busy worker with a `memory:` error, and the health check quarantines on the first
`memory:` strike (decision 98), so four live account scanners that happened to be running were
quarantined and stopped trading: Liquidity Trail Matrix, Pulse Trend Radar, ML RSI and AI Predictive
Flow. The Decisions page's attention row showed it. None of the four was the cause; the resident
size is the whole process's.

**Decision.** When the guard trips with one run in progress, that run is the culprit and gets the
`memory:` verdict as before. With several, each is retired with `memory-shared:`, which counts as a
failed run and quarantines nobody. The guard moves from 60% to 72% of the limit (7.2 GB), still below
the service's 8 GB throttle and 10 GB ceiling. The four scanners were released through the product's
release route.

## 141. Today's stop-outs, read and tested: no armed trade stops, but break even at +0.25R and a time stop both lose (19 October 2026)

**Why.** The operator: "TPs are too wide and SLs are too costly, any pattern in today's trades?" The
account closed 69 trades since 00:00 IST (+5.54R, +$51.54 after $36.67 of fees); the shadow book 147
(+8.45R).

**What today shows.**

| account, 19 Oct | trades | net | per trade |
|---|---|---|---|
| trail exits | 46 | +27.00R | +0.59R |
| stop-outs | 22 | −21.66R | −0.98R |
| reversal | 1 | +0.20R | |

- No account trade reached a target: the first target sits at 2R and 1 of 69 trades got there; 6
  reached 1R. The trail is the exit; the target is not where the money is lost.
- No stop-out was worse than −1R; the stop's width (median 1.47%) is the same for the trades that
  stopped and the trades that won.
- No trade that armed the trail (+0.5R) stopped out. Of the 22 stop-outs, 9 never showed +0.1R and
  13 reached +0.1R to +0.5R before failing. Winners arm in a median 16 minutes; stop-outs are held 56.

**Tested on today's minute closes**, then on the 72 exit-study cells (39 with ten or more trades,
4,479 trades, 1m sub-bars, the account's costs, the deployed 10% trail as the base):

| variant | today, account | 72 cells, Δ sum R | cells better / worse |
|---|---|---|---|
| target at 1R | −1.63R | −73 (decision 129) | 0 / 22 |
| break even at +0.25R | +4.57R | −133 | 6 / 21 |
| break even at +0.25R, keep fees | | −126 | 6 / 24 |
| break even at +0.35R | +0.00R | −76 | 7 / 21 |
| time stop, unarmed after 2 bars | +1.44R | −299 | 3 / 32 |
| time stop, unarmed after 4 bars | +1.08R | −130 | 6 / 28 |
| time stop, unarmed after 8 bars | | −55 | 6 / 22 |
| time stop, below +0.25R after 4 bars | | −50 | 6 / 24 |

Every variant loses on 15m alone, on 4h alone, and in both halves of the sample. Today's replay
flatters break even because it reads minute closes: a stop at the entry is touched by wicks the
closes do not show, and one day has no slow runner that dips to the entry before paying.

**Verdict.** The pattern is real and not usable as an exit: the trades that will stop cannot be told
from the slow runners at the time a rule could act, which is decision 128's finding from the other
side. The stop costs one R by design; what it buys is the runners. The levers left are which trades
are taken (entries, markets) and how they are sized (decision 138's forward check on the Daily page).
`diagnose` takes `VARIANTS=a,b` to run only the named study variants.

## 142. $100 of margin per trade: 10× fixed, five open at most; 30× and Delta's maximum ruin the account (19 October 2026)

**Why.** The operator asked to see today's trades at 30× with $100 of margin each, then for the best
combination at $100 of margin. Replayed with the trades' real fills, exits and times; profit and
fees scale with size; a trade whose recorded worst point crossed the liquidation price (1 ÷ leverage
minus the market's maintenance margin, from Delta India's product list) loses the $100 and the entry
fee. Starting equity $1,000; a trade is skipped without free margin or over the open-position cap.

**Today at 30×.** Delta allows 30× on 3 of the 71 markets; on a 2.5% maintenance alt 30× liquidates
0.83% away against stops a median 1.48% away. 34 of 71 liquidated, the balance gone at 06:39 IST.
At each market's maximum (mostly 20×) +$413 against +$61 as traded, on a day 49 of 71 won.

**Two weeks** (account 156 trades; shadow 1,942, tracker cells excluded):

| $100 margin at | account, ≤5 open | DD | shadow, ≤8 open | DD | liquidations |
|---|---|---|---|---|---|
| 5× | +$126 | 10% | +$1,940 | 16% | 0 / 1 |
| 10× | +$241 | 21% | +$4,035 | 25% | 1 / 5 |
| 10×, lowered so liquidation stays beyond the stop | +$210 | 20% | +$3,274 | 25% | 0 / 0 |
| 15× | +$72 | 46% | +$5,617 | 45% | 6 / 25 |
| 20× | −$622 | 84% | −$907 | 94% | 8 / 23 |
| Delta's maximum | −$994 | 99% | −$942 | 95% | 12 / 12 |
| leverage set so the stop costs $20 | +$95 | 17% | +$751 | 70% | 0 / 0 |

Fixed size beats sizing by the stop because the wide-stop trades carry the book: in the shadow,
stops of 3% or more made +0.27R a trade over 394 trades and +$5,979 of the 10× total. Both halves
of the fortnight are positive at 5× to 10×. The shadow's 10× total keeps +$2,268 without its ten
best trades; the account's turns negative without its five best, so the account's edge is thin and
size multiplies whatever it is.

**Verdict.** If sized by margin: $100 at 10×, leverage lowered on the few markets where 10× would
put liquidation inside the stop, at most five open. Not applied; decision 138's forward check on the
Daily page is the same question and stays the gate.

## 143. Leverage per trade at $100 of margin: set by the cell's own recent record (19 October 2026)

**Why.** The operator did not want a constant 10× (decision 142). Rules that choose each trade's
leverage from what was known at entry, against flat 10×, at $100 of margin, liquidation always kept
beyond 1.25× the stop and under Delta's maximum, five open (and eight in the shadow), on the account's
156 trades and the shadow's 1,911 over the same fortnight, with shadow history from 22 September.

| rule | account, ≤5 open | shadow, ≤5 | shadow, ≤8 |
|---|---|---|---|
| flat 10× | +$206, DD 19% | +$1,779, DD 35% | +$3,611, DD 20% |
| by stop width 5 / 10 / 15× | +$152 | +$1,806 | +$3,806 |
| by timeframe 8 / 10 / 15× | +$167 | +$1,686 | +$3,528 |
| majors 15×, alts 8× | +$182 | +$1,764 | +$3,311 |
| drawdown throttle 10×, 5× when 5% down | +$106 | +$1,549 | +$2,729 |
| by scanner record | +$170 | +$1,474 | +$3,131 |
| **by the cell's record, ±0.05R → 20× / 5×, else 10×** | **+$291, DD 18%** | **+$2,049, DD 40%** | **+$4,118, DD 19%** |

The cell's record is the scanner on the same market and timeframe, its last 30 shadow trades closed
before the entry, at least 5 of them. Twelve settings of the rule (5 or 10 trades, thresholds ±0.05
to 0/0.2, the last 20 or 30) beat flat 10× on the account in all twelve, on the eight-open shadow in
ten, and on the five-open shadow in five; the ±0.05R setting wins in all three, both halves positive.
Its cost is a deeper drop in the five-open shadow, 40% against 35%.

**Today replayed:** +$242 against +$192 flat and +$61 as traded, deepest drop $69 against $93. The
record decided 13 of 62 trades (8 at 20×, 5 at 5×); 49 had under five past trades and stayed at 10×.
Not applied: the live engine sizes by risk, and decision 138's forward check is the gate for any
change of sizing.

**Note, 19 October: the top tier lifted to 50× or Delta's maximum.** At the operator's request the
strong-record tier was raised from 20× to 50×, still under Delta's maximum and the stop guard. Over
the fortnight it changes almost nothing: account +$291 (unchanged), shadow +$2,108 at five open and
+$4,138 at eight, worst drops 41% and 22%. Delta India caps most alts at 20× and the guard holds
wide stops lower, so only low-margin markets reach past 20×. Raising the middle tier instead costs:
10× → 20× takes the account to +$146 with a 35% drop; every trade at its maximum, +$114 and 37%.
Today's replay is the same +$242: the eight strong-record trades were all on 20× markets.

**Note, 19 October: the margin and leverage grid.** 180 combinations: margin $50 to $300, base
leverage 3× to 20×, flat or by the cell's record (weak half the base, strong up to 50× or Delta's
maximum), three, five or eight open, all under the stop guard. The most profitable on one book breaks
the other: $300 at 3× by record tops the account (+$447) and falls 83% in the five-open shadow; $300
at 20× tops the shadow (+$8,248) and ruins the account. Held to both books, both halves positive and
no drop past 30%, the best is **$150 at 5× by record (2.5× weak, up to 50× strong), up to eight open
as margin allows**: account +$303, worst drop 14%, worst day −$55; shadow +$4,418, drop 25%. Next,
$100 at 10× by record, eight open: +$233 and +$4,138. The account as traded made +$15 over the same
fortnight. Today: +$320 and +$265.

**Note, 19 October: smart leverage held between 5× and 20×.** Tiers, a sliding scale on the cell's
record (−0.1R → 5×, +0.2R → 20×) and a scale on the record's confidence (10× + 5 per t-unit), at $100
and $150, eight open and five. Every 5–20× rule is positive in both halves of both books at eight
open. The best balance is **$150, 5× by default and for a weak record, 20× for a strong one**:
account +$371 (drop 15%, worst day −$55), shadow +$4,715 (drop 19%), today +$333, against the 2.5 / 5
/ 50× setting's +$303 (14%), +$4,418 (25%) and +$320. Dropping a weak record to 2.5× does not pay:
a cell's poor recent record does not carry forward as strongly as a good one. More default leverage
buys more profit and more drop: 5 / 7 / 20× +$397 (20%) and +$4,985 (24%); 5 / 10 / 20× +$417 (27%)
and +$5,229 (28%), whose five-open shadow falls 57% with a losing first half. The sliding and
confidence scales add nothing over the tiers.

## 144. Margin sizing deployed: $150 a trade, 5× by default, 20× on a strong cell record, eight open (19 October 2026)

**Why.** The operator said "deploy" after the 5–20× study (decision 143's notes): $150 of margin, 5× by
default and for a weak record, 20× when the cell's last 30 shadow trades average above +0.05R, under
Delta's ceiling and the stop guard, eight open. Two weeks: account +$371 (drop 15%), shadow +$4,715
(drop 19%); today +$333 against +$61 as traded at 1% risk.

**What changed.**
- `paper.sizingMode` takes `margin`: the position is `marginPerTrade` × the leverage the record asks for,
  lowered by `leverageForStop` so liquidation stays beyond 1.25× the stop, and by the market's ceiling.
- `paper.marginLeverage` holds the tiers ({base 5, strong 20, weak 5, ±0.05R, 5 trades, last 30}).
  The engine reads the record at entry from the shadow book: same scanner, market and timeframe,
  closed before the entry, net of fees.
- `maxStopLossPct` does not apply in margin mode. The guard makes a stop-out cost less than the margin;
  measured, keeping the 3% equity cap would halve the result (account +$154, shadow +$1,854 with a
  39% drop) because it shrinks the wide-stop trades that carry the book. Risk and quality modes keep it.
- The shadow book stays on risk sizing, so its R evidence and the records it feeds do not change.
- `maxOpenPositions` 20 → 8.

**Watch.** The account's two-week edge rests on a few big winners; size multiplies it either way. The
Daily page's margin comparison (decision 138) keeps running against the R the trades make.

## 145. Where the stop-outs come from: one clean pattern, script-placed stops (20 October 2026)

**Why.** The operator: "what's the pattern of SL, how to reduce the SLs". 2,698 closed shadow trades
over 35 days (946 stop-outs, 35%) and 172 paper trades, split by what was known at entry, each bucket
judged in both halves (before and after 5 October); then each filter replayed in dollars under the
deployed sizing (decision 144) on the fortnight's paper and shadow trades.

| trait, shadow | n | stopped | R a trade, halves |
|---|---|---|---|
| stop placed by the script | 209 | 42% | −0.122 / −0.089 |
| ATR fallback stop | 2,486 | 35% | −0.073 / +0.100 |
| majors, stop under 1.2% | 214 | 18–25% | −0.17 both |
| alts, stop 0.8–1.2% | 439 | 44% | −0.017 / −0.108 |
| alts, stop under 0.8% | 631 | 39% | −0.013 / +0.181 |
| alts, stop 4% or more | 285 | 28% | +0.075 / +0.344 |
| cell record below −0.1R | 602 | 32% | −0.057 / −0.045 |
| entered 12–16 UTC | 582 | 38% | −0.204 / −0.010 |

Another signal on the same market and side within 15 minutes looked strong (26% stopped) until only
signals before the entry were counted: the effect was later confirmations, not usable at entry.
Longs lost and shorts won in October; that is the month's direction, not a rule.

| filter, $150 at 5× / 20× | paper net | paper stop-outs | shadow net | shadow drop |
|---|---|---|---|---|
| none (deployed) | +$387 | 48 | +$4,722 | 19% |
| skip script-placed stops | +$435 | 45 | +$5,396 | 18% |
| skip majors with stops under 1.2% | +$321 | 46 | +$5,206 | 19% |
| skip cell record below −0.1R | +$289 | 45 | +$4,328 | 22% |
| script stops + alts 0.8–1.2% + majors under 1.2% | +$406 | 38 | +$5,911 | 12% |

**Verdict.** The stop-out rate cannot be predicted at entry (decisions 128, 137); what can be avoided
is the trades that lose on average. Script-placed stops are the one clean case: worse in both halves
of both books, and skipping them improves both books in both halves. The alt 0.8–1.2% band removes
the most stop-outs (a quarter in both books) and the shadow's drop to 12%, but tighter alt stops win,
so the band may be noise; it is a forward test, not a rule. Nothing applied.

## 146. The account takes only the ATR stop: script-placed stops refused (20 October 2026)

**Why.** Decision 145: stops a scanner places itself (levels source `script` or `mixed`) lose in both
halves of both books, and skipping them improves both (paper +$387 → +$435, shadow +$4,722 → +$5,396
under the deployed sizing). The operator said "deploy".

**What changed.** `paper.skipScriptStops` (default off; on in the deployment): the account refuses an
entry whose stop came from the script, with the reason "the scanner's own stop". The shadow book is
untouched and keeps recording those trades, so decision 145's finding is checked forward. The refusal
counts as `other` in the signal funnel, not `cost`; a live cell that only ever brings script stops goes
silent and the silent clock demotes it.

**Note, 20 October: both ledgers replayed under the live rules.** Every closed paper trade (172, since
5 October) and 35 days of shadow trades (2,698), with their real fills and exits, under decisions 144
and 146 from $1,000 each. The stored records are unchanged. Paper: +$1 as recorded → +$434 corrected,
154 taken, 11 skipped for a script stop and 7 for no slot, 52 stop-outs instead of 61, deepest drop
9.9%. Shadow as one $1,000 account: +$6,766, 1,502 taken, 212 script stops skipped, deepest drop 33%
in late September; every ATR-stop signal at $150 +$8,962; +118.9R as recorded, +140.1R without the
script stops.

## 147. The whipsaw gate re-measured: it cuts volume, not bad trades; 0.1 keeps the fleet's edge (20 October 2026)

**Why.** ETH's signals were refused as choppy all of 19–20 October (efficiency 0.03–0.09 against the
0.25 floor; 788 of about 1,390 fleet signals in 48 hours). The operator: "check". `diagnose` with the
gate off (`spread`) and at 0.1, 0.15, 0.2 and 0.25 (live), under the current exits and costs, on the
tracker's 19 WillyAlgo scripts on ETH, BTC, SOL and XRP at 15m, 1h and 4h (127 cells with ten or more
trades), and on the 72 exit-study cells (40 with ten or more).

| floor | fleet R | R a trade | halves | majors R | ETH R |
|---|---|---|---|---|---|
| off | +200.5 | +0.044 | +72.7 / +127.9 | −347.8 | −61.3 |
| 0.1 | +188.4 | +0.058 | +60.6 / +127.9 | −235.6 | −49.5 |
| 0.15 | +147.2 | +0.054 | +53.2 / +94.2 | −153.9 | −34.1 |
| 0.2 | +113.4 | +0.051 | +33.6 / +80.1 | −115.8 | −22.5 |
| 0.25 (live) | +73.4 | +0.042 | +14.0 / +59.6 | −91.1 | −9.7 |

**Reading.** The gate barely changes R per trade (fleet +0.044 off, +0.042 at 0.25): what it refuses is
about as good as what it keeps, so it only sets how many trades are taken. On the fleet's cells, which
make money, 0.25 gives up 127R of 200R and loses in both halves, 28 cells worse against 10 better. On
the WillyAlgo scripts on the majors, which lose with or without it, it shrinks the loss by trading
less; the incubator, not the gate, is what keeps those cells out of the account. At 0.1 the fleet
keeps 94% of the ungated R on 29% fewer trades, with the best R per trade of the five.

**Verdict.** The 0.25 floor (decision 70, set under the old 40% trail) now costs the fleet most of its
edge. Proposed: `risk.regime.minEr` 0.25 → 0.1, for the account and the shadow book alike. Not applied.

## 148. The first-move problem: four ways round it, all four lose; the pullback limit entry measured (20 October 2026)

**Why.** Minute paths of 1,929 trades over 14 days (paper and shadow): on 15m a stop-out leaves ±0.25R
in a median 6 minutes, 91% of them downward, and is stopped at 39 minutes; a winner leaves in 7, 64%
upward, arms the trail at 22 (a quarter after 51, a tenth after 94). Trades still unarmed after 15 to
120 minutes end as winners 50–57% of the time. No armed trade stopped out. The operator: "how to
address this chicken and egg".

**The untested quadrant, the pullback limit.** Enter only if the price first comes back k R against
the signal within N bars, at that price; same exits. Estimated from the minute paths (closes; the
recorded worst when the trade ended inside the window):

| 15m | filled | stop-outs filled | winners missed | R |
|---|---|---|---|---|
| at the signal | 100% | 573 of 573 | 0 | +67.0 |
| 0.1R, 1 bar | 72% | 496 | 354 of 966 | +2.4 |
| 0.2R, 2 bars | 62% | 513 | 522 | −35.4 |
| 0.3R, 4 bars | 57% | 539 | 627 | −23.6 |

On 1h every limit is worse than the signal; on 4h the best (0.1R, 4 bars) is +58.6R against +60.6R.
A resting order is filled by the trades going wrong and missed by the ones going right.

**Verdict.** Enter later on confirmation (decisions 133, the `confirm1` variant), enter better on a
pullback (this), leave earlier on the first adverse move (128), leave a trade that has not moved
(141): all lose. The first move cannot be used at the level of one trade; the −1R is the price of the
trades that go straight up. It is handled across trades: which cells trade (the incubator), how much
each gets (decision 144's record), the script-stop filter (146), one position per market, and the
timeframe mix (4h +0.23R a trade on 259 trades against 15m +0.04R on 1,597 in this sample).

## 149. The timeframe mix measured: more weight on 4h loses out of sample; the current mix stays (20 October 2026)

**Why.** Decision 148 named the timeframe mix as the one lever not yet pulled (4h +0.23R a trade
against 15m +0.04R over 14 days). The operator: measure, do not apply; apply only if it improves the
result out of sample. Per-cell `diagnose` cannot measure it, since a cell's R does not depend on its
size; the mix shows only when trades compete for one account's money and slots. So: an account replay
under the live rules (decisions 144 and 146: $150, 5× or 20× by record, stop guard, ATR stops only,
eight open), size factors per timeframe and caps on the slots 15m may hold, on the shadow book's
2,731 trades over 35 days as one $1,000 account and on paper's 188 (paper has never taken a 4h trade).
Each variant judged in both halves; the variant with the best first half is the out-of-sample pick.

| shadow, $1,000 account | net | Δ | drop | Δ 1st half | Δ 2nd half | Δ size-weighted R, 2nd |
|---|---|---|---|---|---|---|
| as live | +$6,623 | | 33% | | | |
| 4h ×1.5, 15m ×0.67 | +$5,417 | −$1,206 | 49% | −$448 | −$758 | −12.2 |
| 4h ×2, 15m ×0.5 | +$5,018 | −$1,605 | 54% | −$603 | −$1,002 | −7.5 |
| 4h ×1.5 alone | +$6,853 | +$231 | 48% | −$187 | +$418 | +3.3 |
| 15m ×0.67 alone | +$4,877 | −$1,745 | 33% | −$266 | −$1,479 | −21.6 |
| 15m in at most 6 of 8 slots | +$6,706 | +$83 | 33% | $0 | +$83 | −1.6 |
| 15m in at most 4 of 8 slots | +$6,026 | −$596 | 31% | +$36 | −$632 | −14.5 |

Out-of-sample picks: shadow, "15m in at most 4 slots" (first half +$36) → second half −$632; paper,
"4h ×1.5, 1h ×1.25, 15m ×0.75" (first half +$22) → second half −$218. Every factor that moves size
from 15m to 4h loses on paper (−$187 to −$303).

**Reading.** In dollars under margin sizing the 15m cells are the book: +$5,272 of the shadow's
+$6,623, at much the same dollars a trade as 4h ($4.6 against $5.0), because they turn the slots over
many times. Decision 148's R-per-trade ranking, over 14 days, does not survive the 35-day account
replay. The one variant ahead overall (4h ×1.5 alone) lost its first half and lifts the drop from 33%
to 48%.

**Verdict.** Nothing passes out of sample. The current mix stays.

## 150. PineTS 0.11.1 and 0.12.0 assessed: 170 scripts recovered, but a fifth of the fleet's signals change; not adopted (20 October 2026)

**Why.** LuxAlgo shipped PineTS 0.11.0 (1 October), 0.11.1 (13 October) and 0.12.0 (19 October:
strategy broker emulator rebuilt on TradingView's intrabar path, `ta.pivothigh`/`pivotlow`/`valuewhen`/
`math.sum` from quadratic to O(1), resource limits and a closed-world verifier against host access).
We run 0.10.0. The operator: "go ahead" with the assessment. Done in an isolated worktree; the live
engine and the VM are untouched.

**Method.** `parity-dump` (new, `server/src/cli/`) runs a list of scripts on one saved candle set and
records every alert and shape bar time. 779 scripts (the 189 scanners in live, shadow and tracker
stages, and the 590 the 30 September compat report failed; 696 after removals) on BTCUSD 15m × 1,499
bars and SOLUSD 1h × 999, under 0.10.0, 0.11.1 and 0.12.0. The test suite passes on both (343).

**A harness flaw, also in `compat`.** The first run reported about 300 scripts "hung" under every
version, fleet scanners included. Every script was queued at once and its 150 s deadline started at
the queue, so the tail of the queue timed out waiting. With one script per worker in flight the hangs
vanish. `compat` had the same flaw and is fixed the same way; quarantine counts it produced since the
library grew were inflated by it.

**Results, BTCUSD 15m (SOLUSD 1h within a few scripts):**

| | 0.11.1 | 0.12.0 |
|---|---|---|
| scripts that fail on 0.10.0 and run | 168 | 186 |
| scripts that run on 0.10.0 and fail | 3 | 3 |
| fleet indicator scanners, identical signals | 127 of 144 | 124 of 144 |
| fleet strategy scanners, identical signals (with the fix below) | 20 of 40 | 12 of 40 |
| total run time of the scripts that run on both | 444 s → 296 s | 444 s → 415 s |

**Strategies and `mincontract`.** Our provider tells PineTS every market's minimum contract is 1
(`pine/provider.ts`). 0.10.0 ignored it; from 0.11.0 orders are floored to it and rejected below, so
a strategy sized under one BTC places no trade: eight fleet strategies went to zero on BTC. Reporting
0.000001 brings seven back. It is part of any upgrade, not applied now.

**What still changes.** 21 fleet indicator scanners differ: some barely (nexus-fusion 98% of signals
shared), some wholly (volumetric-fair-value-gaps 35 → 126 signals with 8% shared, ranked-order-block
258 → 1,551, dynamic-trend-bands 18% shared); triangular-hull-moving-average-volatility, which trades
in the account, has 54 signals under 0.11.1 and none under 0.12.0. About half the strategy scanners
keep their count but fire on other bars, as the TradingView fill path predicts. Which version matches
TradingView can only be read on TradingView itself.

**Verdict.** Not adopted. The upgrade would recover about 170 library scripts for the screen and
bring the resource caps, but it rewrites the signals of a fifth of the fleet's indicators and half its
strategies, so their shadow records would describe a different engine. Adoption, on the operator's
word, means: 0.12.0 with the `mincontract` fix; triangular-hull and two or three of the rewritten
scanners checked against TradingView; the cells whose signals change sent back to the screen, as
decision 134 does for strategy cells. The worktree stays in the session scratchpad until then.

## 151. PineTS upgraded to 0.12.0; 41 changed scanners re-prove themselves on it (20 October 2026)

**Why.** Decision 150's assessment; the operator: "upgrade".

**Two fixes the upgrade needs.**
- `int-window-length` (a compat rule): a `ta.*` window whose length is written as a division is wrapped
  in `int()`. Pine v6 divides ints to a float; 0.12.0 returns na for a fractional window where 0.10.0
  truncated, so Hull-type averages went silent: triangular-hull-moving-average-volatility, which
  trades in the account, had 54 signals under 0.10.0 and none under 0.12.0, and 54 again with the
  rule (89% of them on the same bars; the rest is 0.12.0's TradingView history inside functions).
  14 library scripts carry the pattern.
- `mincontract` 1 → 0.000001 in the provider: from 0.11 strategy orders are floored to it, so a
  strategy sized under one BTC traded nothing; seven of the eight silent fleet strategies came back.

**Parity of the final build** (0.12.0 with both fixes) against 0.10.0 on the 189 scanners in live,
shadow and tracker stages, BTCUSD 15m and SOLUSD 1h: 148 keep at least 90% of their signals on the
same bars on both markets; 41 do not (30 strategies, 11 indicators; listed in
`ops/engine-0.12-changed-scanners.txt`); none fails. fast-v-slow-moving-averages-strategy produces no
trade under 0.12.0 on either market and will fall out at the screen. The suite passes (345).

**Re-proof.** `cli/rescreen.ts` (dry run unless `APPLY=1`), through the incubator's store, logged as
`engine-upgrade` events: the changed scanners' shadow and proposed pairs keep trading with their
evidence window restarted at the upgrade, so the gate and its deadline judge only trades on the new
engine; their candidates' screens expire (kept for the record) so none is admitted on an old screen
and the nightly screen re-screens them. Live, tracked and retired pairs are left: the one live pair
(pulse-trend-radar on STRKUSD 15m) kept every signal on BTCUSD and 83% on SOLUSD.

**Not done.** No scanner was compared with TradingView itself; the ones most worth a look on the
operator's chart are volumetric-fair-value-gaps, ranked-order-block-zones-zeiierman and
dynamic-trend-bands-anchored-vwap-signals, the three whose signals changed most.

## 152. The LuxAlgo MCP read: the library is already synced, nothing to import; Edge Stats agrees with our timing findings (20 October 2026)

**Why.** The operator asked what the LuxAlgo MCP (`mcp.luxalgo.com/mcp`, added to Claude Code for this
project) and LuxAlgo's other updates mean here. Read over its HTTP endpoint (no key; the client is
`_research/journal-20261018/luxalgo-mcp.py`; the catalogue pages from 0).

**Library.** 853 indicators in the catalogue; 800 are in the repo's manifest. Of the other 53, 47
(January to October 2026, Valid BOS Pullback and Displacement Sweep Reversal among them) are already
on the VM: the weekly `vnedge-library-sync` timer (Sundays 03:30 UTC, decision 65) imported them into
`data/library`, all runnable, and the screen walks them with the rest. The remaining six are LuxAlgo's
own screeners and backtesters, whose source is not published ("runs-in-quant"). Nothing to import; the
sync keeps running. `library_get_source_code` is a cleaner source than the page scrape if the site
changes.

**Edge Stats** (BTCUSDT, UTC sessions since 2020, 2,484 days): the day closes green 50.9% of the time,
both halves agreeing; CPI days 54% (81) and FOMC days 58% (53), intervals spanning 50%; the daily high
falls in the first UTC hour on 14.8% of days, drifting from 17% to 12%; after a narrow-range (NR4) day
the next reaches a full ATR 3.2% of the time. The same story as decision 123 and the regime study: no
direction by day or event, and volatility that persists. No rule follows from it.

## 153. The Library page: every script, browsed like a chart platform's indicator library, with the bot's measured record (20 October 2026)

**Why.** The operator showed LuxAlgo Vela's indicator browser (families with counts, new releases, a card grid, a
detail panel with Add to chart and Favorite) and asked for "something like this".

**What it is.** `/library` (nav "Library", hotkey `g b`):
- **Sidebar.** Yours (Favorites, In use), Library (Discover, All scripts, Strategies, Doesn't run), and the families
  with counts. On a phone it becomes a strip of chips.
- **Discover.** New releases (the manifest's `updated`), Earning in the shadow book (30 days, ten trades or more),
  Trading in paper (a live pair), and More to explore (runnable, no pair in use, shuffled).
- **Other views.** A sorted grid: relevant, newest, shadow R or name, sixty at a time.
- **Cards.** Where Vela shows a picture, a card draws the script's cumulative R over its last 30 shadow days. Its
  chips give where its pairs sit (live, shadow, proposed, tracked) and whether it runs.
- **Detail panel.** The 30-day shadow result, the paper record in dollars, every pair with its stage, screen result
  and 30-day shadow line, the last twelve trades, and Add to chart, Favorite, Scanner page, and a link to the source.
  On a phone it opens as a full-screen sheet.
- **Layout and keys.** On a wide screen the three columns scroll on their own. `/` searches, Escape closes. The view
  and the selected script live in the address.

**Families.** LuxAlgo's 17 families (the taxonomy of its Library). They are assigned from the manifest row, then from
LuxAlgo's catalogue (`scripts/luxalgo-families.json`, names and family keys only, read from the LuxAlgo MCP), then
from the script's name; 506 of 2,667 stay "Other". The registry now carries `family`, `origin` and `license`.

**Server.**
- `GET /api/library` returns the list, cached a minute, plus the caller's favorites.
- `GET /api/library/:id` returns one script's detail.
- `POST /api/library/favorites` saves a favorite. It is allowed to viewers, like a backtest. Favorites are kept per
  user in `kv`.

**Add to chart.** The Chart page takes `?add=<id>[,<id>]` and runs any runnable script on the chart, enabled or not,
with a chip to remove it.

**Checked.** In the browser on a local server over a snapshot of the VM's database: the shelves, a family view, search,
the detail panel, Add to chart for an enabled script (SuperTrend Cluster) and for one that is not (Retest & Break
Setup), a favorite saved and listed, the phone layout with the sheet, and the light theme. 347 server tests pass,
including the classifier and the service; the dashboard builds and the changed files lint clean.

## 154. The dashboard's chart upgraded: Vela 0.8.5, its Pine add-on 0.2.17, and the browser's PineTS 0.12.0 (20 October 2026)

**Why.** LuxAlgo's blog announced Vela 0.8.5; the dashboard ran 0.7.6, and its charts ran their own PineTS 0.9.34
while the engine trades on 0.12.0 (decision 151), so a script could draw differently from how it trades. The operator:
"upgrade".

**What changed.**
- `@luxalgo/vela` 0.7.6 → 0.8.5 and `@luxalgo/vela-pinets` 0.2.12 → 0.2.17 (which supports 0.8). The only change
  Vela's changelog flags as breaking, the removed `linear-regression` study, is not used here.
- `updateCode` resolves to `{ ok, error }` since 0.8.2 instead of throwing; the chart now waits for it, keeps the
  previous code on failure and shows the error.
- The dashboard's `pinets` 0.9.34 → 0.12.0, the engine's version, and the chart's data provider reports the same tiny
  `mincontract` as the engine's, so strategy scripts place their trades on the chart (decision 151).

**Checked.** In the browser on a local server: triangular-hull (which needs decision 151's window-length rule) and a
strategy (fast-scalper, which needs the `mincontract` fix) both draw on BTC 15m, added through the Library's Add to
chart; no chart error in the console. The dashboard builds; the server suite passes (347).

**Also read from the blog**, for later: a random-entry benchmark with matched trade count, holding time and side mix;
directional dependence tested on detrended prices and against the market's own drift; edge decay judged on rolling
expectancy; Monte Carlo of trade order for drawdown percentiles. None is built here.

## 155. Four checks from LuxAlgo's research posts, run: the signals beat random entries; the rest adds no rule (20 October 2026)

**Why.** Decision 154 listed four tests from LuxAlgo's blog that had never been run here. The operator: "run and check".

**1. The fair benchmark.** `diagnose` variants (decision 155):
- `sig-atr`: the scanner's own entries with the bot's exits and the ATR stop. The script's stops, targets and exit
  events are dropped, as the account trades since decision 146.
- `rand-1..20`: the same number of entries with the same sides on seeded random bars, same exits and costs.
- `sig-long`, `sig-short` and `drift` (the market's own move over the bars).

Run on the 72 exit-study cells; 35 have ten or more trades.

| | cells | scanner entries | random median | above 90% of random | above the median |
|---|---|---|---|---|---|
| all | 35 | +221.5R | −119.7R | 19 | 33 |
| 15m | 18 | +72.9R | −13.4R | 7 | 16 |
| 1h | 2 | +26.4R | −7.2R | 2 | 2 |
| 4h | 15 | +122.2R | −99.0R | 10 | 15 |

Both halves: scanner +88.0 / +133.4R, random median −57.1 / −47.0R. One cell sits at the bottom of its random runs
(trend-impulse-channels on 1000PEPE, ten trades).

**Reading.** The exits and the trail do not make money by themselves: on random entries they lose about −0.03R a trade
after costs. The edge is in the entries' timing. Caveat: these cells were picked because they traded in the books, which
the screen and the gate fed on overlapping history, so the size of the margin is flattering; its sign, in every
timeframe and in both halves, is not.

**2. Directional dependence.** Across cells, the gap between long and short R a trade does not follow the market's drift
(correlation −0.01). In totals, longs earned more where the market rose (+104.5R against shorts' +11.4R) and shorts
where it fell (+57.2R against longs' +21.7R), but both sides were positive in both. The random runs carry the same side
mix and still lost, so drift alone did not pay. Our "October" pattern of shorts winning is the month's tilt, not the
edge.

**3. Edge decay.** A warning when a pair's last trades turn negative after a positive record, or its win rate falls ten
points or more, was tested at every checkpoint in the shadow history:

| window | checkpoints warned | next trades, warned | next trades, not warned |
|---|---|---|---|
| per pair, last 15, next 10 | 14 | +0.136R | +0.119R |
| per scanner and timeframe, last 30, next 20 | 26 | +0.097R | +0.198R |
| per scanner and timeframe, last 50, next 30 | 3 | +0.464R | +0.311R |

It does not separate consistently, and only three pairs in use have the 60 trades the posts' windows need. No rule; the
shadow book is too young for this test.

**4. Monte Carlo of trade order** (decision 146's corrected ledgers, current sizing, 10,000 reshuffles):

| book | trades | actual worst drop | median | 95th percentile | 99th | wiped out |
|---|---|---|---|---|---|---|
| paper | 154 | 10% | 11% | 18% | 22% | 0% |
| shadow as one $1,000 account | 1,502 | 33% | 20% | 42% | 57% | 0.01% |

Paper's sizing leaves a fifth of the account as a plausible worst drop and no ruin. Nothing changes.

## 156. Trade replay: any trade's bars revealed one at a time, with its stop as it moved and its state at the cursor (20 October 2026)

**Why.** LuxAlgo's trade journal replays a trade on its chart; the operator: "build trade replay".

**What it is.** `/trades/:id/replay`, opened from the trade-path pop-up ("Replay on chart") on the Trades page and the
open-positions table.
- **Chart.** The trade's own market and timeframe on the chart, rewound through Vela 0.8's `chart.replay` to 40 bars
  before the entry and framed to the trade (`setVisibleRange`).
- **Controls.** Rewind, Entry, Play/Pause, Step, Exit, a speed choice and a scrubber; space, → and Home do the same from
  the keyboard.
- **Overlay.** A generated Pine overlay (`chart/replayOverlay.ts`):
  - the entry, the stop it opened with and the targets, drawn only across the trade's life;
  - the stop as a step line through every move the engine recorded in `position_path` (the floor and the trail);
  - markers at the entry and exit bars.
  - Each bar shows the stop as it stood when that bar closed, so the replay never shows a move early.
- **Side panel**, as the trade stood when the cursor's bar closed: before / in the trade / closed, R now, best and worst
  so far, where the stop was (in price and R), the levels, and every recorded event up to the cursor.

**Server.** `GET /api/positions/:id/path` now also returns the trade's timeframe, scanner, book, status, stop source and
result.

**Chart.** `VelaChart` takes `onChartReady` to hand the instance to a page that drives it.

**Checked** on a local server over a snapshot of the VM's database:
- #3221, a stop-out: the panel reads −0.99R with a best of +0.10R and the stop-out event.
- #3199, a trail exit: the stop line steps down as the trail tightened, "exit trail +0.39R" sits at the exit bar, and
  the panel reads best +0.49R, worst −0.63R and the stop move.
- Play, pause, seek and framing work; the pop-up links to the replay.
- The dashboard builds; the server suite passes.

## 157. Admission in real time: candidates enter the shadow book when their blocker clears, not at the next night (20 October 2026)

**Why.** The Incubator page said 68 candidates "passed the screen, waiting for a slot" while 126 shadow slots were free.
None waited for a slot. On the VM at 12:30 UTC:

| candidates | held by |
|---|---|
| 50 | the market is outside the gate's universe today |
| 10 | the screen was expired by the PineTS upgrade (decision 151) |
| 6 | the gate refuses the market today |
| 1 | a strategy screened before the fill fix (decision 134) |
| 1 | its scanner already holds 8 pairs on 15m |

Admission ran only inside the hunt: the nightly `incubate` run at 01:00 UTC, or when a screen finished. A market the
hourly gate allowed again at 09:00 let its candidates in at 01:00 the next night. The operator: "can't that be real time?"

**What changed.**
- `admitOnly` runs the admission step on its own. `App.incubatorAdmit` calls it after every market-gate refresh (hourly)
  and every 10 minutes between hunts, then syncs the shadow runner so the new pairs trade from their next bar.
- Judging, promotion, demotion and retirement keep their daily pace in the hunt.
- `candidateBlockers` names what holds each passed candidate, by `admit`'s own rules in its order: expired, stale,
  outside, refused, re-screen, scanner cap, no slot, otherwise admissible.
- `/api/incubator` returns the counts and the last admission. The Candidates card shows them instead of "waiting for a
  slot", with the rules in its tooltip.

**Not changed.** Re-screens still come from the nightly screen, a separate job; the 11 that wait for one move as it
reaches them.

## 158. Zeiierman's recent scripts tested against the fair benchmark; three that the old compatibility report blocked re-checked under PineTS 0.12 (20 October 2026)

The operator: "Zeiierman Trading new scripts are available, check and test". The weekly library sync had imported
Rolling Candle Profile with Buy/Sell Signals (published 19 October). Each recent Zeiierman script ran through diagnose
with the decision 155 benchmark (`VARIANTS=sig-atr,rand`) on BTC, ETH, SOL, XRP, ZEC and AKE at 15m, 1h and 4h.

| script | 15m | 1h | 4h |
|---|---|---|---|
| Rolling Candle Profile (new) | −17.3R / 163 | +26.5R / 318, both halves up | +32.8R / 292, both halves up |
| Levels Likely to Break | −1.5R / 37 | −3.1R / 60 | +33.9R / 81, both halves up, above 90% of random in 5/5 |
| Zeiierman Bands | −7.0R / 122 | −10.0R / 142 | +32.0R / 295, both halves up, above random median in 5/6 |
| Trend Deviation Channel | −88.1R / 932 | +25.4R / 852, above 90% of random in 4/6 | +6.8R / 433 |
| Buyers & Sellers Profile | −4.0R | −5.8R | +4.9R; about zero per trade, never above 90% of random |

Curved Trendlines draws only (no entries in 18 cells). Market Matrix emits labels only and stays quarantined for memory.
HTF 3-Candle System and MTF Liquidity Stack now run but give no entry: the first's bullish/bearish alerts describe a
state that holds for many bars ("FVG currently present"); the second's alerts are about liquidity levels, with no direction.

**The compatibility re-check.** The report still carried the PineTS 0.10 failures for three scripts, so diagnose refused
them. Under 0.12 Trend Deviation Channel and MTF Liquidity Stack run unchanged (the `railPaint` / `trackWick` method gaps are
closed). HTF 3-Candle stopped on its own guard: PineTS serves `request.security` by re-running the script on the requested
timeframe, where the guard compares that timeframe with itself. The new `htf-guard` patch removes only a one-line
`runtime.error` guard of the form `timeframe.in_seconds(x) <= timeframe.in_seconds(timeframe.period)`. Of the library it
matches only this script; the guards in two LuxAlgo scripts that check the chart timeframe alone are kept.

**Not changed.** No scanner is admitted or released by this. The ones with a 4h or 1h edge reach the shadow book through the
incubator's own screen.

## 159. The account trails trades of strategies on their own exits; the shadow book keeps measuring the exits alone (20 October 2026)

ARIAUSD long #3241 (Alphamojo Supertrend HA, 15m) ran to +1.33R and handed most of it back with its stop still at entry
−1R. Its scanner is one of the five on exit mode `script` since decision 114, where the bot's trail, floor, stall and
time stops are off and only the strategy's own exit, or a 3 ATR disaster stop, closes the trade. The bot's rules would have
held the stop near +1.2R. The operator: "in the event of reversal we lose all".

Decision 114 moved those five to their own exits for the shadow book, where none was then in the account. The account now
takes them too (decision 146 admits their ATR stops), so it carried trades with no protection at all. Since the switch the
five shadow trades of this scanner that closed were full stops that never reached +0.5R; #3241 is the first to run and turn.

**What changed.** For a scanner on exit mode `script`, an account position opened at or after `paper.scriptExitTrailFrom`
(default 20 October 2026 13:30 UTC) adds the bot's trail and profit floor (`scriptModeProtection`: trail after +0.5R with
the give-back steps and stall tightening, floor +0.25R from +0.5R) over the script mode. The strategy's exit signals still
close it, and its targets, disaster stop width and the absent time stops stay the script mode's. The shadow book is
unchanged and keeps measuring the strategies' own exits.

**Why a cutoff.** A bar fills a stop at the stop's price. A trail applied to an open trade after the fact would set a stop
from a peak the price has already left (#3241: about +1.2R, with price near +0.5R) and book an exit at a level that did not
trade. #3241 finishes under its own exits; it was the only open account trade of the five scanners at the change.

## 160. A trail switched on mid-trade protects the open trade from that moment (20 October 2026)

Decision 159 left ARIAUSD #3241 out of the new protection because a trail measured from its old +1.33R peak would have set a
stop price had already left, and the bar fill would have booked it. The trade then ran to +5.3R with its stop still at −1R
and the operator closed it by hand: "protect the open in switch".

**What changed.** `trailStop` notes a position that runs under settings with no trail and no floor (`trailOff`). When a
trail later applies to it (protection switched on, or its scanner moved off exit mode `script`), the trail is armed then
(`trailArmedAt`) and measures its own peak from that moment and price (`trailPeakR`, `trailPeakAt`); the floor and the stall
clock use the same. The stop therefore starts below the price at the switch and ratchets with the run from there. The
trade's own `peakR` keeps recording the whole excursion for the forensics. The flags persist with the position, so a switch
made by a deploy's restart is caught too. The account now protects every script-exit trade once `scriptExitTrailFrom` has
passed, including one already open.

A trade that has trailed since entry is untouched, as is the backtest, whose settings never change mid-trade. No open
account trade of the five script-exit scanners existed at the change.

## 161. The shadow book protects script-exit trades too (20 October 2026)

The operator: "protect shadow too". Decisions 159 and 160 gave the account's trades of the five exit-mode `script` scanners
the bot's trail and floor and kept the shadow book on the strategies' own exits as the forward measurement of decision
114. The shadow book now gets the same protection, from the same `scriptExitTrailFrom`.

**What it costs.** The forward test of the strategies' exits alone ends: from now the shadow book measures their exits with
the bot's trail and floor added, the configuration the account trades. The nightly screen still runs every strategy under
both exit modes (`scriptExit`, decision 114), so the backtest comparison continues.

**The open trades.** Four shadow trades of these scanners were open, each marked `trailOff`: Alphamojo Supertrend ARIAUSD
15m (#3242, peak +5.63R), Donchian Breakout AKEUSD, ZECUSD and ETHUSD 1h (#3193, #3254, #3306). By decision 160 each trail
starts at the restart, from that moment's price.

## 162. Kioseff Trading's Market Structure Volume Profiles, built as two signal indicators and benchmarked (20 October 2026)

The operator shared the script and asked to "build and test as indicators". As published it cannot run (it imports
Trading-IQ's ICTlibrary v2, and PineTS loads no TradingView library) and has nothing to trade (its BoS and CHoCH are drawn
lines; no alert, no shape).

**The build** (`OPERATOR03` CHoCH, `OPERATOR04` BoS; both MPL-2.0 like the originals, with the notices kept):
- The library's two types and four functions the script uses (labelLine, rejectionBlocks, necessaryData, isLastBar,
  drawBos, drawMSS, and what they call) are inlined in place of the import.
- `isLastBar` asked for the next bar's open (`time("", -1)`), which PineTS does not evaluate, so every break it gated
  was lost; it now compares the bar's own close with the chosen timeframe's, the same instant.
- A trailing comma after a `switch` arm, accepted by TradingView, is removed.
- The structure function returns the break it drew on the bar, and an alert fires at the close of the breaking bar: long on
  an upward break, short on a downward one, with no stop, so the bot's ATR stop applies. An input picks CHoCH, BoS or both.

**The benchmark** (decision 155: BTC, ETH, SOL, XRP, ZEC, AKE; 4,000 15m bars; 20 random-entry sets per cell):

| variant | 15m | 1h | 4h |
|---|---|---|---|
| CHoCH (structure turns) | −35.8R / 352 | +16.4R / 410; halves −5.0 / +21.3; above random median 6/6 | **+29.2R / 196, +0.149 per trade; halves +14.2 / +15.0; above 90% of random 3/6, median 5/6** |
| BoS (structure continues) | −26.6R / 335 | +6.8R / 431; halves −4.4 / +11.2 | −4.5R / 209 |

On 4h the CHoCH variant gains on five of six markets: SOL +13.5R (above every random set), ZEC +10.7R, BTC +2.7R, AKE +2.7R
and ETH +1.0R; XRP −1.4R. On 1h ZEC alone carries it (+18.7R of +16.4R). BoS adds nothing over random entries.

**Not changed.** Neither variant is enabled. Both enter the library; the incubator's nightly screen decides whether any
pair reaches the shadow book.

## 163. Kioseff Trading's published scripts checked; two parser patches; a condition-title bug found and held (20 October 2026)

The operator: "check anything works for us" on KioseffTrading's profile. 49 scripts, 5 closed-source. Of the 44 open, 40 are
visual tools with nothing to trade (volume and TPO profiles, ladders, optimizers, dashboards). Four carry signals:

| script | outcome |
|---|---|
| Market Structure Volume Profiles | built as CHoCH / BoS signals in decision 162: CHoCH on 4h +29.2R over 196 trades |
| Volume Filtered Candlestick Patterns | runs; 15m −57.3R / 681, 1h −34.9R / 452, 4h +1.7R / 94: no edge |
| RSI Failure Swings & AO Divergences | built as `OPERATOR05` (its variable `indicator` renamed, alerts added): 15m −4.7R, 1h −35.4R, 4h −2.8R: no edge |
| Stop Loss Cascades (Breakouts) | gets past the parser now, then stops on a PineTS runtime gap (`.delete()` on an empty drawing); not run |

**Two parser patches, kept.** Each was run on every script it changes, with and without it, on BTCUSD 15m: every script
that ran before gives identical output, and more run.
- `unused-ta-import`: an `import TradingView/ta/N` whose own functions (the library exports that are not built-in `ta.*`)
  the script never calls is removed. 15 library scripts.
- `statement-comma`: a comma that ends a statement with every bracket closed, followed by a line that starts a statement,
  is dropped (Pine's statement separator, which the continuation joiner read as a wrap). 18 library scripts; Smart Money
  Breakouts and Trendline Breakouts with Targets now run.

**The condition-title bug, held for the operator.** PineTS returns `alertcondition(c, title = …, message = …)` written
with named arguments as one object in `title` and an empty message; the extractor read "[object Object]", found no
direction and dropped the signal. 247 library scripts write their conditions that way. The candlestick test above ran
with the fix applied locally. Of the 191 active scanners, 25 are affected: they trade on their shapes today, and the fix
adds their conditions. On BTC 1h and SOL 15m it changes nothing for 7, adds a few entries for 12, and multiplies the
entries of Money Flow Divergence Zones (15 → 179 on BTC 1h), Nadaraya-Watson Liquidity Sweeps (77 → 157), Candlestick
Reversal and Trend Signals (87 → 154), Fisher Williams %R Divergence, Reverse RSI and Trend Targets. Their shadow records
were earned on the shapes alone, so the fix is not applied until the operator chooses how those records are treated.

## 164. Named-argument condition titles are read; every scanner with a record keeps the reading it was judged on (20 October 2026)

Decision 163 found that PineTS returns `alertcondition(c, title = …, message = …)` as one object in `title`, so such a
condition carried no direction and was dropped. The operator chose the fix that changes no current scanner ("deploy but
don't break anything", then "fix").

**What changed.**
- The worker unpacks the title and message, so a condition written with named arguments reads like a positional one.
- `scripts/condition-titles-legacy.json` lists the 243 scanners with a record on 20 October: every scanner with a
  candidate, shadow, proposed, live or tracked pair on the VM, or enabled in the account. The pool sets
  `legacyConditionTitles` on every job for one of them, live or research, and the worker then keeps the old reading
  exactly. A scanner whose conditions were never affected reads the same either way, so listing all of them costs
  nothing and guarantees none moves.
- Every other script reads its conditions from now on, which is how the nightly screen will judge it.

**Verified.** The 25 active scanners whose conditions use named arguments (decision 163) were run under the old and the
new code on BTCUSD 1h and SOLUSD 15m: all 50 extractions are identical, entry for entry and exit for exit. Volume Filtered
Candlestick Patterns, which has no record, goes from 0 entries to 31 and 54.

**To let a listed scanner read its conditions,** remove its id and re-screen it, as a new record.

## 165. Going-live preparation, first part: the account's mirrored entries scanned at once, and leverage set on the exchange (21 October 2026)

The operator asked to prepare for going live, then whether the execution layer matches Delta production and where the
latency is.

**What matches.** Hosts (`api.india.delta.exchange`, demo `cdn-ind.testnet.deltaex.org`), the HMAC-SHA256 signing of
method, timestamp, path, query and body in the `api-key`, `timestamp` and `signature` headers, the order payloads (market,
stop-loss on mark price, reduce-only limit targets, client ids) and the edit, cancel and client-id lookups. The VM's clock
is NTP-synchronised. Not yet exercised against the real API: decision 46's demo session never ran.

**Latency.** From the VM (Oracle Singapore) a request reaches Delta India's origin and returns in about 80 ms (CloudFront
answers cached reads at the Singapore edge in 4 ms). The real delay was inside the bot. Over seven days the account took
181 entries: 39 from its own scanners, a median 4.8 s after the bar's close; 142 mirrored from the shadow book (decision
116), a median 54 s after (p90 88 s), whose fill was 159.5 bps worse than the signal price at the 90th percentile against
−0.5 bps on the direct path. The shadow runner waited a fixed 20 s and then queued some 340 pairs at each 15m close as
background work on the pool's 6 workers.

**What changed.**
- The pool has a third tier, `mirror`, between `live` and `background`: it runs after every queued live job and before any
  background job, and the live backlog guard (500 queued live runs) does not count it, so a wave of shadow scans can
  neither delay nor crowd out the account's own scans.
- The shadow runner scans every pair the account may copy (every stage but `tracked`) at once in the mirror tier, the
  account's live pairs first, then proposals, then the rest. Tracked pairs keep the 20 s wait and the background queue.
- The executor sets a product's order leverage (`POST /v2/products/{id}/orders/leverage`) to the paper position's margin
  leverage, rounded down, before its entry, and only when it changed. A refused call, or an exchange that answers with more
  leverage than asked, voids the entry before any order is sent. Paper mode does not run the executor.

**Expected and to measure.** Six workers draining about 340 jobs of some 0.7 s still take about 40 s at a 15m close, so
the mirrored median should fall to roughly 20 s, not to the direct path's 5 s. More workers would take a service setting
(`VNEDGE_WORKERS`), proposed to the operator: the service uses 3.9 GB of its 8 GB soft limit with six.

## 166. Going-live preparation, second part: where the mirrored entries' latency goes, measured wave by wave (20–21 October 2026)

The operator: "fix all performance issues, no latency accepted". Decision 165 removed the shadow runner's 20 s wait and
gave mirrorable scans their own pool tier. To see what was left, the shadow runner now logs every bar close's wave of
mirror-tier scans: when the close was announced, when each scan was handed to the pool, how long it queued, how long the
script ran, and when the last one finished.

**Measured on the VM** (15m waves of about 326 scans; the account's own scanners are separate and were 4.8 s already):

| change | close seen | queue p50 / p90 | script p50 | wave done |
|---|---|---|---|---|
| before decision 165 (20 s wait, background tier, 6 workers) | — | 30 / 47 s | 0.48 s | 59.5 s |
| 8 workers (`ops/systemd/vnedge.service.d/workers.conf`, approved by the operator) | 3.3 s | 19 / 31 s | 0.48 s | 38.6–39.4 s |
| workers recycled after 500 runs instead of 12 | 1.8 s | 34 / 45 s | 0.62 s | 51.7 s, reverted |
| close announced after 1.5 s, checked every 250 ms (was 2.5 s, every second) | 1.8–2.0 s | | | kept |
| recycling back to 12, waves ordered by what the account can act on (20:45) | 1.7 s | 19 / 31 s | 0.45 s | 37 s |

- Recycling after 500 runs was tried because six scripts run 108 times in one process stay flat under PineTS 0.12.0
  (no leak). With some 150 different scripts passing through each worker it slowed the scripts and the wave; 12 stays.
- Each wave is now ordered by what can change the account: its live pairs and pairs on a symbol it holds first, then
  pairs it could enter now (not full, symbol free, market allowed), then the rest. All stay in the mirror tier, so the
  shadow book's own evidence is not delayed.
- The application logs to `data/logs/vnedge.log` and `vnedge.err`, not the journal. Read there: no error line on 20 or
  21 October; the 481 in the file are from 3–4 October and before. The warnings did show that before decision 165 the
  shadow runner skipped runs about 128 times an hour on a worker queue over 300; only tracked pairs can be skipped now.

**What is left is compute.** A script takes 100–250 ms in one process on the VM's Neoverse-N1 cores (30–80 ms on an
Apple laptop) and about 0.5 s inside a busy worker, and each scan replays 1,000 bars to judge the newest one. 326 scans on
8 workers is about 20 s of work at every 15m close. Halving the history saves about 40% (fixed costs remain) and would need
each scanner's signals proven identical at 500 bars. Only PineTS's streaming mode, which keeps a script's state and computes
the new bar alone, removes the replay; it needs per-pair state kept across workers and restarts and a parity proof against
full runs before any pair uses it. Proposed to the operator, not started.

## 167. The go-live rule reads what the money did under margin sizing; the size that passes its drawdown line (21 October 2026)

The operator asked to recheck the two failing go-live checks on the paper account, then to measure expectancy as the
account experiences it and to find the sizing that passes the drawdown check.

**The recheck** (238 account trades, read-only on the VM):

| trades | equal-weight R, mean / 90% lower band | R weighted by size | % of equity per trade, mean / lower band | net |
|---|---|---|---|---|
| all | +0.042 / −0.048 | +0.142 | +0.18% / −0.002% | +$493 |
| without the two manual closes | +0.021 / −0.062 | +0.080 | +0.11% / −0.029% | +$273 |
| before margin sizing (107) | −0.033 / −0.162 | −0.038 | −0.03% / −0.160% | −$38 |
| margin sizing (131) | +0.104 / −0.022 | +0.216 | +0.35% / +0.043% | +$531 |
| margin sizing, without the ARIAUSD manual close | +0.065 / −0.044 | +0.128 | +0.22% / −0.001% | +$309 |

The signals alone are about breakeven; the gain is in the sizing, and its lower band sits at zero. The drawdown check holds:
replayed from the account's own % returns the 30-day 95th percentile is 24–25%, and the real equity path already fell 13.8%.

**What changed.** Under `sizingMode: 'margin'` the rule now reads each closed trade's net result as % of equity at its
entry (`App.equityReturnsPct`): the expectancy check is the lower 90% band of that return, and the survival and drawdown
simulation replays those returns instead of R at the median risk. Under risk or quality sizing nothing changes. Today the
expectancy check still fails (−0.003%): a measurement corrected, not a bar lowered.

**The size that passes the drawdown line** (the rule's own simulation, the account's returns scaled):

| margin per trade | 30-day drawdown p50 / p95 |
|---|---|
| $150 (now) | 14.6% / 23.9% |
| $113 | 11.0% / 18.8% |
| $90 | 8.8% / 15.2% |
| $75 | 7.4% / 12.8% |
| $60 | 5.9% / 10.4% |
| $53 | 5.2% / 9.1% |

About $50 a trade passes. Proposed to the operator, not applied.

## 168. The Telegram alert channel installs from a script the operator runs on the VM (21 October 2026)

The go-live rule and the Gates page both wait on an alert channel: a halt, a stranded position or a hunt result must
reach a person. The bot reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from its service environment (decision 18: never
config.json, never the chat). `ops/telegram-setup.sh`, run by the operator with sudo on the VM:
- reads the token hidden from the keyboard and checks it with Telegram's `getMe`;
- finds the chat id from the message the operator sends the bot (`getUpdates`);
- writes both to `/etc/systemd/system/vnedge.service.d/telegram.conf`, root-only (600), reloads and restarts the bot, waits
  for its "alerts via telegram" line, and sends a test message.
The token is never on a command line (curl reads the URL from stdin), never logged and never printed.

## 169. The dashboard shell modernised: a grouped sidebar and a slim top bar replace the pill row, the icon rail and the terminal window (21 October 2026)

The operator: "do UI modernization". Twenty pages shared a header that had grown by accretion: seventeen navigation
pills in a row that overflowed at 1440 px, a second icon rail repeating the same five icons, a fake terminal window
(traffic-light dots and a monospace crumb) round every page, and a status strip that wrapped onto two rows.

**What changed** (`components/Layout.tsx`, `app.css`, `components/Icons.tsx`; the pages themselves are untouched and
inherit the tokens).
- A sidebar with the pages in four groups, each with its own icon: Trade (Overview, Signals, Trades, Chart), Research
  (Scanners, Library, Incubator, Trackers, Analytics, Daily, Learn, Decisions), Control (Gates, Exchange, Settings, Logs)
  and Account (Profile, Users). Decisions joins the navigation. The `g <key>` hotkeys are unchanged and show on hover.
- The sidebar collapses to icons (`[`, remembered in the browser) and on a phone becomes a drawer behind a menu button;
  the bottom bar of decision 121 stays.
- A slim sticky top bar: breadcrumb (section › page, with the parent for a scanner or a trade replay), the account's
  equity, day and open count, the kill-switch and reset actions, and the user. Connection state (stream, feed, last tick)
  and the theme, density and shortcut buttons live in the sidebar's foot.
- The terminal window, its dots and crumb, the icon rail and the pill row are gone. Tokens: 12 px radius, a softer
  accent glow, a real card shadow, calmer panel and KPI labels, the page title at 22 px. The serif accent in page titles
  stays, as the operator chose it (decision 91).
- The sidebar classes are `sidebar-*`: `.side` was already the long/short pill.

**Verified** on the local dashboard against a copy of the account: desktop at 1280 px expanded and collapsed, the phone
drawer at 721 px, the light theme, and the Library page's fixed-height layout; lint and the production build pass.

## 170. Why 21 October bled: a chop in three alts at full size, because drawdown scaling never reached margin sizing (21 October 2026)

The operator: "what went sideways today, too many SLs". By 15:30 UTC the account had closed 43 trades: 22 trails for
+$369, 19 stops for −$456. Equity 1,406 → 1,282 on the day, 14.4% below the 1,498 peak of 03:04 UTC.

**What it was.**
- A chop, not a code change. Eleven of the nineteen stops came from three markets the gate allowed (ATR 2–5%, book cost
  0.13–0.16%): AKEUSD lost long and short four times, BTWUSD four, GTCUSD three, re-entered an hour apart each time. The
  shadow book, which the day's changes did not touch, stopped out 34% of its trades today and 36% yesterday for −4.3R
  and −5.6R, against 31% and +2.0R on the 19th. The latency work (decisions 165–166) and the trails on script-exit trades
  (159–161) are not implicated: stops within fifteen minutes fell from 8 to 4 and stops that never reached +0.1R from 11
  to 6.
- The stops cost more than they used to. On the 19th a stop cost $9, yesterday $21, today $24. Median risk per trade went
  $10 → $16 → $20: the 20× tier faded as cell records weakened (51 trades at 20× on the 19th, 16 yesterday, 2 today), and
  $150 at the base 5× on alts with 2–5% ATR stops carries about $20 of risk.
- Drawdown scaling never engaged. `risk.ddScale` halves risk past 10% from the peak, and the account has been past it
  since this morning, but the multiplier scaled `riskPerTradePct` and `maxLeverage` (50 → 25), which margin sizing never
  reads: the margin stayed $150 and the tiers 5× and 20× sit far under the cap.

**What changed.** Under margin sizing the drawdown multiplier scales the margin posted per trade (`scaledCfg`): at
−10% from the peak the account posts $75 instead of $150 at the same leverage, until equity recovers. Tested on the
engine: the same entry sizes 7 contracts at ×1 and 3 at ×0.5.

**Not changed.** The repeat entries into a chopping market: the re-entry cooldown is 60 minutes and the regime gate's
efficiency ratio is 0.25 (decision 147 measured it as cutting volume, not bad trades). A per-market daily stop count is
the obvious next guard and is proposed, not applied.

## 171. The incubator audited: a promote–demote loop closed; the demotion rules judge the live period; a cooldown after demotion (21 October 2026)

The operator: "make sure the incubator is working with all scanners, promotion and demotions". The audit on the VM:
the nightly screen walks the library (7,845 runs last night, 74 passed, cursor on 1h slice 0), real-time admission runs
(3 admitted at 09:00), the gate proposes and `promote.auto` promotes (16 auto promotions in three days), retirement runs,
and no proposal waits on a click. 555 shadow pairs of 600, 323 candidates, 28 live cells.

**The fault.** Every demotion proposal of the last four days (27 of 27) came from the cost-starved and market-out rules,
17 of them within 24 hours of the pair's promotion, and two pairs went round in a loop: `kalman-step-signals TAOUSD 15m`
was promoted and demoted thirteen times in two days, `supertrend-cluster-zeiierman EVAAUSD 15m` four. The cost-starved
rule (decision 112) counted the cost-rule refusals of the last 14 days wherever they came from, and since decision 116
mirrors every shadow signal to the account, a pair arrived live with two weeks of refusals already on its record and was
proposed for demotion at the next hunt. Demoted, its shadow record still passed the gate, so the following hunt proposed
and promoted it again. Each turn flipped the scanner's live pairs in the config and sent a hunt alert.

**What changed.**
- The cost-starved rule reads the signals from the pair's own live period, and only once that period is a full
  `costStarvedDays` long. The silent rule already measured from promotion.
- A demoted pair is proposed again only on evidence gathered since the demotion that answers the reason it was demoted
  for (the operator refused a blind cooldown). Cost-starved or silent: the account must have opened one of the pair's
  mirrored signals since, or, for cost-starved, the cost rule must now pass at least half of a window's worth of them.
  A record below the floor, or the operator's own demotion: the shadow record since the demotion must pass the gate by
  itself. Market out: nothing beyond the market gate. The gate records which of these holds a pair back. Applies to the
  pair pool and the cohort pool.
- The live record's `days` is unchanged in meaning; the 20,747-day figure in the hunt evidence was the window's start
  with no trades, cosmetic.

**Tested.** The decision 112 test now gives its cell a full window live; a new test walks a pair through promotion, a
day live with old refusals (kept), a full window with none (kept), five refusals inside its live window (demoted), the
day after with nothing new (not proposed), three more cost refusals (still not proposed), then one opened signal
(proposed again).

## 172. The silent library surveyed; drawn labels, shape geometry and "above / below" read as signals; 228 more scripts speak (21 October 2026)

The operator: "some of the scripts may need tuning or the missing part; research and fix". `silent-survey` ran every
runnable script (2,664) on BTCUSD and SOLUSD, 15m, 1,500 bars, and read the output exactly as the scanner does. 1,132
produced entries; 1,532 did not: 386 drew labels only, 256 raised conditions with titles the reader found no direction
in, 78 drew shapes with neutral titles, 28 wrote alert text in their own words, 536 drew plots or nothing, 248 failed.

**What the silent ones emit.** Labels: ▲ and ▼ (27 scripts each), △ ▽, B / S, BOS / CHoCH / MSS, beside price texts.
Condition titles: "Price Crossed Above R1 / Below S1", overbought and oversold states, BOS and CHoCH, pattern phases.
Shapes: untitled ("plot", 11 scripts), "Signal", pivots and swings. Errors: a long tail of v4 syntax with no version
tag (40), library imports (25), one PineTS array gap (12), sessions PineTS rejects (14), external series (18).

**What changed** (`extractor.ts`; the reading-legacy list of decision 164 guards every rule, so the 243 scanners with
a record read exactly as before, which the survey ran under):
- A drawn label is read as an entry when nothing else in the run produced one: arrow glyphs, buy / sell words (B, S, L,
  BUY, SELL, LONG, SHORT, ACHAT, VENTE), directional phrases, and structure words (BOS, CHoCH, MSS, Break, Sweep) by
  where the label sits (under the bar a long, above it a short). Source `label`; the allow-list applies.
- A shape with a neutral title takes its side from its geometry: below the bar or an up-pointing shape is a long, above
  or down-pointing a short. Pivots, swings, extremes, tracks, levels, zones and session marks never.
- "above" and "below" carry direction in a condition title.

**Measured.** The 748 silent-with-output scripts re-surveyed: 228 now read (121 from labels, 79 from titles, 19 from
geometry, 9 from the rest); 76 LuxAlgo, 70 crypto-search, 31 BigBeluga, 17 ChartPrime, 8 Zeiierman. Their entry
density runs from one in 3,000 bars to a shape on most bars; the screen's density cap and the fair benchmark judge
that, not this decision. The nightly screen picks them up from its next slice.

**Not changed.** The 536 plot-only scripts (no signal to read; some could be given one by hand where a backtest says it
is worth it) and the 248 that fail, each error a handful of scripts.

**The label's bar is the bar it appeared on, not the bar it points at** (same day, after the first benchmark). Twelve of
the newly label-readable scripts went through the fair benchmark: two came out at +0.5R a trade on every market and five
at −0.6R on every market, the signature of labels drawn at past bars (a pivot label placed back at the pivot, confirmed
bars later) read as entries dated where they point. PineTS keeps only each label's final position, so a source patch
applied last (`label-created-bar`) gives every `label.new` call a tooltip naming the bar it is created on; the worker
reads it back as `createdAt`, and a label is read as an entry on that bar only, never without it. A call that sets its
own tooltip keeps it (that label carries no stamp). Regression over the whole library: no script reads less than
before and one, Balance vs Imbalance (LuxAlgo, inactive), fails on a PineTS scoping quirk the stamp exposes. Re-benchmarked: Support Resistance Pro Toolkit +0.46–0.59R a
trade → −0.07 (15m, 1h) and +0.08 (4h); Trend Reset Cumulative Delta +0.19–0.25 → −0.06 to −0.11; Volumetric Order Flow
Structure −0.68 → −0.15. The reading is honest now; the screen judges what is left.

## 173. A live scanner silently unscheduled for 37 hours: the compatibility report was load-bearing and a partial run overwrote it (22 October 2026)

The operator's screenshot: Liquidity Trail Matrix, three live cells and four shadow pairs, marked INCOMPATIBLE with a
PineTS 0.9-era error and "ran 1d 13h ago". No run had failed. Its manifest entry has said `incompatible` since the
original import; the registry overrode that only while `scripts/compat-report.json` held a passing row for it, and the
first `compat` run of 20 October (decision 158, without `--merge`) replaced the whole report with three rows. From that
deploy at 13:xx UTC the registry read the manifest, set the scanner `incompatible`, and the engine stopped scheduling
it: 37 hours without a scan on AIOTUSD 15m, MUBARAKUSD 1h and ETHUSD 4h. Two shadow-only scanners in the same state
(AMD PO3, Synapse Trail Pro) had never run. Ten scripts carried the old status.

**What changed.** All ten run under PineTS 0.12; their manifest status is `ok` now, so the report is not load-bearing
for them. `compat` keeps the rows of scripts it did not run unless `--replace` is given. The health and attention lines
did not catch this because nothing failed; a scanner that is enabled, holds live pairs and has not been scheduled is
worth an attention line of its own, proposed.

## 174. Screening on demand: "Screen now" from the Library and a scanner's page, a queue the Incubator page shows (22 October 2026)

The operator: "this screening cannot be on demand?" and "build it". The nightly screen walked the library a seventh at a
time; a new or newly readable script waited up to a week per timeframe, and the only way round was a hand run from the
VM's shell (which decision 172 used for the 213 newly readable scripts).

**What changed.**
- `ScreenQueue`: hand runs of the same screen job (`cli/incubate.ts` with `IDS=`), one at a time, never while the
  nightly's own process is alive, each inside a capped user scope (6 GB, two workers, nice 19; the service's user lingers,
  so the scope is reachable from it). Progress and the closing summary are read from the job's own log; the queue and the
  last twenty results live in the kv store, so a restart keeps what was queued and marks what it interrupted. The alert
  channel hears when a job ends.
- `POST /api/incubator/screen` with a script list, an author or a family and a timeframe (optionally markets);
  `GET` for the queue; `DELETE` to cancel (a running job is sent SIGTERM and stops at its next step).
- "Screen now" with a timeframe choice on every runnable script in the Library and on its scanner page, plus
  "Screen everything by <author>"; a "Screens on demand" panel on the Incubator page with the running job's progress bar
  and last log line, the queue, and the recent results.

**Verified** locally end to end: queued from a scanner page, running with the job's own lines on the Incubator page,
cancelled from there. The capped scope is the VM's and is checked after the deploy.

## 175. The trail's width measured: the tight trail is the right one; 15m is where the account bleeds (22 October 2026)

22 October to 16:37 UTC: 64 closed, 32 trails for +$272, 28 stops for −$444, equity 1,389 → 1,182. The shadow book
stopped out 34% of its 195 trades for about −16R: a chop day. The account's strong-record tier (9–20×, decision 144)
went 50/50 for −$137 after three days at 70–92% (+$543); re-priced at 5× the four days come out at −$68 against +$223,
so the tier stays. Over the four days the average trail exit was +0.53R against −0.98R stops, a 65% break-even win rate
the account missed by three points, so the trail's width was measured rather than assumed.

**The study.** The account's 15 scanners on BTC, ETH, SOL, XRP, ZEC and AKE at 15m, 1h and 4h, 4,000 bars, the spread
paid, 265 cells with trades, 10,920 trades under the current exits: floor +0.25R at +0.5R, trail from +0.5R giving back
10% of the peak (8% past 2R, 6% past 4R), tightening after 45 minutes without a new high.

| exits | total R | R a trade | halves | cells positive |
|---|---|---|---|---|
| current | +652.7 | +0.060 | +394 / +260 | 163 of 265 |
| give back 20% | +326.6 | +0.030 | +203 / +124 | 146 |
| give back 30% | +70.1 | +0.006 | +73 / −4 | 129 |
| give back 40% | −54.2 | −0.005 | −1 / −52 | 124 |
| trail only from +1R, 20% | −32.0 | −0.003 | 0 / −32 | 128 |
| floor only, no trail | −154.1 | −0.015 | −78 / −75 | 111 |
| reversal rule off | +628.2 | +0.058 | +386 / +242 | 163 |

Every inch of extra room costs more in give-backs than it earns on runners, in both halves. The small average winner is
how these scanners make money, not a flaw. The reversal rule is a wash (−25R over 10,854 trades). By timeframe, under
the current exits: 15m −125R over 2,726 trades, 1h +388R over 4,518, 4h +320R over 2,706; 15m loses under every exit
rule tried. Today's 28 stops were almost all 15m.

**Not changed.** Nothing. The exits stay as they are. The next question is the 15m cells' place in the account, to be
measured over the same window before anything moves; `diagnose` carries the new variants (`spread+give20/30/40`,
`spread+trail1`, `spread+floor`, `spread+norev`) for the record.

## 176. A hand screen made the nightly look dead: hand runs keep their own marker; a run records when it finished (22 October 2026)

The Overview said "the daily screen started 15 h ago and never finished". It had finished at 05:38 (146 passed, the
shadow book judged after it). The hand screen of decision 172, started at 01:57 from the shell, had written the
nightly's `incubator.lastStart`, and the nightly's own record carries only its start time, so the check read a start at
01:57 against a run at 01:06 and called it dead. A hand run (IDS=, TF=, SLICE=, MARKETS=) now writes
`incubator.lastHandStart`; every run stamps `finishedAt`; the check reads it. The line clears with tonight's screen.

## 177. The structural audit's first three corrections: a t-statistic at the gate, an evidence floor on the mirror, a turnover floor for the fleet (23 October 2026)

`docs/STRUCTURAL-AUDIT-2026-10-22.md`. The incubator's selection threshold sat below the noise floor of what it
measured: at 30 trades the standard error of a mean R is ±0.15–0.20R, and the gate asked for +0.1R. Cells promoted
on that carried +0.144R/trade in shadow and did +0.070R in the account, while the shadow book on the same cells over
the same period did −0.028R. Three rules, each measured on the account's own journal before it was written:

- **Gate `minT` (default 2).** A pair's mean R must stand `minT` standard errors above zero. The t-statistic is on
  `PairStats`, shown with the gate's other reasons. Cells that reached the fleet with t < 1 did −$18 after; the eight
  with 1 ≤ t < 2 did +$85. Few cells will pass at n = 30; a pair earns its slot at 60–100 trades instead.
- **Mirror floor `mirror.minTrades` 5, `minNetR` 0.** The account was copying a pair from the day it entered shadow
  (decision 116), before any record. Those entries were 282 of 385 bot trades and lost $416; entries on pairs with
  five or more shadow closes and a positive net R were 64 trades and made $427 (21 of 31 cells positive). Stronger
  floors only shrank the sample. Exits always go through, and a promoted (live) cell is not held. Held entries are
  counted (`mirrorHeld`) and logged at debug.
- **Turnover floors.** `gate.minTurnoverUsd` (default $5M): no proposal for the fleet on a market under it.
  `mirror.minTurnoverUsd` (default $2M): no copy there either. Ten of the fourteen live markets were under $2M a
  day; the 20× tier's $3,000 is 1–3% of a day's volume on five of them, against a paper fill of 2 bps. The market
  gate's own floor and the screening universe are untouched, so the shadow book keeps collecting evidence there.
  The book-cost probe should run at the strong tier's notional (`probeNotionalUsd` 3,000; a Settings change).

Tested and **not** adopted: a cap on net same-side exposure. Replayed at ±1/±2/±3 positions it removed 106/38/15
trades, and those trades were net positive (±2: +$73) — the clustered same-side entries are the trend-day winners,
and the cap cuts the good days with the bad. The 0.54 correlation of daily P&L with BTC's daily move stands as a
description of what the book is, not something a side count fixes.

## 178. The Vela library's exit models measured: a market-structure stop over the trail is the one that pays (23 October 2026)

The structural audit named the payoff as the arithmetic problem: trail exits average +0.54R against −0.98R stops, a
64.5% break-even hit rate the account runs three points under. The Vela library's Risk & Exits family holds three
trailing-stop models of a different family from the fixed give-back, so they were ported from their Pine (© LuxAlgo,
CC BY-NC-SA 4.0; `paper/luxExits.ts`, `modelTrail` in `paper/logic.ts`, `diagnose` variants `lux-*`) and run on
the trail study's grid: the account's 15 scanners × BTC, ETH, SOL, XRP, ZEC, AKE × 15m/1h/4h, 4,000 bars, the spread
paid, 221 cells, 8,658 trades. The account's ATR stop sets where every stop starts; a model only says how it moves,
either replacing the trail or layered over it (whichever is higher wins). `_research/lux-exits-20261023/`.

| exits | total R | R a trade | halves | cells positive | beats current |
|---|---|---|---|---|---|
| current | +559 | +0.065 | +391 / +168 | 129 of 221 | — |
| Sigmoid ATR (replace / over ours) | −161 / +546 | −0.021 / +0.063 | | 88 / 130 | 79 / 60 |
| Statistical L1 (replace) | −6 | −0.001 | +182 / −187 | 103 | 79 |
| Statistical L2 (replace / over ours) | −4 / +546 | −0.001 / +0.063 | | 99 / 130 | 79 / 17 |
| Market Structure (replace) | +265 | +0.036 | +340 / −74 | 110 | 88 |
| **Market Structure over ours** | **+891** | **+0.102** | **+581 / +310** | **152** | **121** |

Replacing the trail with any library model loses: a chart's trailing stop gives a 0.5R-sized trade back to the
market. Layered over the trail, Sigmoid and Statistical are a wash. The Market Structure stop (pivot 14, CHoCH
reset, increment 100%, the library's defaults, untuned) over the trail: 14 of 15 scanners better (alphamojo-supertrend
−8R of 64), all six markets better, 15m −34R → +40R, 1h +177 → +292, 4h +416 → +560, median cell +0.30R, the top
five cells 21% of the gain. The mechanism is not bigger winners — the win rate is 61.2% → 61.9% and no more trades
reach 1R — it is smaller losers: after a change of character the stop sits under the broken leg's low and follows
the running close, tightening a trade before the trail arms at +0.5R, on exactly the 40% of trades that never get there.

**Not changed yet.** The gain is in-sample on the shadow journal. Next is a forward test on the shadow book: the
structure stop computed live per open shadow position (`paper.structureTrail`), two weeks of record with t > 1 against
the account's exits on the same signals, before the account takes it.

**Built (23 October, later).** `paper.structureTrail` — `{ enabled: true, pivot: 14, incrPct: 100, books: ['shadow'] }`
by default. `MarketStructureTrail` (`paper/luxExits.ts`) tracks one market and timeframe a closed bar at a time, matched
bar for bar against the batch port on a 3,000-bar walk; the app keeps one per market×timeframe, seeded from 600 closed
bars on first use and fed every closed bar after. Each book's engine asks `structureFor(symbol, tf)` on every minute
bar and, when its book is named, layers the level over the trail through `modelTrail` (never lower, break-even once
past the entry, a stop in profit reads as `trail`). The shadow book runs the forward test from the deploy; the account
is untouched until `books` names it. The Gates page carries the rule under Trade → "Market-structure stop".

**The account too (23 October, 03:50 UTC, the user's call).** `books` defaults to `['account', 'shadow']`: the
forward test on the shadow book is skipped and the paper account takes the structure stop from the same deploy. The
first minutes on the shadow book behaved as the study did (6 of 19 open positions tightened under +0.5R, where only this
stop can act; no errors). Open account positions at the deploy get the current structure level at once, as the shadow
book's did. The comparison that was to come from the forward test now comes from the account's own record: its exits
from this deploy against the 17 days before, same cut as the audit.

**The account missed the first eleven hours.** The first deploy's default (`books: ['shadow']`) had been persisted into
the VM's `config.json`, which `ConfigStore` writes back as the full merged config; the second deploy's new default never
reached it. ZECUSD 1h at 14:00 UTC showed it: the shadow twin's stop moved to +0.11R and closed, the account's stayed at
−1R. Set in `config.json` at 15:05 UTC (backup `config.json.bak-d178-books-…`), service restarted 15:06. A changed
code default is not a rollout once the key exists on the VM; the value goes in the config, or on the Settings page.

## 179. The silent-demotion cap follows the timeframe: 4h cells could never hold a live slot (23 October 2026)

The incubator check showed 0 live cells on 4h against 70 in shadow, and the day's demotions explained it: both ETHUSD
4h cells went "silent: no account trade in 14 days (cap 14)". A 4h market produces about 0.064 trades a day, one every
16 days, so every 4h cell ever promoted was demoted as silent before it could trade — the timeframe the audit measured
as the one with payoff. The shadow stale cap already follows the timeframe (decision 108); the silent cap now does too:
`demote.silentDaysByTf` `{ '1h': 30, '4h': 60 }`, `silentDays` the fallback. The two ETH 4h cells are back in shadow and
must pass the gate again; the operator can promote them by hand from the Incubator page.

## 180. The regime gate's efficiency floor measured: 0.25 buys +0.02R a trade with a third of the total (23 October 2026)

The incubator check showed the regime gate (`risk.regime.minEr` 0.25, Kaufman efficiency over 20 bars) refusing 1,051
of about 1,730 shadow entries a day — 61%, the dominant filter on the book. Decision 147 had proposed 0.1. Measured on
the trail study's grid (15 account scanners × 6 majors × 3 timeframes, 4,000 bars, spread paid, 216 cells):
`_research/er-floor-20261023/`.

| floor | trades | total R | R a trade | halves | cells positive |
|---|---|---|---|---|---|
| none | 8,362 | +514 | +0.061 | +352 / +162 | 125 of 216 |
| 0.10 | 6,715 | +458 | +0.068 | +310 / +148 | 127 |
| 0.15 | 5,920 | +405 | +0.068 | +250 / +155 | 129 |
| 0.20 | 5,137 | +406 | +0.079 | +243 / +163 | 130 |
| **0.25 (current)** | 4,326 | +352 | +0.081 | +201 / +152 | 130 |

The floor raises the average trade and lowers the total at every step: 0.25 drops 48% of the trades and 31% of the
R against no gate, in both halves. By timeframe: 15m is negative under every floor (the gate does not rescue it); 1h is
best at 0.1–0.2 (+172R at 0.1 against +160 ungated and +114 at 0.25); 4h loses total R at every floor (+380 → +262).
The account is not slot-bound (open 0–7 of 8 through the day), so total R is the number that reaches the equity.

**Recommended, not changed:** `risk.regime.minEr` 0.25 → 0.1 (Settings → Gates): +30% total R against the current
floor on the grid, 55% more trades, both halves. The cost is more entries on a chop day, where the daily loss limit
is the backstop; the gate is kept at 0.1 rather than off because 0.1 still beats no gate on 1h and loses least on 4h.

**Set (23 October, 16:35 UTC, the user's call).** `risk.regime.minEr` 0.1 in the VM config (backup
`config.json.bak-d180-miner-…`), service restarted. The journal from here measures it: regime refusals per wave, the
account's entries and stops on the next chop day.

## 181. The strong-record tier sized on a record the gate would call noise: floor 20 trades, leverage 10× (23 October 2026)

The day's stop review: 14 stops for −$240 against 20 trails for +$231 on a flat BTC day. Five stops and −$143 were
one coin, BTWUSD (−11% on the day, a 24% range), four of them `woodie-pivots` 15m shorts sized at $23–39 of risk
against $4–14 elsewhere — the strong-record tier (decision 144) on a shadow record of four to six trades. The journal
since the reset: 90 tier trades, +$274 at 20×, the same trades at 5× +$27; their R a trade (+0.037) is the book's.
The tier is the account's variance, not its edge: it made 20–21 October (+$422) and it made 22 October (−$165).
Capped at 10× the whole comes to +$85 and 22 October to −$120. Set in the VM config (backup
`config.json.bak-d181-tier-…`, restart 16:55 UTC): `marginLeverage.minTrades` 5 → 20, `strong` 20 → 10.

Replayed and left alone: a per-cell daily stop cap of 2 (+$22 on 412 trades) and a per-market cap of 3 (+$161, all
of it four market-days since 16 October — too concentrated to act on).

**Reversed (23 October, 17:00 UTC).** The gain was the phantom fill. Once a model level beyond the price is capped
at the close (a market exit, the only fill such a stop can get), the same grid reads: current exits +549R, Market
Structure over ours **+479R** (−13%), worse in both halves (+348/+131 against +382/+168), 93 cells worse and 66
better, 2 of 15 scanners better, win rate 61.2% → 59.3%; replacing the trail −161R. `_research/lux-exits-20261023/capped/`.
The structure stop is off for both books (`structureTrail.enabled: false` in the VM config, restart 17:00; the code
default is off). What it leaves behind: twelve shadow positions and one account trade booked at phantom prices
between 03:46 and 15:36 UTC (about +10R on the shadow book, concentrated in ZECUSD and ENAUSD 1h, which inflates
those cells' records for the gate a little), and a lesson for every exit study from here: a stop set beyond the
price is a market exit, and the backtest must book it as one.

## 182. Shadow capacity reserved for what the score starves: 4h, and the majors on 4h (23 October 2026)

"Top coins never get signals." Traced: the cost rule (a stop ≥ 6 round trips, 0.71% of price) refuses every 15m
signal on BTC/ETH/BNB/DOGE by arithmetic (BTC's 15m ATR is 0.31%); the screen does find the majors (24 candidates each
in a week) but admission ranks by screen score, which a coin with a 10% daily range wins every time, so BTC held 3 of
800 shadow slots; and the 227 tracked cells on the majors (decision 139) are watch-only. Measured on the trail study's
grid, spread paid: the majors lose on 15m and on 1h (−50.8R over 1,165 trades, both halves) and pay on 4h (+209.9R over
3,819, +0.055R a trade, 36 of 56 cells, 26 in both halves; ETH 4h +0.105); the alts pay more on 4h (+0.223) and the
book holds 70 4h pairs against 358 on 15m. `_research/er-floor-20261023/` (the `spread` rows).

`admit.reserve`: capacity over and above `maxShadow`, each entry filled first from its own matching candidates by
score under the same per-scanner caps, an active pair counting against the first entry it matches. Default
`[{ tfs: ['4h'], markets: [BTC, ETH, SOL, XRP], slots: 80 }, { tfs: ['4h'], slots: 200 }]`. A 4h pair costs a sixteenth
of a 15m pair's runs, so the reserved pool adds about thirteen 15m-equivalents of load, most of it at the 4h closes.
Nothing on 1h or 15m for the majors; the cost rule stays; the gate (t ≥ 2) and the live turnover floor are unchanged.
The nightly screen walks the timeframes in turn, so the 4h reservations fill over the coming nights, not at once.

## 184. The loop review: fourteen gaps closed in the scan loop, the incubator and the pool (24 October 2026)

`docs/SCANNER-LOOP-REVIEW-2026-10-24.md` has the table. The one that was live and biting: pairs running under the
4h reservation (decision 182) counted against `maxShadow`, so with 1,010 pairs in the book the general pool had no free
slot and no 15m/1h candidate could be admitted — a reservation is capacity over the cap, and now counts that way. The
rest: a returning pair's retirement clocks (stale, `maxDays`) run from its demotion while its evidence window stays
(132) and its `minDays` does not restart (171); hand screens keep their own finish marker (`incubator.lastHandRun`);
an operator's demotion carries its own reason; the silent/cost-starved answer falls back to the shadow record when the
mirror is off; the last hunted run is persisted; account positions keep their 1m feed across a restart; no close is
announced from a clock while the feed is down, nor from the websocket before the local clock agrees; a run's config is
compared by value; queue deadlines hold without a ready worker and a worker that never exits is replaced after 30 s;
a dead socket is dropped and reconnected; the incubator treats gate verdicts older than three refreshes as stale; the
memory guard reads anonymous memory. Tests: 381.

**The worker's higher-timeframe cache (found while reconciling two studies).** `fetchOther` cached `request.security`
bars by symbol and timeframe only; a cut window (the repaint check, the screen's holdout) and the full window shared the
entry, so a script using a higher timeframe read whichever window had run first on that worker. The same cell gave 142
trades one day and 157 the next; scripts without a higher timeframe reproduced exactly. Keyed by the window's end bar
now; two runs give the same rows. Every earlier study's events for HTF scripts carried this noise (the variants within a
cell still compare on the same events); the screen's holdout for HTF scripts was not clean. The 4h entry study was re-run
on the fixed tree before being read.

## 185. The 1h/4h studies were measured on the coarse bar; on the full 15m path the 4h entry should be a resting limit (24 October 2026)

**The tool.** `diagnose` kept one candle series per market and timeframe, first come, first served. In a run covering
15m and 1h/4h, the 15m *signal* series (4,000 bars, 42 days) was cached first, and the 1h/4h *exit path*, which asks for
15m bars across 167 or 666 days, got the same 4,000. So 1h and 4h exits were resolved on 15m only for the last 42 days
and on the coarse bar before that — optimistic for a trail that ratchets at the bar's close. Found by reconciling two
runs of one cell: rerun with exits on the 4h bar alone (`NOSUB=1`) it reproduces the old rows to the decimal (ZEC gross
0.465R, ETH spread 0.206R); on the full path, 0.177R and 0.079R. Fixed (series kept at the longest length asked for).
**Affected:** the 1h and 4h numbers in decisions 175 (trail width), 178 (the Vela exits, already reversed), 180 (the
regime floor), 182 (the majors' 4h evidence) and the 4h ICT results. **Not affected:** every 15m number, every journal
and live-shadow figure (the shadow book's own 4h record, PF 1.43 on 326 trades, is the live engine's 1m path), and the
4h-only runs. The 1h/4h evidence is being re-run on the fixed tool.

**The entry.** On 4h, across the fleet's 15 scanners and six markets, full 15m exit path, spread paid
(`_research/entry-4h-20261024/`):

| entry | trades | total R | halves | cells better / worse than the market entry |
|---|---|---|---|---|
| market at the close (current) | 5,060 | −79.5 | +16.7 / −96.3 | — |
| maker limit at the signal price | 5,040 | +67.7 | +101 / −33 | 69 / 10 · 15 of 15 scanners · 6 of 6 markets |
| **limit 0.3 ATR back, 2 bars** | 4,246 | **+153.5** | **+122.7 / +30.4** | 57 / 29 · 13 of 15 · 6 of 6 |
| hybrid break 0.25 ATR | 2,832 | +88.3 | +42.1 / +47.0 | 55 / 30 |

The round trip's taker fee and half-spread are the difference between a fleet that loses on 4h and one that pays; the
pullback limit is the largest and the only one positive in both halves.

**Built.** `paper.limitEntry` — `{ enabled: true, tfs: ['4h'], atr: 0.3, bars: 2, books: ['account', 'shadow'] }`.
An entry on a named timeframe rests as a limit `atr` ATR of the signal bar back from the signal price for `bars` bars of
its timeframe; it fills at its own price as a maker the first time a minute trades through it (`limitFill: through`;
a touch alone is not a fill, more conservative than the study's touch), with the stop measured from the fill and every
gate asked again at the fill; otherwise it lapses ("no fill: price did not come back"). It survives a restart until it
lapses. The account rests limits only while no exchange executor mirrors it (its entries are market orders, and the
production rule refuses resting orders); reversals keep the market path. 1h joins only if the re-run supports it.

**Corrected the same day, before the deploy.** The `pull0.3` row was not like-for-like: in `diagnose` the bare `pull*`
variants pay no spread (they were written to compare with `base`), so their cost rule asks for a stop of ≈0.71% where the
spread-paid rows ask ≈1.4%, and they took entries the honest rows refuse — at 1h, 1,549 more trades than the market
entry, which no limit can do. The +153.5R is withdrawn. `limit0` (a limit at the signal price) pays the spread on the
exit like `spread` and is the fair comparison. On the fixed tool, fleet's 15 scanners × six markets:

| | market entry (`spread`) | limit at the signal price (`limit0`) | cells better / worse |
|---|---|---|---|
| 1h | +77.5R, 2,509 trades, halves +49.2 / +28.3 | **+133.4R**, 2,477, halves +74.5 / +59.2 | 58 / 25 · 10 of 15 scanners |
| 4h | −71.7R, 4,956, halves +15.9 / −87.8 | **+66.3R**, 4,935, halves +96.2 / −29.7 | 67 / 12 · 15 of 15 scanners |

The default is now `{ tfs: ['1h', '4h'], atr: 0, bars: 2 }`. Pullbacks of 0.1/0.2/0.3 ATR with the spread paid
(`spread+pull*`) are being measured; the offset moves only if one beats `limit0` on the same terms.

**What the fixed re-run says about the earlier decisions (1h/4h, market entry, spread paid).** The trail (175) holds:
giving back 20% loses at both (1h +19.5R vs +77.5R; 4h −159.1R vs −71.7R). The regime floor at 0.1 (180) holds at 1h
(+98.6R vs +77.5R none, +69.4R at 0.25); at 4h every floor is negative under the market entry (0.25 loses least). The
majors' evidence behind the 4h reservation (182) does not hold: majors lose at 1h (−76.9R, −0.063 a trade, both halves)
and at 4h (−137.1R, −0.033, both halves); with the limit entry, 4h majors are flat (−3.0R, halves +50.9 / −53.7). Alts
pay at both (1h +0.119R a trade, 4h +0.082, both halves). The reserved majors pairs are judged by the shadow book like
any other; the mirror floor keeps the account out of them until they have a record.

**The offset, measured fairly (spread paid in every row).** Fleet's 15 scanners × six markets, full 15m exit path
(`_research/entry-fair-20261024/`):

| | market | limit at the signal price | 0.1 ATR back | 0.2 ATR back | 0.3 ATR back |
|---|---|---|---|---|---|
| 1h | +88.7R | +145.2R | **+185.5R** (halves +102.7 / +82.3) | +163.1R | +170.4R |
| 4h | −73.9R | **+70.9R** (halves +99.1 / −28.0) | +64.7R | +92.8R (halves +90.7 / +2.2) | +62.9R |

Against the limit at the signal price, cell by cell: at 1h, 0.1 ATR back is better in 50 cells and worse in 30 (11 of
15 scanners); 0.2 and 0.3 lose breadth. At 4h nothing beats the signal price on breadth (0.1: 39 better / 44 worse;
0.2: 46 / 36 but 9 of 15 scanners and a second half of +2.2R; 0.3: 40 / 44). `limitEntry.atrByTf` `{ '1h': 0.1 }`;
4h stays at the signal price.

## 186. The gaps closed on 24 October: the screen's coarse exits, re-judging what it admitted, reversals, blockers, a patch, the shape edge, payoff on the page

**The screen resolved 1h and 4h exits mostly on the coarse bar.** One request returns at most 80,000 one-minute bars
(55.6 days): 100% of a 15m screen's 42-day window, 33% of a 1h window (167 days) and 8% of a 4h window (667 days). The
rest was resolved on the signal bar itself, which flatters a trail that ratchets at a bar's close (decision 185's
finding in `diagnose`, here in the screen that admits candidates). `cli/incubate.ts` now resolves the part of the
window before the 1m history on 15m bars. **Re-judging:** a shadow pair re-screened after its admission whose screen no
longer passes is retired with that reason ("screen no longer passes"), unless its own record has earned a proposal; the
1h and 4h shadow pairs are re-screened by hand on the corrected screen (their retirements happen in that run's judge).

**Reversal in latency mode.** The held position was closed when the opposite signal was queued; if the new entry was
then cancelled at its fill (levels, cost rule, caps) the book was flat. It is now closed in the same step as the fill,
with the caps, sizing and exposure asked with the held position excluded; a cancelled reversal keeps it.

**Smaller.** The Incubator page's blocker counts know the reservations (decision 182). The `if-array-get-field` patch
leaves `else if` chains alone and names each rewrite apart (`__vnedge_el_0`, `_1`, …). The shape `edge` reading takes the
signal bar's length from every live, shadow, screen, validation, diagnose and repaint caller, so a three-bar live tail
reads a state the way the full-series backtest does. Each pair's stats carry the payoff shape (average winner and
loser in R, the share that reached +1R), shown on the Incubator page as `W/L` and `+1R`.

**Not code.** The 15m weight is a decision the shadow book informs (shadow 15m PF 1.14, 1h 1.04, 4h 1.43 on the 1m
path); the account has no live 4h cells yet, and the reservations and the corrected screen are how it gets them. Exchange
keys, the demo stage, the production rule for resting orders and the Telegram token remain the operator's. The stall
rule is left as it is: trail exits come a median 0–7 minutes after the peak, so 45 minutes rarely pass (0–3% of exits).

## 187. The paper's fills against the tape, and the drawdown sizing out of the warning banner

**Why.** The paper engine fills stops at the stop price plus 2 bps and half the spread, market orders at the last price
with the same costs, and a resting limit as soon as a minute trades through it. None of that has been checked against
what Delta's book actually printed at those moments, and a demo account cannot answer it: its prices are not the real
market's. The real `all_trades` stream is already subscribed for every symbol either book holds.

**What.** `execution/tapeAudit.ts` keeps the last 45 s of prints per symbol and listens to both books' fills:

- a stop (`sl`, `trail`, `be`) is priced at the volume-weighted prints in the 3 s after the first print through the stop
  level (looking back 3 s, since the paper reacts to minute updates), with the worst print kept;
- any other market fill (entries, reversals, script and manual exits) at the volume-weighted prints in the 3 s after it;
- a resting limit, from placement to fill or lapse: the volume traded at its own price before the first print through
  it (the queue a real order at the back would have waited behind), whether price touched and whether it went through.

Rows land in a new `tape_audit` table. Slippage is signed so that positive is worse than paper, in bps and in R of the
trade's original stop. `GET /api/tape-audit?days=N` summarises by book and fill kind; the Exchange page shows it as
"Paper fills against the tape". Take-profit limits are not audited: they fill at their level or not at all.

**Banner.** "Position size scaled to 50% after a 19.9% drawdown" was the `risk.ddScale` rule doing its job, shown as a
warning on every page. It is now a quiet "Size 50%" stat in the top bar with the explanation on hover; the rule itself is
unchanged. The ticker's "markets unavailable" came from a single failed load during a restart that then waited five
minutes; the markets query now retries three times and re-polls every 30 s while it is failing.

## 188. The drawdown size cut is measured from the starting capital

**Why.** On 24 October the account stood near $1,197: 20% below its $1,501 peak and 20% above the $1,000 it started with.
The `ddScale` rule halved every new position because of the drop from the peak. The operator's rule is simpler: cut size
only when the account is below the capital it started with, otherwise trade at full size.

**What.** `risk.ddFrom` chooses the basis: `'capital'` (the new default) reads the loss below `paper.initialEquity`;
`'peak'` keeps the old drawdown from the highest equity. Measured from capital, equity at or above the start always means
full size, and a `ddPct` of 0 means any amount below the start. The default ladder is now `[{ ddPct: 0, leverageMult:
0.5 }]`: half size from the first dollar below $1,000. The risk view carries `sizing { from, drawdownPct, startEquity }`
and the top bar's Size stat explains whichever basis is in force. The VM's persisted `risk.ddScale` is set to match.

## 189. A resting limit cannot fill on the minute it was placed in

**Why.** The tape audit's first resting limits (24 October, 17:01–17:02 UTC): LABUSD and ONDOUSD 1h limits filled on paper
while no trade after their placement went through the limit price. LABUSD's limit was placed at 17:01:32 and filled at
17:02:00 on the 17:01 minute candle. That candle's low may have printed in the 32 seconds before the order existed. The
fill rule accepted any minute that *ended* after placement. The VM runs `paper.fillSource: 'candles'`, so the candle
updates decide every paper fill, on every coin: each limit could fill on its placing minute's earlier low or high. (A first
draft of this entry said only thin coins were affected; that was wrong.)

**What.** The candle fallback now fills a resting limit only on a minute that *began* at or after placement. Fills from the
trade stream are unchanged: each trade carries its own time and is compared with the placement. This matches the backtest
and `diagnose`, which start a limit's life at the signal bar's close. Paper limit fills before this change can't be
counted after the fact (a filled position keeps no placement time); the tape audit records each one from here on.

## 190. The 24 October audit: the paper engine, the tape audit, the fingerprint, the shadow funnel, the journal

**Why.** An outside audit of the code and the journal (24 October) reproduced bugs the suite did not cover. Each was
checked against the code before fixing; each fix has a test that fails on the old code.

**What.**

- **A limit fill keeps the scanner's own rules.** `fillLimit` and `fillPending` resolved the stop and exit policy from the
  global paper settings; placement used the scanner's (`exitConfigFor` with `scannerExit`). A scanner with
  `fallbackAtrSl: 3` filled at 99.4 got a 96.4 stop instead of 93.4. Both now resolve the scanner's and the market's
  settings, as current at the fill, which is how an open position already re-reads them.
- **Expiry is part of the fill.** A lapsed limit could fill on a candle that arrived before the housekeeping tick. The
  candle path now requires the minute to begin inside the order's life; `fillLimit` refuses an event at or after
  `expiresAt` and a print received more than 3 minutes after it happened (`LIMIT_LATE_MS`).
- **A restart keeps a trade's excursion.** `rowToPosition` read `peakR` from the JSON blob and dropped `peak_at`,
  `worst_r`, `worst_at`; the next save wrote them back as NULL. It now reads the columns, and the peak tracker is seeded
  so a restart does not re-stamp an old peak as new.
- **The tape audit sees each print before the books.** The print that filled a tape limit used to reach the audit after
  the fill had closed the limit's record. The engine now announces a limit the moment it is placed (`pending` event,
  `placed`), so a limit placed and filled between two polls is no longer classed as a market entry. A new
  `limit_lifecycle` table records each limit's placement, expiry, first touch, first through, end, outcome and reason as
  they happen; a restart resumes unfinished ones (marked `recovered`, counting restarts). Market-fill windows of a few
  seconds are still held in memory and a restart loses the ones in flight.
- **The fingerprint covers the whole strategy.** It hashed a hand-picked list that left out the limit entry, fees, margin
  sizing, trail steps, stall, structure trail and the drawdown size rule. It now hashes every `paper` and `risk`
  setting, the scanner's settings, the hash of its patched Pine source, the book and `SIM_VERSION` (190: the change in
  fill mechanics from decisions 189 and 190 that no setting shows). Each fingerprint's full settings are stored once in
  `config_fingerprints`. Every trade opened from this deploy on carries a new fingerprint, which is the cutoff between
  the old fill rules and the new.
- **A resting order is pending, not opened.** The shadow and account signal funnels counted `pending` as `opened`, which
  could clear a cost-starved pair or satisfy "opened since demotion" with a limit that later lapsed. `pending` is now its
  own count; a shadow limit is rewritten to `opened` when it fills and `other` when it lapses or is cancelled.
- **The journal filters on the server.** The Trades page fetched the newest 300 and filtered the exit reason in the
  browser, so older matches were missing and the totals covered only the page. `GET /api/trades/page` applies every
  filter first and returns the count and totals of all matches; the page has Newer/Older paging.

## 191. One trading policy for the books, the screen, the scanner backtest and validation

**Why.** The 24 October audit found the paths that judge a scanner trading a different strategy from the books that
trade it. The daily screen admitted 1h and 4h pairs on market entries at the signal close while both books rested a
maker limit (decision 185); it also left out the scanner's own exit rules, its trend gate and the regime's chop gate.
No backtest applied the trail and floor a script-exit trade gets in the books (decision 159). The backtest filled a
resting limit on a touch where the books need price through it (`limitFill: 'through'`), rested a limit on a reversal
where the books enter at market, and closed the held trade before checking that the replacement could be admitted where
the books (decision 77) check first and keep the held trade when the replacement is refused.

**What.** `paper/policy.ts` resolves the policy once: `bookPaperConfig` (the shadow purse and caps), `scannerExitPolicy`
(the scanner's override, script mode, script protection), `entryPolicy` (the limit on its timeframes and books; market
for an exchange-mirrored account) and `backtestPolicy`, which bundles them with the trend and chop gates. The books take
their exit overrides and the shadow settings from it; the screen backtests under the shadow book's policy (the book it
admits to), the scanner backtest and walk-forward validation under the account's. The backtest honours `limitFill`, keeps
a reversal at market under the live policy (`limitWhenFlatOnly`; research variants without it are unchanged), and asks
whether the replacement is admissible before closing the held trade. A resolved override (`scannerExitResolved`) is not
layered with script mode a second time, which would have zeroed the protection. `SIMULATION_VERSION` 5 retires cached
backtests and walk-forward results.

**Consequence.** Decision 185's case for the 1h/4h limit was measured with touch fills, which are kinder than the
books' rule. It is re-measured under `through` before the next change to the entry model.

## 192. The ML calibration is scored on trades it never saw

**Why.** `trainLogReg` fitted the Platt scaling on the holdout's logits and labels, then reported the calibrated Brier
score, log-loss and reliability on that same holdout: a calibration fit, presented as an out-of-sample measurement. A
sample also carried only its entry time, so a trade still open at the split could sit in the training block with an
outcome nobody could have known at that point.

**What.** Three blocks in time: the oldest 80% fit the model, the next 10% fit the calibration, the newest 10% score
both, raw and calibrated. Each sample now records when its outcome became known (`ml_samples.resolved_at`; the exit for
backtest trades, the close for live ones), and a sample still open at a block's boundary is purged from that block's fit
(`walkForward.purged`). The test block is half the old holdout, so its scores are noisier and honest.

## 193. A queued shadow run re-checks its pair, and a stalled run reads every bar back to its watermark

**Why.** The account's engine re-checks a scanner's activation and settings after the worker returns; the shadow runner
did not, so a pair retired, re-staged or re-configured while its run waited could still place or mirror an entry. And
every live and shadow job returned the last three bars of output while the watermark (decision 125) promised to read
every bar after the last one acted on: after a long stall an exit further back had already been dropped by the worker.
The stale-bar branch advanced the watermark without reading the exits at all.

**What.** After the worker returns, the shadow run re-reads its pair from the store and acts only if the pair is still
active, the incubator is on, the scanner's settings and patched source are unchanged — on the pair's current stage,
which decides mirroring (`stats.superseded` counts the dropped runs). `liveWindow` sizes each job's output tail from the
watermark, up to `MAX_CATCHUP_BARS` (48); a gap beyond that is logged as missing history. On the stale-bar branch the
entries are still dropped and the exits since the watermark are now handled before it advances.

## 194. One strategy under several ids, and shadow pairs that trade the same moves

**Why.** The VM library held 14 groups of byte-identical scripts under 30 ids (a TradingView mirror beside the original,
re-imports with suffixes). Each copy was screened and could be admitted on its own, so one strategy's evidence counted
twice. Separately, different scripts can trade the same moves: two Donchian scanners had 20 shadow trades on the same
market, timeframe and side within five seconds of each other.

**What.** `scanners/identity.ts`: a strategy's identity is its patched source plus every setting that changes how it is
read and traded (absent settings count as defaults). Copies are aliases of one canonical id — an enabled scanner first,
then one with incubator pairs, then the shortest id — and the screen runs only the canonical one. Admitted pairs keep
their own ids; nothing is migrated or deleted. `incubator/overlap.ts` clusters shadow pairs whose same-side entries land
within 5 seconds at least 5 times and in half the smaller pair's trades. Both are read-only reports
(`/api/scanners/duplicates`, `/api/incubator/overlap`) and an "Overlapping evidence" panel on the Incubator page; neither
judges or retires a pair.

**Found while checking 190–194 locally.** A stop the paper fills on catching up after a restart (the price crossed it
while the bot was down) was priced against the prints after the restart: 1,476 bps on a local AKEUSD stop that had been
crossed 23 hours earlier. A resting exchange stop would have filled when the price crossed, so those prints say nothing
about its slippage. The tape audit now marks a stop as `unobserved` when the process saw no print for the symbol before
the cross, keeps the row, and leaves it out of the averages (an "Unwatched" column on the Exchange page). And
`/api/scanners/duplicates` is registered before `/api/scanners/:id`, which had taken "duplicates" for a scanner id.

## 195. Scanner contracts: explicit sides, variants, and the shared signal reader

**Why.** A replay of every scanner on 24 October (an outside check, verified against the sources and the code before
any change) found the reader trading some scripts differently from what they draw, and shared parsing that drops or
misreads actions:

- Trend Impulse Channels draws "Lower Retest" as a green up-triangle below the bar in an uptrend (its long) and "Upper
  Retest" as its short. The reader took the words lower/upper for the side and traded both the other way. That reading
  is not a loss — Upper Retest as a long made +26R at PF 1.22 on 1h and +34R at PF 1.38 on 4h in today's grid — but it
  is a breakout-continuation strategy, not the script's.
- Pivot Channel Breaks publishes "Break Up" and "Break Dn"; the reader knew "down" but not "dn", so it only ever went long.
- Structure-Anchored VWAP's derived HL/LH entries (55-bar pivots) never fired live: a flat 40-bar cut-off discarded each
  pivot the moment it was confirmed, while the backtest counted them.
- Three shadow pairs (two of l-l-htf-trend-cloud-strategy-joe-freedom, one of tjr-v4-strategy) sat in "shadow" on
  scripts whose source is not published; the runner skips them, so they never traded.
- Shared reading: a structured packet with a stop and a new entry kept one of them; pretty-printed JSON was not
  recognised; FVG Precision's own schema (event_type ENTRY / TP_HIT / SL_HIT / FVG_BROKEN) was read as information; a
  price printed as `1e-7` became 1 and `78,777.5` lost its fraction; an alert() entry or an excluded condition channel
  silenced an exit condition on the same bar; inversion flipped entries but not exits; the account's live path did
  not pass the bar length the shadow path did; a later entry anywhere in the window erased an earlier label signal;
  generic rules picked their plot from the whole window; a rule that threw was indistinguishable from a quiet bar.

**What.**

- **Contracts.** `scanners.<id>.sides` maps a title (alertcondition, shape or label text) to `long`, `short` or `none`,
  overriding the word and geometry guess. Defaults live in `scripts/specs.json`. The base ids keep the reading their
  record was earned on, now written down: Trend Impulse Channels Upper Retest long / Lower Retest short; Pivot Channel
  Breaks Break Up long / Break Dn none; Structure-Anchored VWAP native alerts only (`sources: alert, shape`).
- **Variants.** `scripts/variants.json` adds a second id over the same source with its own contract:
  `trend-impulse-channels-zeiierman-native` (retests as drawn), `pivot-channel-breaks-two-sided` (both breaks),
  `structure-anchored-vwap-pivots` (confirmed HL/LH only; a variant reads with its base's rule). They start disabled
  and earn their way through the screen and the shadow book like any script; the base ids' evidence is untouched.
- **The reader.** `parseAlertAll` returns every action in a packet, in its order (`parseAlert` keeps returning the
  primary one); JSON is parsed once and routed on its fields; an FVG Precision adapter; numbers are whole tokens with
  thousands groups and exponents; an exit condition is read regardless of entry filters and bar ownership; inversion
  turns exits over too (their price dropped, as the stop and targets are); labels are read by what the source declares
  (`declaredChannels`) or when `sources` names `label`, never by what else appears in the window. The four shadow
  scanners whose forward record includes label entries (woodie-pivots, smart-money-engine,
  ema200-regime-bos-choch-2x-fvg-strategy, re-accumulation) name `label` in their specs so they keep trading them.
- **One reading for every path.** `scanners/reading.ts` returns a scanner's full reading — channels, edge, allow-list,
  inversion, contract, declared channels, bar length, rule inputs, pin, base rule — for the account (live and
  backtest), the shadow book, the screen, validation, the repaint check, diagnose and profiles.
- **Rules.** The VWAP pivot rule's live cut-off counts from the confirmation (delay + 5 bars) and its delay follows
  the script's `pivRInput`; a failing rule is logged and counted (`ruleErrors`); a generic trailing or oscillator rule
  will not trade live without `scanners.<id>.rulePin`.
- **Library.** The nightly judge retires a shadow, proposed or tracked pair whose scanner cannot run, with the
  library's reason (actor `library`).

## 196. The dashboard audit: thresholds per timeframe, the system history, pair identity, the phone Daily page, two labels

**Why.** A read-only review of the deployed dashboard (24 October), each finding checked against the source first.

**What.**

- **Incubator progress uses the gate the judge uses.** The page applied `gate.minTrades`/`minDays` to every
  timeframe; the judge applies `minTradesByTf`/`minDaysByTf` (`gateFor`). A 4h pair showed a 14-day bar while its gate
  needed 45, so its countdown read "now" weeks early. Progress, countdown, evidence and the explanatory text (Incubator
  and Decisions) now use the timeframe's minimums, and list them. The shadow table follows the gate's pooling: one row
  per pair in `pair` mode (the VM's), cohorts with their markets in `cohort` mode.
- **The system history loads.** The client asked for `/api/api/ops/metrics/history`; the Overview panel defaulted the
  failure to an empty list and said "No samples yet". The path is fixed and a failed request shows an error with Retry.
- **A live pair names its timeframe** in the account table and in the confirmation titles, so "To shadow" says which
  scanner, market and timeframe it moves.
- **Daily on a phone.** The card layout kept the table's desktop width, so the values sat off-screen in a sideways
  scroll. The table and its body take the container's width and long names wrap; checked at 375 px and at 130% text.
- **Labels.** Daily's "Equity" is the realized balance (starting capital plus closed trades), now named so; the top
  bar's equity also counts open positions. The sizing comparison was fixed to a 20 October trial whose decision is
  made (margin sizing is on); it is now the last 14 days' margin re-weighting, described as a counterfactual on closed
  trades, with the sizing mode in force beside it.

## 197. A per-timeframe exit layer, and the early profit lock measured daily while it stays off

**Why.** An outside study (25 October) proposed raising the stop to +0.1R once a trade reaches +0.3R. On 101 later
account trades it cut the loss from −12.7R to −1.9R. Replayed on both books' recorded paths since 1 September (about
4,400 trades), it helps on 15m (account +9.3R, shadow +7.3R with each hypothetical exit paying its own taker fee and
slippage) and hurts on 1h and 4h (shadow −9.5R and −38.9R: slower trades often dip to +0.1R and go on to their
targets). The operator's decision: build the option per timeframe, keep it off, and collect two more weeks before
switching it on for 15m; 1h and 4h stay as they are.

**What.**

- `paper.exitByTf` — exit overrides per timeframe, layered fleet < timeframe < market < scanner (`exitConfigFor` takes
  the trade's timeframe in every path: entry, limit and latency fills, trades, bars, script exits, the backtest).
  Empty by default; validated (known timeframe, `floorKeepR` not above `floorAtR`). Switching the lock on for 15m is
  `exitByTf: { "15m": { floorAtR: 0.3, floorKeepR: 0.1 } }`.
- `analytics/lockStudy.ts` and `GET /api/research/lock?days=N` (cached ten minutes): every closed trade in both books,
  unchanged unless its path reached `atR` and later fell to `keepR`; then the size still open is closed at the lock
  level as a stop-market order with the paper's taker slippage and fee, while the entry and any earlier partial exits
  keep their recorded prices and fees. Reported by book and timeframe: trades, fires, losses rescued, winners cut
  short, R now and with the lock, the change, and path coverage; by closing day; with its assumptions spelled out.
  The Daily page shows it as "Early profit lock — off".
- The stop-width filter from the same study is not part of this; it is a separate entry-admission experiment.

**Limits.** Paths are sampled about once a minute: a touch between samples is missed and a fire can be late. The
spread at the lock is unknown and not added; funding is ignored on both sides. Coverage (paths with no gap over three
minutes) is high in the account (271 of 276 on 15m) and lower in the shadow book (1,430 of 1,878 on 15m).

## 198. Re-screening the shadow book itself

**Why.** The overnight 1h/4h re-screen under the corrected policy (decision 191) ran 10,742 backtests and re-judged
three of the 725 shadow pairs it was meant to re-judge. The screen skips every market where a scanner already has a
shadow, proposed, live or tracked pair, so it screened those scanners' other markets — 196 new candidates — and the
decision-186 rule (a shadow pair whose re-screen no longer passes is retired) had nothing to act on. The rule also
cleared out the three pairs on scripts that are not in the library (decision 195).

**What.** `RESCREEN_SHADOW=1` makes a screen run re-screen only the pairs already in the shadow book or proposed, on
their own markets, without the silent-script shortcut; `DRY=1` records nothing, skips the judge, and prints each
pair's verdict (and writes them to `OUT` when set), so the retirements can be read before a real run makes them.

## 199. The shadow book is for experiments; the account trades only proven pairs

**Why.** From 22 to 25 October the account lost 22.1R. Copied shadow pairs — the decision-116 mirror, which offered a
shadow pair's entries to the account once it had 5 closed trades with a positive total — made 159 of the 172 trades
and lost 21.1R (−$254); the live pairs lost 1.0R (+$18). Over the eleven days from 15 October the mirror took 85% of
the account's trades and netted −14.1R; the live pairs made +2.2R. The operator's rule: the shadow book is where every
experiment runs and the data is collected; the account trades scanners that have proven themselves.

**What.** `incubator.mirror.enabled` is false on the VM (25 October, 13:14 UTC; the previous config is kept as
`config.json.bak-mirror-off-*`). The account trades the 14 enabled scanners on their 21 live pairs; shadow pairs reach
it only through the promotion gate. Positions already open from mirrored pairs run to their own exits.

## 200. A failed re-screen retires a shadow pair only when its own record agrees

**Why.** The dry re-screen of the 1h/4h shadow book (decision 198, 25 October) failed 519 of 617 pairs. Most of that
is selection: the pairs were admitted for looking best under the old, looser screen, and a stricter re-test drops
many of them whatever their worth. On 1h the limit entries found about 58% of the admission trade count (92 pairs under
the 20-trade minimum); on 4h, 170 pairs fell under PF 1.2. Against the forward record: 35 failing pairs were up 83.8R
in the shadow book, 40 were down 44.9R, and 444 had fewer than three shadow trades.

**What.** The decision-186 rule retires a re-screened, failing shadow pair only when it has at least three shadow trades
since admission (`RESCREEN_RETIRE_MIN_TRADES`) and their total is zero R or less. A failing pair that is winning keeps
trading; one with too little record keeps collecting it, and the stale cap retires it if it falls silent (30 days on 1h,
60 on 4h). The shadow book is where the experiments run (decision 199), so a backtest alone does not end one.

## 201. Exits for held positions, the account's runs protected, run history, clean audit, screen provenance

**Why.** An outside audit of the degradation (25 October) found, and the code confirmed:
- switching copying off (decision 199) also cut the scanner exits of the account positions copying had opened (the same
  `mirror.enabled` test wrapped entries and exits; #4968 woodie-pivots BTWUSD 15m and #5002 swing-traces SOLUSD 4h);
- the pool's memory guard retired every busy worker at once, so shadow load cost the account its own bar-close scans
  (46 "memory-shared" aborts in one log, live cells among them), and with copying off no shadow scan of a held pair had
  priority over the queue-depth drop;
- `scanner_runs` keeps one row per cell, so a recovered cell hid its earlier failures;
- funding was audited against the tape as a "market exit";
- live pairs' screens carry no record of the source, reading or policy they measured;
- the drawdown alert, measured from the peak, read as if it de-risked the account, while sizing follows the capital rule.

**What.**
- An exit raised by a shadow pair reaches the account whenever the account holds that scanner, market and timeframe,
  copying on or off (`accountHolds`); entries are never copied while copying is off. Pairs holding a position in either
  book are scanned in the mirror tier and are never dropped under backpressure.
- The memory guard retires the least urgent tier first (background, then mirror, then the account's live runs).
  Background shadow scans are skipped while the process is above 85% of the guard (`stats.memorySkipped`).
- `scanner_run_log` keeps every account run as ok, failed or skipped for 14 days; `/api/scanners/run-health` and an
  Overview panel show each cell's failures and skips.
- Funding is not audited; earlier funding rows are left out of the summary.
- Screens carry `provenance` (source hash, reading hash, simulation version, policy hash). A live pair whose screen has
  none shows a "legacy screen" pill. `RESCREEN_STAGES=live` with `DRY=1` revalidates live pairs under today's policy
  without touching their original screen (a non-dry live re-screen is refused).
- Each scanner page shows its reading contract and the id it is a variant of.
- The drawdown alert says it is an alert only and names what does cut size (the drawdown rule, from the capital).

## 202. The screen charged the fees twice

**Why.** The dry revalidation of the live pairs (decision 201) failed all 18 it re-tested, two of them with zero trades
on BTCUSD 1h — scanners that signal there live (ai-predictive-flow and structure-anchored-vwap, five entries each since
early October). `diagnose` showed ai-predictive-flow BTCUSD 1h at 27 trades and +6.4R without the market's cost and zero
trades with it. The market gate's `bookCostPct` is the book crossing *plus* the fee round trip (BTCUSD 0.1186% =
0.118% fees + 0.0006% spread); the screen handed it to the backtest as `spreadPct`, and the backtest charged the fees
again — in the cost rule (a stop had to clear six times twice the fees: ~1.4% on BTCUSD, wider than a 1h stop) and in
every fill.

**What.** `crossingPct` (risk/marketGate.ts) takes the fees back out; the screen, `diagnose` and `conjunction` hand the
backtest the crossing only. The "too quiet" check keeps the whole book cost, which is what it means there.

**Consequences.** Every screen since 17 October (decision 109) and every `diagnose` variant that paid the market's cost
since 14 October understated trades and R, most of all on liquid markets with tight stops. Admissions since then were
stricter than intended; the decision-191 comparisons of market and limit entries paid the same doubled cost on both
sides, so their ordering stands but their absolute R does not. The 40 shadow pairs retired on 25 October (decision 200)
were retired because their own shadow records were flat or losing as well, which stands on its own. The live
revalidation and the shadow re-screen are re-run on the corrected screen.

## 203. Research capacity and account-plan parity (31 October 2026)

Capacity is additive: the deployed 800 general slots plus 80 reserved 4h-major slots and
200 further 4h slots allow 1,080 allocations. Admission and blocker explanations now share
one deterministic allocation plan, including reservation precedence over per-scanner caps.
The UI shows general/reserved usage and genuine overflow separately.

An optional bounded rotation exchanges idle, never-filled shadow cells for eligible waiting
candidates. The deployment uses at most 12 swaps per UTC day, after 7/14/28 observation days
on 15m/1h/4h, with a three-day candidate cooldown. Successful recent scan watermarks are
required; downtime is not silence. Filled evidence, open positions and pending orders are
protected. A swap, both audit events and its quota are atomic. Rotation is not a losing
verdict; history remains, while a later readmission starts a new observation clock. Open
and pending positions also defer automatic retirement. Quarantine prevents new admission.

Account backtests previously accepted native/mixed stops even when paper execution refused
them. The shared policy now carries `requireAtrStop` through ordinary and walk-forward
replays, including reversal admission; shadow still measures native plans. Simulation
version 8 invalidates cached results. Margin sizing and account risk/exit rules are unchanged.

The paired LTM study used 778 entry signals in 11 cells from 1 September to 31 October,
200 warm-up bars and a 70/30 temporal split. Native, ATR and trailing-structure plans share
signal events and account costs/sizing. Experiments use level exits, never retained native
TP alerts against replacement stops. Prefix checks compared the full entry plan, including
SL/TP; minute coverage was 99.99–100%. ETH 15m native levels returned +$29.82 over 12 holdout
closes (+$23.42 with 5bp extra slippage), versus -$17.54 for ATR. AIOT/ONDO failed to generalize.
No experiment met the predeclared 20-close holdout and robustness requirements; no account
plan exception is enabled. Historical funding/depth and portfolio interactions are not
reconstructed. `server/src/cli/planstudy.ts` reproduces the study using an explicit sanitized
snapshot, local candle cache and output path; it never writes to the bot database/config.

**Full-fee sensitivity.** The initial figures above used the deployed legacy scalper-waiver
configuration, which has no verified enrollment date. Repeating the identical study with
that waiver disabled gives ETH 15m native levels +$27.21 over the same 12 holdout closes,
+$21.24 with extra slippage, versus -$18.85 for ATR. No variant qualifies under the predeclared
criteria. These conservative figures supersede the initial comparison for recommendations;
the VM's fee configuration itself was not changed. Code deployed at dacc93d, with 12/12
rotation swaps verified and no protected position/evidence violations.

## 204. Versioned execution plans and conservative fee eligibility (31 October 2026)

A configured Scalper Offer without an enrollment timestamp no longer waives closing fees.
Delta's published eligibility requires consent before entry; configuration alone is not
that evidence. Existing booked fills remain unchanged. New fills retain maker/taker and
waiver attribution. Admission still budgets full commissions, with the existing 6x floor.
See https://www.delta.exchange/support/solutions?articleId=80001172745 .

`executionPlans` is an explicit, validated research registry: source scanner, pair, timeframe,
revision and current/native/ATR variant. These plans can only enter book 2; they cannot
enter the account or become promotion evidence for their source scanner. A source scan
feeds experiments whose results are excluded from ordinary shadow performance, daily totals
and the ML yardstick, preventing correlated plan variants from inflating those reports. It
fans out into all configured plans on the same observed event, with persisted event
uniqueness. Configured sources remain scheduled even without an ordinary incubator slot.
Disabling a plan stops new orders and cancels pending fills; held positions retain their
entry-time exit policy and source-exit subscription. Source, reading and resolved policy
hashes identify cohorts, and older cohorts remain visible. Existing orders/positions block
a new version of that same plan from overlapping them.

Comparison plans use $150 target margin, fixed base leverage and a $1,000 reference purse,
including the unchanged 3% stop-risk cap, lot rounding, fee floor, current entry model,
source trend/regime/market checks and live quote/depth checks at the actual sized quantity.
They pay full fees. Portfolio-state limits and adaptive leverage are deliberately excluded
from these independent cell experiments; their sum is not an account return. Native/ATR
experiments use level exits, without native script TP notifications against replaced levels.
The regular account and ordinary shadow allocations keep their existing sizing policies.
A full saved plan follows pending orders into fills and survives restart; backtests consume
the same resolver/adapters. The optional maximum hold requires minute history in replay.

The Incubator shows configured plans even before the first signal, source scan timestamps,
cohort identity, signals/placements/fills/closes, pending/open positions, net results, fees,
realized drawdown and decision reasons. The Signals diagnostic panel shows initial break-even
excluding future funding/impact, estimated versus paid exit fees, recorded funding and price
shortfall only where an execution reference exists. Shortfall is already in P&L. Historical
rows without the new metadata say unknown rather than inventing maker status or break-even.
Trend refusals previously skipped the shadow funnel entirely; they are now recorded.

The shared-registry replay tested 293 LTM entries on ETH/BTC/SOL 15m, 1 September–31 October,
with warmed indicators, a 70/30 temporal split, full fees, 0/5bp additional market-leg slippage,
100% minute coverage and zero changed prefix plans. Across 36 runs, ETH native had 14 holdout
closes, +$23.75 base and +$16.36 stressed; development was +$5.24 base and -$19.03 stressed.
BTC native had only five holdout closes. SOL native failed the cost stress. None qualifies;
the development stress is now also part of the study's qualification test. Nine prospective
shadow comparisons are the deployment target, not nine account promotions. Historical depth,
queue priority and exact funding still limit the replay. `REGISTRY=1 TFS=15m` in `planstudy.ts`
reproduces this resolver-based study using explicit sanitized snapshot/cache/output paths.

## 205. Scanner-specific targets with explicit trailing coordination (31 October 2026)

Targets are now a versioned part of a research execution plan: native price levels with an
explicit contract split, or an increasing R ladder with its own split. An optional trail
activation is recorded separately, so a TP-only experiment cannot silently change its trail.
The original stop, sizing, fee floor and protective floor remain resolved from the same
policy. Experiments use level exits; native TP notifications cannot close a replacement
target plan. Held positions and pending fills retain their complete snapshot. The Incubator
shows scanner names, stop policy, target ladder/allocation and trail activation, including
configured plans before their first signal. Scanner exit overrides now explicitly support
`scriptTargets`; target modes, splits and ladders are validated across supported scopes.

The journal contained 6,346 closed account/shadow trades since 1 September. Only two of the
627 account closes were target exits, versus 376 trail exits. Reach statistics end at the
actual exit and are descriptive, not a replay of later recovery. Native targets already
exist for some scanners: the 2/4/6R fallback is not a universal replacement of every script.
Smart Money Breakout's chart targets are not numeric entry alerts, so its native-level
comparison falls back to the engine's levels; chart target-hit statistics are not bot P&L.

The study covered LTM, Structure-Anchored VWAP, Trend Impulse Channels and Smart Money
Breakout on BTC/ETH/SOL, at 15m/1h/4h, with 200 warm-up bars and 1 September–31 October data.
720 paired runs tested native allocations, 0.75R and 1.5R full exits, and 1/2/4R partials,
holding trailing unchanged. Most differences were small because the 0.5R trail closed
before targets acted. A further 432 exploratory runs tested 0.75R full exits/trailing and
1/2/4R partials/trailing from 1R. This second hypothesis followed inspection of the first
study; its later segment is not an untouched validation set. Both use the production plan
resolver, full fees, base leverage, a fixed $1,000 reference purse, conservative minute
fills and 0/5bp additional market-leg slippage. All runs completed without errors. Results
are isolated cell comparisons, not portfolio returns; live regime/market/depth admission,
historical funding and queue position are not completely reconstructed.

Trend Impulse Channels 4h is the prospective candidate: 50% at 1R, 25% at 2R, 25% at 4R,
trailing from 1R, preserving the 0.5R/0.25R floor. Across three majors, stressed development
net rose from $27.74 to $41.71. Later base net rose from $28.28 (19 closes) to $34.48
(18 closes), stressed net from $21.03 to $29.24. BTC improved but remained negative;
ETH and SOL later results weakened. This is a small, mixed sample, not proof of an edge.
Six paired forward plans (baseline/candidate on each major) are added for observation only.
Keep the existing nine LTM plans; no account exit override or promotion is authorized by
these results. LTM and VWAP did not show a consistent improvement from the new ladder.
The $150 target margin, 3% stop-risk cap and 6x cost floor remain unchanged.


## 206. Shared workflow ownership, immutable reporting scope and duplicate delivery (31 October 2026)

The architecture audit found real overlap behind the eight research/control surfaces. On the
VM, seven trackers shared 43 cells. Tracker removal/narrowing previously released a tracked
cell based on a single note owner even if another list still subscribed. Membership and
stage changes now use one transaction (nested store moves use savepoints); remaining owners
retain the cell and its evidence clock. Duplicate dimensions are normalized, and tracker
statistics use grouped queries rather than two journal queries per cell.

Incubator remains the automated allocator when enabled. Both Auto-tune APIs become advisory
in that mode and scheduled tuning is skipped. Legacy explicit-pair tuning also stops
retaining failed cells through a Cartesian product of passing symbols and timeframes.
The UI calls this Review backtests and distinguishes recommendations from applied changes.
Manual operator allocation controls remain explicit and available.

The old validation ungated/ml-gated ledger used an independent fill path despite current
execution plans. Archive it without deleting snapshots; leave current ML scoring/training
intact. Move validation composition from HTTP registration into App, including an owned
stop/unsubscribe path. Opening another API server cannot wire another trading ledger.

Account ingress now deduplicates the original source event and the historical mirror-label
form before acting. Both producer orderings and partial exits are tested. The 14-day VM
audit found no matching duplicate source events: this fixes a latent correctness fault,
not evidence that duplicate trading caused recent losses.

Radar counts only filled open/closed ordinary positions. Daily and Performance now share a
frozen evidence-scope predicate. Scope is recorded when the order receives its cell identity;
watch-only/experimental orders never become ordinary historical evidence after promotion.
Old rows retain the migration-time classification as legacy-shadow/legacy-tracker because
actual entry-time membership cannot be reconstructed reliably. UI copy states this limit.

A shared expandable module guide explains ownership and cohort differences. Decisions remains
an Incubator action view; Trackers remain subscriptions, not separate balances. Three retired
tracker members on the VM had explicit screen retirements and negative forward evidence;
this change does not automatically reactivate them. No margin, fee floor, risk cap or account
TP policy changes accompany this hardening.

Validation: 693 server tests pass, including tracker ownership/rollback, direct/copied entry
and partial-exit identity, advisory tuning, exact-cell retention, scope stability across
stage changes/restarts and validation wiring without HTTP. Dashboard lint/build and server
TypeScript checks pass. Remaining durable event recovery, evidence-version fingerprints,
research CPU isolation, scheduler consolidation and full lifecycle work are recorded in
ARCHITECTURE.md; this change does not claim those are complete.

## 207. Durable account signal decisions and bounded paper recovery (31 October 2026)

Account ingress previously wrote a signal, changed paper orders/positions, then updated the
signal action in separate commits. A crash after the first write could strand an unprocessed
signal that duplicate detection would skip; retrying blindly could repeat a partial exit.
The VM's read-only audit found no entry/exit rows with action `none` in the last 14 days.
This is preventive correctness work, not a claim that this fault explains recent losses.

Persist a source-event receipt before asynchronous depth preparation. Its stable identity
ignores the copied transport label. Commit paper mutations, pilot accounting, the signal
outcome and receipt completion together. SQLite rollback also restores in-memory positions,
pending orders, equity caches and admission risk state. Observers and successful fill logs
run after commit. A nested fill-write failure must propagate and leave the receipt pending.
Clear the large context payload after completion; keep the small event identity and outcome.

Recover pending decisions on startup and every five seconds, prioritizing exits. Recovery is
paper-only: other execution modes pause for reconciliation. Entries have a maximum 60-second
receipt lifetime and must retain the same source, policy and account reset generation. Current
admission still applies and recovery waits for a fresh quote/ticker; an old signal price cannot
price a recovered market fill. Exits bind to the original position and reclaim-order IDs, so
they cannot close a replacement trade. The existing market/tape pending cancel-on-restart
policy remains; committed resting maker orders reload without being placed twice. Legacy
pre-receipt signals are preserved without automatic replay.

Signals now shows pending decision count, age, attempts and retry errors. The Decisions
attention list flags failed or aging receipts through the same health data. Scanner shutdown
stops new intake and the recovery timer before worker shutdown. Incubator-enabled scheduled
auto-tune is skipped as well as the allocation write, avoiding redundant backtest scheduling.

Twenty tests cover seven actual SIGKILL/restart boundaries, committed maker reload, partial
exit and reversal rollback, a nested SQL failure, risk rollback, duplicate-safe retry, account
reset, non-paper pause, changed source/policy and fresh-price waits. Post-commit learning,
risk close bookkeeping, alert and exchange-command callbacks still need durable journal cursors;
the shadow scheduler also remains outside this inbox. This is not an exactly-once exchange
execution claim. The $150 target margin, 3% stop-risk cap, 6x cost floor and all 15 prospective
execution-plan comparisons remain unchanged.

Validation: all 713 server tests pass; dashboard lint/build and server TypeScript checks pass.

## 208 — Delta L1 quotes and conservative exchange recovery (2026-10-31)

Execution now subscribes to compact `ob_l1` for scanned, held and pending markets
in both books. Quotes retain publication time, last book-change time, sizes and
source. Healthy L1 outranks ticker fallback. Disconnects clear executable quotes;
a silent L1 subscription is repaired independently of heartbeats. Demo public
channel mapping is explicit and socket stop/restart cancels pending reconnects.
Exchange → Execution quality reports L1/fallback/stale coverage, per-market age
and size, and the configured candle/tape fill mode.

Order-ledger reads and writes are scoped to the transport host; legacy unknown-host
rows are not adopted automatically. Recovery includes pre-acknowledgement intent
and aggregates all filled exposure rather than the last 5,000 display rows.
Server/malformed acknowledgements and empty lookups remain uncertain. Native
protection with an uncertain submission is looked up before any replacement;
failed open-order snapshots defer recovery. Client IDs fit 32 characters and keep
their semantic reason in the ledger. Listener cleanup prevents restart duplication.
Open partial orders stay unsettled. A level exit confirms cancellation and any
partial quantity before sending a market remainder; failed cancellation does not
justify another exit.

`compareExecution` replays supplied receipt-ordered signals and market observations
through the real candle and tape engines in isolated memory databases. It preserves
exchange event timestamps and reports fills, fees, open/pending counts and realized
net without forcing remaining positions closed. It does not regenerate scanner
signals, model queue priority, replay the portfolio admission layer or establish
strategy profitability.

Validation adds fault-injected transport/reconnect tests and three actual SIGKILL
boundaries: durable intent, exchange acceptance before acknowledgement, and saved
acknowledgement. A public-only 25-second probe of the new feed received 241 BTC and
242 ETH L1 messages, with fresh quote ages of 77ms and 12ms at its final snapshot.

This build does not enable live execution, native production stop/limit permissions,
the scalper waiver, or tape mode. $150 margin and existing risk/economics settings
are unchanged. Host isolation is not account-identity isolation: changing exchange
accounts within the same host still requires explicit reconciliation. The durable
paper-to-exchange command outbox, private-stream reconciliation, partial-fill cash
accounting and production-native protection remain separate work before live use.

Validation: 741 server tests pass (28 added), including three new SIGKILL tests;
3 dashboard tests and 4 component-render checks pass. Server TypeScript,
dashboard build/lint and whitespace checks pass. No orders were sent by the
public-feed probe. This entry records a tested local build, not a VM deployment.

## 209. Durable handoff from account fills to exchange execution (31 October 2026)

The paper book committed fills before its order event entered the executor's
in-memory queue. A crash between those steps produced an account position without
an exchange intent. Ledger recovery could only report it as unmirrored.

With an executor attached, the new execution_commands row and the account fill
commit together. The event wakes the dispatcher; startup and sweeps recover the
same durable command. Client IDs are allocated at capture, fit Delta's 32-character
limit, and are retained across recovery. A ledger intent means a POST may have
happened: it is looked up, never blindly submitted again, even when lookup is null.
This intentionally does not promise exactly-once execution across the exchange.

Only commands with no ledger intent may dispatch after recovery. Unsent entries
expire after 60 seconds by default (execution.entryCommandMaxAgeSec, 1–300), are
rechecked after the leverage await, and cannot reopen a closed/flattened trade.
Exits retain their intent and reduce only the difference between confirmed exchange
exposure and the paper remainder. Product metadata outages retain work for retry.
Uncertain outcomes serialize follow-up exits on that position. A recovered TP
already booked on paper is restated instead of subtracting its contracts again.

New dry-run ledger and command rows use a distinct host scope. The feature creates
no exchange commands in paper mode, imports no historical paper fills, and leaves
shadow execution and sizing unchanged. Source row identity remains inspectable
when a rejected entry is voided. The Exchange page shows waiting, cancelled,
rejected and reconciled/ledger-owned commands; waiting work older than a minute
appears in attention. Handoff completion is explicitly not a fill confirmation.

Tests: 763 server tests passed (22 added), including eight new real SIGKILL cases;
three dashboard tests, five handoff component render assertions, server type check,
dashboard lint and production build passed. The full suite includes the existing
partial-fill, rejection, protection, recovery and host-policy tests. Native live
protection, account identity scoping, private fill streams and complete partial-fill
cash accounting remain separate work; the deployment stays in paper mode.

## 210. Account for split exchange fills by journal identity (31 October 2026)

The executor restated an entire paper exit from the first terminal partial order.
Its residual retry had a different reason (`stranded` or `sl-rest`), so that retry's
price and commission never reached the original journal fill. An 80-contract
take-profit partly executed at market could also leave a residual indefinitely
while the paper position remained open. Disabling brackets disabled immediate
residual recovery as well.

Each mirrored journal fill now has an accounting record. Exchange orders carry
its durable source order ID; retries and replacement exits retain that identity.
The journal uses the quantity-weighted average price and the sum of each order's
cumulative paid commission, once. It only replaces the complete paper fill when
the quantities match, contributing orders are terminal, and price and commission
are available. Missing commission is not treated as zero. Oversized totals remain
unconfirmed. The accounting row and journal cash update commit together; failure
restores the in-memory position too. Late entry prices recalculate closed trading
P&L and initial risk, preserving separate funding cashflows.

Open partial quantities are persisted and included in exposure recovery. Lookups
validate order identity, quantity, price and commission; a regressing quantity
cannot erase an observed fill. Repeated snapshots cannot subtract exposure twice.
Missing cash fields are refreshed in bounded batches. A still-open partial order
remains unsettled. Cash records remain scoped to the executor's environment,
including a separate dry-run scope. Existing explicitly mirrored outbox commands
can gain accounting records on upgrade; historical paper trades are not imported.
Native stop/TP fills record a pending-adoption marker before journal adoption.
Recovery can resume those fills without replaying historical unlinked terminal rows.

Residual exits now run with brackets on or off. A partially filled TP on an open
position retries only its attributable remaining quantity, after checking for
unresolved submissions. Resting stop edits use confirmed exposure, including an
exit remainder, rather than the paper quantity alone. An already triggered partial
stop is allowed to settle through confirmation/cancellation; its total size is not
edited as though it were remaining size.

Exchange shows quantity coverage, weighted price, commission and accounting state.
Journal rows and filtered totals explicitly identify incomplete accounting as
provisional, including on mobile. Pure paper fills retain their existing economics.
The $150 margin, stop-risk cap, leverage policy and fee gate are unchanged.

Validation includes split long/short exits, non-unit contracts, a restart between
fills, partially open entries/targets, delayed prices and commissions, repeated
lookups, exact source identities, environment isolation, database rollback, and
three real SIGKILL cases before/during/after cash restatement. Existing entry,
protection, handoff and recovery tests remain part of the full suite.

This is cash-accounting hardening, not evidence of improved strategy returns.
The deployment remains paper. Native protection during a still-working partial
entry, emergency account-wide flatten allocation, historical unlinked fills,
account/subaccount identity, fee revisions after a complete snapshot, and private
fill streams require further work. An entry finalized after the simulator already
closed can retain a quantity mismatch; it remains provisional rather than being
presented as exchange-confirmed P&L. These tests cover process termination, not
machine power loss or real exchange execution.

Checks passed: 780 server tests (17 added, including three new SIGKILL cases),
three dashboard tests, nine accounting component render assertions, server type
check, dashboard lint and production build.

## 211. Independent shadow capital restores the signal evidence flow (31 October 2026)

The live investigation at approximately 18:10 UTC found 558 shadow entry events in
six hours. Of those, 152 were refused as `margin or leverage cap exhausted` (90 on
15m and 62 on 1h). The account was still processing signals: 23 entry signals and
five openings in the initial six-hour snapshot, with eight fee-width refusals and
six native-stop refusals. Successful account run logs showed no scan failures.

Ordinary shadow sizing used the fixed $10M research purse, but subtracted every
other shadow position's margin and notional from it. The 64 open research positions
held about $223.48M synthetic notional and $8.79M synthetic margin. In particular,
the aggregate notional exceeded a 20x product's $200M ceiling, even though those
positions belonged to unrelated experiments. Low-leverage markets therefore
stopped collecting evidence. A larger starting purse would not fix the coupling:
risk-sized positions grow with that purse too.

Book 2 now sizes each ordinary cell independently. Only book 0 subtracts the shared
portfolio's occupied capital. Both the initial decision and deferred/maker fill
use this rule. Versioned execution plans already had independent reference purses.
Fixed shadow sizing, duplicate-position protection, per-trade leverage/lot/stop
limits, costs and deployable-quantity depth checks remain in force. The account's
$150 margin sizing, 3% stop-risk cap, 6x fee floor and allocation policy are unchanged.
Historical trades and refused signals are preserved; old entries are not replayed.
Paper fingerprint simulation version 205 identifies the new observation cohort.
Single-cell backtest semantics have not changed, so their cache version is unchanged.

Four regression scenarios fail with the old sizing: aggregate leverage exhaustion,
aggregate margin exhaustion, deferred market fills and resting maker fills. They
pass with independent shadow capital, including restart recovery and repeat-signal
protection. A fifth test retains fee, indivisible-lot and missing-quote refusals;
existing account margin-reuse and real-sized depth tests protect the other book.
This restores prospective evidence collection; it does not establish profitability
or make native-stop cells automatically eligible for the account.
