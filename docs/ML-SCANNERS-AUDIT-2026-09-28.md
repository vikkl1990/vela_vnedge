# Audit — the Learn (ML) page and how scanners are handled — 28 September 2026

## 1. Learn / ML — what it is, what it does, what it should be

**What exists.** `server/src/ml`: a per-scanner and a global logistic regression over ~20 entry-time
features (ATR%, hour, weekday, side, which channel the signal came from, volume ratio, position in
the recent range, whether the script gave a score or levels, reward:risk), trained on every backtest
and paper trade in `ml_samples` (40-sample minimum per scanner), Platt-calibrated, with a rules
extractor ("win rate is higher when ATR% > x") and a drift monitor over the last 200 live feature
vectors. The Learn page shows AUC, feature weights and the rules, per scanner and globally.

**What it does to trading: nothing.** `ml.minProb 0`, `ml.useAsScore false`. Every position carries
its `mlProb` for the record; no decision reads it. Measured as an entry filter with the halves
discipline (decision 37): no threshold improves total R on any scanner; where R per trade rises it
is by discarding trades.

**Why it cannot work as built.**
- Its features are price-shape at entry — the same information the script already used to fire.
  A model that re-reads the script's own inputs adds nothing; the family lab showed that new
  information has to come from *other* readings (decision 45).
- Its label is win/loss. The bot's objective is R, and most wins are small trails; a win-rate model
  learns to prefer the trades that reach +0.5R, not the ones that reach +3R.
- Its training set is the library, not the fleet: most samples are scripts that never trade, and the
  fleet scanners have too few.
- It is evaluated on the data it was fitted on. The page's AUC is in-sample.

**Findings.** (1) The page reads as if it steered the bot; it now says, at the top, that it does
not and why. (2) The rules extractor produces sentences no one has ever acted on; it is noise with a
UI. (3) The drift monitor is the one part worth keeping — it says when the market the fleet trades
stops looking like the one it was measured on.

**What Learn should become.** The honest evaluation surface: the family lab's readings (which
scripts' *states* carry information about the next bars, judged first-half → second-half and across
markets), the cohort verdicts from the shadow book, and the drift report. Expected-R models over
external readings (positioning, funding, liquidations) belong here once there is a fleet worth
filtering — trained on the first half, judged on the second, adopted only with breadth. The
win-probability model and its rules should go.

## 2. Scanner handling — what was missing and what changed

The Scanners page managed a script as a checkbox: status from a stale compatibility report, on/off,
symbols, timeframes, exit mode, run now, hide, bulk enable, and a backtest profit factor of the
kind decision 44 discredited. Nothing said what the script *is*, how it is read, or whether the
runtime has quarantined it. The specs from decision 48 lived only in `scripts/specs.json`.

**Changed today (decision 54):**
- A **profile** per scanner × market × timeframe, stored in `script_profile`: what the script
  produced when actually run — `plan` (its own stop and targets), `signal` (a direction only),
  `levels` (information), `silent`, `broken` — with the counts behind it (entries, entries carrying
  a plan, entries from `alert()`, alertconditions, shapes, labels, plots). `POST
  /api/scanners/:id/profile` runs it at background priority; `npm run profile` stores the same rows.
- The scanner view carries **how it is read** (`sources`, `timezone`, `rule`, inputs, exit overrides),
  its **kind**, when it was profiled, and its **health** row (failures, last error, quarantined).
- Scanners page: **Kind** and **Reads** columns; quarantined scripts are marked.
- Scanner detail: a **How it is read** panel — entry channel, timezone and derived rule editable
  (trader role), a **Profile now** button with the per-timeframe table, and a warning when a script
  produces more entries than trade calls with no channel lock (the over-read of decision 48).
- `POST /api/scanners/:id` accepts `sources`, `timezone`, `rule`, validated.

**Still missing, in order.**
1. **Evidence on the page.** Halves and breadth per scanner × timeframe (what `survey` prints) and
   the cohort verdict from the incubator, in place of the single-run backtest PF.
2. **A lifecycle, not a checkbox.** Library → profiled → specified → measured → shadow → fleet →
   retired, with the gate at each step visible and the enable switch refusing to skip one.
3. **Status from the last real run**, not the compatibility report (ten scripts it calls broken run).
4. Per-scanner exit overrides and inputs editable where they are shown.
5. Categories from what the script does (its profile), not from its name.
