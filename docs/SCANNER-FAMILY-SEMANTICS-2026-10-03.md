# Scanner families: are we asking the wrong question?

**Yes, in several reproducible ways. The current system sometimes confuses a component's role with a trade signal, and its screening results cannot distinguish every cause of “no trades.” This does not establish that the losing strategies have a hidden profitable interpretation.**

This review examines the local repository, not a fresh VM deployment. Baseline: `9df0aef6cda8a24e8cc34ad98c1159051e8790cc`, with concurrent edits to scanner specifications preserved. It adds research artifacts only. Current source already includes Decision 72's ADX and daily-range features; the three-candidate scanner test is recorded as queued. Existing work was not restarted.

## Coverage and evidence

The fresh inventory reads all **3,033 registry entries** and lexically inspects all **2,679 available sources**. Effective registry status is **2,089 ok, 590 incompatible, 354 unavailable**. These are the registry's classifications, not fresh runtime results. They differ from raw manifest counts because the registry applies the stored compatibility report, then checks source availability. That report is dated September 30.

There are **829 available sources with none of these direct calls: alert, alertcondition, plotshape, plotchar, strategy.entry**. Of those, 403 contain numeric plots and 426 need drawing/table/other-output review; **557 are currently marked ok**. Static absence of these calls does not prove runtime silence: imported functions, drawings, and dedicated adapters need separate inspection.

The two saved scanner-diagnostic reports used here contain base-result rows for **33 distinct scripts**. That is coverage of those reports only, not total research coverage. The prior exit, composite, family, and author studies remain relevant.

Every entry has source identity/hash, output-call counts, historical compatibility evidence where available, saved diagnostic coverage, explicit-rule presence, and dependency/temporal flags in the [inventory](/Users/scorpion/Desktop/Vela_VNEdge/_research/family-semantics-20261003/inventory.json). Families are **routing hypotheses**, using name rules plus a few explicit corrections, not semantic certification. All matches are retained; 989 entries remain unclassified by these conservative name rules. The current exact totals are in [summary.json](/Users/scorpion/Desktop/Vela_VNEdge/_research/family-semantics-20261003/summary.json). Unclassified items remain a review queue. This is a family-level architecture review with representative source checks, not manual verification of every script.

## What the tests actually show

Eight focused reproductions ran against the real extractor/rule/profile modules; 24 existing tests also passed. The new tests assert the problematic current behavior so that the evidence is reproducible. They do not mean the behavior has been fixed.

| Reproduction | Current behavior | Consequence |
|---|---|---|
| Volatility Signature's `Upward Fine-Interval Bias` | Long entry | A data-quality diagnosis becomes a directional trade. |
| `Bullish BOS` through different channels | `alert()` → information; `alertcondition()` → entry | Meaning depends on output channel rather than the scanner contract. |
| SafeZone `Long Stop Hit` / `Short Stop Hit` conditions | Neither becomes an exit | A functioning exit tool contributes no usable exit event through this channel. |
| Informational `alert()` plus independent entry condition on one bar | The condition disappears | Channel precedence can suppress an otherwise recognized entry. |
| ADX supplied to the explicitly enabled generic oscillator adapter | Crossing 30 upward becomes a long “left oversold” event | Scale and title heuristics invent direction for a strength measure. This is conditional on enabling that adapter, not proof it is currently enabled for ADX. |
| Exit-only alert output, no plots or labels | Profile kind `silent`, exits = 1 | “Silent” does not actually mean emitted nothing. |
| Wyckoff `Markup Started` / `Markdown Started` | No normalized events | Useful phase transitions are lost. A transition still needs an explicit entry policy before trading. |
| Same-bar bullish BOS followed by an MSS reclaim condition | BOS survives; reclaim label disappears | Deduplication can erase the more specific setup identity before label evaluation. This tests the collision mechanism, not its observed frequency. |

Evidence: [tests](/Users/scorpion/Desktop/Vela_VNEdge/_research/family-semantics-20261003/semantics.test.ts), [test log](/Users/scorpion/Desktop/Vela_VNEdge/_research/family-semantics-20261003/tests.log), extractor `server/src/scanners/extractor.ts:226–295`, generic oscillator selection `server/src/scanners/rules.ts:273–329`, profile classifier `server/src/scanners/profile.ts:33`.

Two screening decisions magnify the uncertainty:

- `diagnose.ts:83` returns no cell result when no entry was extracted. A zero-entry run therefore lacks a useful explanation in the result matrix.
- `incubate.ts:115–118` stops trying a script after three markets without an entry. The probe counter increments before checks that can skip an existing pair. Neither three quiet markets nor three loop iterations establishes that the remaining markets cannot produce a valid setup. The screen also still omits reading options that the live path uses.

