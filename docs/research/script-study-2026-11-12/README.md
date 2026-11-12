# Script study, 12 November 2026

Every Pine source in the library (2,633 files, about 774,000 lines) was read line by line by a model reader and
compared with the way the bot reads it. Each reader wrote a contract per script: the author's real entries, the
markers the bot misreads, the script's own stop, targets and exit, timing, inputs to change, and a proposed reading.
On scripts that trade, a second reader tried to refute every claimed misread from the source.

No reading, config or trade was changed. Everything here is a proposal.

## How it was run

- 302 batches, trading scripts first. The 50 batches holding scripts with live or shadow pairs, and every check,
  ran on Claude Opus. The other 252 batches ran on Claude Sonnet.
- The batch work list, readings and static-audit findings each reader started from were taken on 11 November.
  The "current" readings in `report.md` and `proposed-readings.json` are the VM's on 12 November.
- Pairs per scanner are the shadow and live counts from 11 November.
- `scripts/script-study-report.py` rebuilds `report.md`, `contracts.jsonl` and `proposed-readings.json` from the
  readers' output.

## Results

| | Scripts |
|---|---|
| Can run as their author designed them | 258 (102 of them trade today) |
| Tradeable after the listed changes | 1,219 |
| Context only: no entry concept | 1,022 |
| Should not be traded | 134 |

| Misread | Claims | On trading scripts | Confirmed by the check | Refuted |
|---|---|---|---|---|
| A regime, exit or information marker traded as an entry | 1,030 | 229 | 189 | 40 |
| The author's real entry is not read | 717 | 122 | 113 | 9 |
| A marker traded without the script's own confirmation | 458 | 130 | 117 | 13 |
| Traded on the side opposite to the author's | 228 | 56 | 56 | 0 |
| An exit or reversal read on the wrong side or as an entry | 197 | 45 | 37 | 6 |
| One side traded, its mirror not | 31 | 14 | 13 | 1 |

The table counts a claim once per scanner id, so a claim on a source shared by two ids counts twice. Counted once each,
582 claims on trading scripts were in scope: 511 confirmed, 69 refuted, 2 not reached by the check (12% refuted).
Claims on scripts that do not trade were not checked; treat them as first reads.

## The 17 enabled scanners

| Scanner | Verdict | Confirmed corrections |
|---|---|---|
| Trend Impulse Channels, base and maker | needs changes | Both retests traded opposite to how they are drawn. Deliberate (decision 195, a breakout-continuation reading); the as-drawn reading exists as the native variant. Compare, do not overwrite |
| Liquidity Trail Matrix, ATR maker | run as designed | Its reversal alert closes the wrong side (reader fault 1) |
| Machine Learning RSI | needs changes | Trend-flip markers, the script's exit, traded as entries |
| AI Predictive Flow | needs changes | Background colour traded as an entry; the drawn cross entries are not read |
| SuperTrend Cluster | needs changes | "Base ST" markers traded without the cluster vote |
| Smart Swing VWAP | needs changes | AVWAP crosses traded as entries; the author's entries are the retests and polarity flips |
| Pivot Channel Breaks | needs changes | Short break switched off; the two-sided variant exists |
| Smart Money Breakout Signals | needs changes | Bearish breakout not traded, by an allow-list from decision 67's label test |
| Session Killzones, Asia only | needs changes | The Asia bearish breakout is not traded (the all-sessions scanner reads all six) |
| Kinetic Momentum Vectors | context only | "Bull Spike" is not an entry; the spike has no direction |
| Structure-Anchored VWAP, RSI Volume Ladder, Alphamojo | run as designed | None; the bot reads them right but discards their stops and exits |
| Adaptive Volatility Trend, Trend Lines, Session Killzones all sessions | needs changes | None; they have no stop or exit of their own |

Liquidity Trail Matrix (base) was switched off on the VM between the start of the study and this report.

## Faults in the bot's reader

These come from the readers tracing alert text through `server/src/scanners/extractor.ts`. None has been fixed.

1. **Reversal text is read on the wrong side.** Confirmed. "🔄 REVERSAL | Long → Short" is sent when a long closes;
   the parser takes the first side word and inverts it, so the close is filed for the short side and the long stays
   open in the bot. "Short → Long" happens to come out right.
2. **Exit and invalidation titles read as entries.** 37 confirmed cases on 18 trading scripts. Titles such as "Invalidated",
   "Ended", "Broken", "Support lost", "Long Win/Loss", Spanish "Cierre" and "Salida", and "SELL" shapes that only close
   a long in a long-only strategy carry a direction word and are taken as entries.
3. **"Dn" is not a direction.** Confirmed in code: "ST Flip Up" reads as a long while "ST Flip Dn" is not read.
4. **An entry behind an exit line is lost.** Reported, not checked. Synapse Trail Pro sends one message per bar with
   exit lines first; on a flip bar the entry after "FLIP_CLOSE" is not parsed.
5. **Other stop and target wordings.** Reported, not checked: "Stop :", "Target :", "stop=", "target=" are not read
   as the script's own levels.
6. **Label reading.** Reported, not checked: hollow △ ▽ arrows, labels edited with `set_text`, and label text with
   a price or a line break may not be read.

## What I propose, in order

Several "misreads" above are deliberate choices recorded in docs/DECISIONS.md (decision 195 for Trend Impulse, decision 67
for the label allow-lists). The readers judged against the author's intent, not against those decisions. Old evidence
does not prove those choices still pay, but changing them needs a side-by-side comparison, not an overwrite.

1. Fix reader faults 1 to 3, with tests, before any reading change: they affect scripts that trade today. Keep
   genuine SELL entries; tell a pattern's invalidation apart from closing a position; and add "Dn" only together with
   contracts that keep non-entry flip markers (Machine Learning RSI's ST Flip Up/Dn) switched off.
2. Run the corrected readings for the enabled scanners as shadow variants beside the current ones and compare at
   real prints. `proposed-readings.json` holds each one with its evidence.
3. Put the 102 trading scripts that can run as designed into shadow with their own stop and exit, not the bot's
   1.5 x ATR stop and +0.5R trail.
4. Recalibrate the static audit. Readers confirmed 93% of its side-against-drawing findings and 87% of no-entry-read,
   but only 24% of levels-not-exported and 33% of lookahead; those two rules are too loose.

## Files

- `report.md`: the full tables, every enabled scanner finding by finding, the confirmed side errors, and the
  trading scripts that can run as designed.
- `contracts.jsonl`: one contract per script, each misread marked confirmed, refuted, unchecked or not-trading.
- `proposed-readings.json`: 195 trading scanners with a confirmed misread: current reading, proposed reading, evidence.
