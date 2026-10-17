# The scanner process, for the operator (17 October 2026)

A scanner is one Pine script, indicator or strategy, run on one market and one timeframe. The
system turns the script's signals into paper trades under measured gates. This page is the
process as it stands at decision 114; the decisions log (`DECISIONS.md`) is the record of how
each rule was measured.

## How a scanner runs

1. **Bar close.** Only closed bars reach the script. The forming bar is never seen.
2. **PineTS worker.** The script runs in an isolated worker and produces alerts, alert
   conditions, plot shapes, labels, or, for a strategy, a trade ledger.
3. **Extractor.** Events become `entry`, `exit` or `info`:
   - structured `alert()` messages, which can carry a stop and targets;
   - `alertcondition()` titles and plot shapes, direction only;
   - derivation rules for a few structure scripts (HL/LH labels and the like);
   - strategy ledger fills (`STRATEGY entry/exit …`), with the strategy's resting stop and
     limits attached on a live last-bar entry (decision 111).
4. **Gates.** Before a trade opens the signal must clear:
   - the efficiency gate: Kaufman efficiency ratio over 20 bars at or above 0.25;
   - the cost rule: the stop covers six round trips of fees plus the live spread;
   - the market gate: turnover, book cost, quote;
   - the account-state limits (daily and weekly loss, position caps, burst guard), live only.
5. **Paper engine.** Shared logic sizes the position, places the stop and targets and manages
   the exits.
   - `both` (default): the script's levels and exits when it publishes them, otherwise the
     1.5×ATR stop with the fleet's targets and trail.
   - `levels`: the script's published levels, its exit events ignored.
   - `script` (decision 113): the script's own exits only; the fleet's ladder, trail and floor
     are off; a disaster stop of `paper.scriptDisasterStopAtr` × ATR when the script published
     none.
6. **Books.**
   - The account, in SQLite.
   - The shadow book: same extraction, same engine, the cell-intrinsic gates applied since
     decision 112 (efficiency, market, cost, quote), no account-state gates.
   - The backtest and the nightly screen, the same path with the market's measured book cost
     paid (decision 109).

Silent scripts, those with no entry channel, are skipped by the screen and never reach the
incubator or the fleet.

## How the library becomes a fleet

- **Screen**, nightly. A slice of the library × the markets the gate allows × a rotating
  timeframe (15m, 1h, 4h) from a saved cursor. A cell passes on at least 20 trades, profit
  factor 1.2, five of eight windows up, positive both halves, positive at stressed slippage,
  and a positive holdout it was not picked on, with the book cost paid. A strategy is screened
  a second time on its own exits and the two results are kept side by side (decision 114).
- **Shadow.** The best candidates take free slots and trade on live data under the gates above.
- **Gate.** A cohort (one scanner on one timeframe across its markets) is proposed after at
  least 30 shadow trades over 14 days, profit factor 1.2 in R, +0.1R per trade, at most half
  its entries duplicating a live pair, and, once three weeks have closed a trade, at least 60%
  of weeks positive. A shadow pair with no trade for 21 days on 15m, 30 on 1h or 45 on 4h gives
  its slot back.
- **Operator.** Approves or rejects on the Incubator page. The weekly promotion cap and the
  fleet cap are settings.
- **Demotion.** A live cell that trades badly, goes silent for 14 days, sits on a market the
  gate refuses for three days running, or has five cost-rule refusals and no open in 14 days
  is proposed for demotion and gives its slot back.

## How to use it

- **Watch the Incubator page.**
  - "Waiting for your decision": promote or reject. A strategy cohort shows an "own exits" or
    "fleet exits" pill with the measured reason, so the exit mode can be set before promotion.
  - The shadow and account tables: the Signals 14d column says which gate is refusing a cell's
    entries, and the Clock column which demotion clock a live cell is on.
- **Check a specific cell.** Open the scanner's page or run `diagnose`: R per trade, first-bar
  stops, and whether its signals clear the efficiency and cost gates on the markets you care
  about. For a strategy, the `script` variant against `base` is the comparison that matters.
- **Do not loosen the gates.** The efficiency gate and the cost rule are the measured filters
  that pay. Higher timeframes and more volatile markets clear them more often than 15m majors.
- **Prefer measured cells.** The screen and the shadow book already select for cells that can
  trade economically under the live rules; the account's own record judges the live fleet
  faster than any re-vetting would.

## What to expect this fortnight

The shadow book's trade rate is lower than before decision 112, because it now refuses what
the account refuses. The first cohort verdicts under the gated book arrive over the next two
weeks. The five strategy cohorts moved to exit mode `script` under decision 114 are judged
forward from 17 October; their earlier shadow trades are not evidence for the new setting.

The process is script → extractor → gates → paper engine. The levers that change results are
which cells the incubator promotes and whether a strategy's own exits beat the fleet's, not the
extractor or the stop.