## How to read and evaluate each family

These are evaluation contracts, not recommendations to enable the whole family. Many scripts combine several roles and should expose each role separately.

| Family | Read it as | Correct evaluation and disposition |
|---|---|---|
| **Trend** — SuperTrend, moving averages, ribbons | Persistent direction plus an optional change event | Compare a fixed trigger with and without the direction state. A state can remain useful for hundreds of bars without a fresh entry. Test trend-flip entries separately. Do not count five related moving averages as five independent confirmations. |
| **Momentum** — RSI, MACD, oscillators | Momentum, stretch, or a specifically defined transition | Freeze whether the strategy follows momentum or fades an extreme. A bounded oscillator is not automatically RSI; a 30/70 threshold inferred from scale is not a contract. Timestamp divergence at confirmation. |
| **Regime** — ER, CHOP, ADX, Hurst | Eligibility state or continuous feature | Measure conditional expectancy, trade retention and stability of the same entry strategy. Low CHOP is directional efficiency, not bullish direction. Use the journal's existing ER/CHOP and newly added ADX first. The earlier S4 regime combination remained negative. |
| **Volatility** — ATR, ADR, historical volatility | Risk scale, range consumption, or expansion/contraction | Judge stop-distance calibration, costs relative to movement, and conditional outcomes. High volatility alone has no long/short sign. Use the new incremental daily-range feature rather than the ADR source's leaking historical progress. |
| **Compression and breakout** — Squeeze Index, TTM Squeeze | Armed compression state → release window → directional break | Preserve the sequence, expiry and one-shot consumption. Compression without a directional break is not an entry. Previous S2 evidence was only eight trades: insufficient, not a proven rescue. |
| **Volume and flow** — OBV, MFI, delta tools | Participation or imbalance evidence | Test incremental value after controlling for price momentum. Identify the actual data source. For example, Value Area Reversion splits volume using candle direction; it is not measured aggressor order flow. Reject unavailable-data conclusions, not necessarily the concept. |
| **Value and levels** — VWAP, profiles, VAH/VAL/POC | Location and target/invalidation levels | Freeze the level known at setup time, then test a defined touch/reclaim/rejection. A support line's existence is not a buy. Previous-session profiles are easier to replay honestly than final developing profiles. |
| **Market structure** — BOS, CHoCH, pivots | Confirmed structure state and structural events | Distinguish continuation, reversal, setup and entry. Export confirmation time and pivot time separately. Use fixed event meanings across channels. Generic BOS classification currently differs between alerts and conditions. |
| **Liquidity / SMC** — MSS Sweeps, FVGs, order blocks | A sequence with location, confirmation and invalidation | A sweep, reclaim and gap are distinct events, not interchangeable bullish words. Test MSS's reclaim channel separately from BOS. Audit event identity before interpreting its standard scanner-test results. |
| **Wyckoff** | Phase/campaign state, range, spring/upthrust and resolution | Preserve the stage machine; test a frozen spring/reclaim or markup-entry rule. The source already exposes numeric cycle stage, while the generic extractor misses named markup/markdown transitions. |
| **Elliott and harmonics** — ZigZag, wave patterns, Fibonacci | Confirmed geometric setup and invalidation | Replay with data prefixes to verify when each point became knowable. Never enter at a back-positioned pivot because the completed chart looks precise. Treat tentative and confirmed patterns separately; sparse setups need more observations. |
| **Patterns** — candlestick and chart formations | A completed event in a specified context | Test the confirmation event, base rate and conditional outcome. A pattern forming is not a completed signal. Separate ordinary candles from synthetic charts when simulating fills. |
| **Sessions and seasonality** | Time eligibility and session-defined levels | Validate timezone, session reset, DST where relevant, and instrument fit. Judge opening ranges and sweeps over completed sessions. A seasonal window opening does not choose trade direction. |
| **Sentiment and external context** | Point-in-time external feature | Verify symbol mapping, publication lag and historical coverage first. Missing SPX, breadth, funding or other external series must be unavailable, not a neutral vote. Crypto price candles cannot supply every data dependency. |
| **Statistics** — correlations, regressions, volatility signature | Measurement, normalization or diagnostics | Test feature quality or calibration. Rising correlation is not rising price. The local Correlation Coefficient defaults to `SP:SPX`, and its zero-cross title can look directional to a generic parser. Volatility Signature is a later diagnostic priority given the recorded short Delta history window. |
| **Machine learning** — logistic scores, classifiers, clustering | A score with a defined target and training procedure | Verify label horizon, feature availability, calibration and chronological separation. The imported Logistic Signal Calibration uses user-set coefficients; its name does not establish a fitted probability model. Last-bar clustering must not rewrite historical features. |
| **Risk and exits** — SafeZone, chandelier, sizing tools | Position-aware stop/target/sizing updates | Replay identical entries and price paths; measure net R, drawdown and give-back. Preserve the existing exit-lab evidence: no second-half winner; chandelier remains unpromoted. The lab's SafeZone approximation is not exact source parity. |
| **Validation** — backtest utilities and Monte Carlo | An evaluator or scenario generator | Feed it a frozen strategy/trade sample and test statistical validity. A projected path or favorable simulation is not an entry. Costs, dependent samples and selection bias must be represented. |
| **Meta / utilities** — ensemble dashboards, aggregators | Composition, diagnostics or presentation | Identify constituent signals, timing and correlation before aggregating. A consensus of copies of the same price feature is not independent evidence. Keep display-only components outside entry screening. |

## Three concrete source reviews that change the queue

**Market Structure Volume Distribution belongs in a feature-adapter queue before an entry-test queue.** Its source builds lines and boxes, with no direct alerts or plots. It uses a visible-range or last-N-bars execution window and draws the profile at the last confirmed historical/realtime bar. The current event scanner has no native entry stream to test. Export per-bar confirmed structure and profile features from prefix-valid history before defining any trade. Do not use the final profile to reconstruct old signals. This is also a different script from Structure Volume Profile Setups.

**MSS Sweeps needs an explicit event contract before interpreting returns.** Its source emits bullish/bearish BOS as well as protected-level sweep/reclaim conditions. The generic reader makes BOS an entry, and same-bar deduplication can retain BOS instead of the reclaim label. A backtest can therefore judge “MSS Sweeps” while actually measuring a mixed or earlier channel. Whitelist exact reclaim events and preserve semantic identity through extraction; treat BOS as context unless a separate strategy explicitly trades it.

**Value Area Reversion is testable as a trigger after its reading is frozen.** It exposes previous-session and developing-session reclaim signals plus value-area crossing notifications. Begin with the previous-session reclaim pair, confirm the level and event timestamp, and compare its standalone results before adding regime filters. Its volume profile and bullish/bearish volume are candle-derived approximations. Do not interpret them as an exchange footprint.

Sources: `scripts/pine/Mzdl5F5b-Market-Structure-Volume-Distribution-LuxAlgo.pine:211–270`; `scripts/pine/gRo6KnE6-MSS-Sweeps-LuxAlgo.pine:184–187`; `scripts/pine/dH31Y72B-Value-Area-Reversion-Signals-LuxAlgo.pine:191–192,512–517`.

## Replace “dead” with an attributable status

Keep independent dimensions instead of one ordered label:

1. **Runtime:** source missing, unsupported dependency, run failed, or executed.
2. **Role:** context, state, setup, entry, exit, risk, or display/evaluation utility.
3. **Coverage:** warming up, missing series, no setup in this window, output not mapped, or mapped output observed.
4. **Evidence:** not tested, insufficient sample, gross-positive/cost-negative, negative under a verified contract, or eligible for prospective shadow evaluation.

Every run should record the input/data fingerprint, raw output counts, mapped events by role, dropped-output reasons, confirmed setup count and eligibility rejections. A useful minimum funnel is **executed → valid data → role output → setup → entry intent → risk eligible → simulated fill**. Record zero counts at each stage rather than dropping the row.

Component contracts should name output fields, units, directional meaning, event identity, lifetime, availability time, dependency coverage, and position applicability. Keep source events intact until the strategy decides which event opens a trade; deduplicate execution intents afterward. The same resolved contract must feed screening, validation, shadow and live paths.

## Work order

1. Repair observability and semantics: explicit zero-result reasons, non-entry roles, condition exits and cross-channel precedence. Add parity tests before changing production behavior.
2. Finish the already queued candidate tests, but audit the reading first. Treat a zero-entry Market Structure Volume Distribution result as “no entry adapter,” not “failed strategy.” Use source-informed contract variants, not arbitrary inversion searches until one wins.
3. Evaluate features against fixed entries using the newly available ADX/day-range fields. Respect prior negative composite and exit evidence.
4. Implement one representative adapter per useful family, retaining a simple baseline. Confirm historical-prefix stability and multi-timeframe availability. Track every attempted variant to expose selection risk.
5. Fix family-lab selection leakage before choosing combinations. Freeze train-time membership, signs and consensus thresholds, then use untouched evaluation data and prospective shadow results.

No full-library performance rerun was performed; these are source/architecture findings plus deterministic semantic tests. The correct conclusion is that **“dead scanner” is currently an unreliable diagnosis**, not that all scanners can be made profitable.
