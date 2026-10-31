# Scanner contribution audit — 31 October 2026

The library had extensive screening and forward records without a reliable, versioned inventory of what each script produced. The VM contained 57 saved profile cells for only 19 scanners, while the latest nightly screen reported 9,081 runs. A profile is an observation, not proof of profitability or a completed semantic review.

## Corrections

- Manual profiling, CLI profiling and screening share `observeHistoricalRun`, which uses the production `readingOf` contract: source channels, allowed titles, side overrides, inversion, edge behavior, variants, derived rules, inputs and timeframe.
- Profiles retain source/reading signatures, input history length, candle-window timestamps and origin. Unversioned and changed profiles remain visible separately from matching evidence.
- Nightly screening saves profiles as it works, including quiet and failed runs. The base run now uses the configured timezone, as the prefix stability check already did.
- A completed no-entry re-screen replaces an existing passing screen. It does not create new empty candidates. Skipped markets receive no verdict.
- The three-quiet-market resource shortcut now starts with unobserved/oldest-observed markets on later passes, rather than repeatedly sampling the same market prefix. Existing runtime and resource guards remain in force.
- Scanners and Incubator show family coverage, code-matched behavior, configured reading, source calls and dependencies, actual allocated cells, retained shadow decisions, paper decisions, closed-trade counts, reasons and next actions. Pending decisions are distinct from opened decisions; tracker history is excluded from shadow counts.
- Empty reading channel lists display as entries disabled, not all channels.

## Validation

Seven new regression tests cover reading parity, profile fingerprints and persistence, source parsing, quiet-probe rotation, book/decision accounting and stale no-entry screens. The complete server suite passes 644 tests; dashboard filter tests add 3. Dashboard lint and production build pass.

A separate read-only behavior sweep executed 25 selected scanners on BTCUSD, ETHUSD and SOLUSD at 15m, 1h and 4h (225 observations; up to 800 candles each, current incomplete candle excluded). It recorded 5,345 entry events and no runtime failures: 205 signal observations, 18 plans, and two levels-only observations. Kinetic Momentum Vectors on ETHUSD 1h and Omni Flow Consensus on BTCUSD 4h had no accepted entries in these windows. These are output checks, not return backtests, fill simulations or approval to increase risk.

The selected set covers WillyAlgoTrader, LuxAlgo, BigBeluga, AlgoAlpha, Zeiierman and ChartPrime, plus two existing strategy imports. Existing title restrictions are important: Kinetic Momentum selects Bull Spike, Session Killzones selects Asia Bull Breakout, Smart Money Breakout selects Bullish Breakout Detected, and AI Predictive Flow selects Background Turned Bullish. A chart showing other marks is not evidence that the configured reader should trade those marks. The effective reading is exposed for review.

## Contribution model

1. Entries: a causal directional event can enter screening and forward shadow evaluation with its scanner identity intact.
2. Context: regime, volume and structure indicators require explicit timestamped feature adapters and prospective testing. Their drawings must not silently become entries.
3. Levels and exits: targets, stops and exit events need separate causal contracts; a level on a chart is not automatically executable at the time it is drawn.
4. Duplicates: matching source and reading aliases point to one canonical identity rather than multiplying apparent evidence.
5. Allocation: evaluate contribution by scanner, market and timeframe after costs. Major authors already contribute to shadow research; family membership is not a performance criterion for funding.

The ledger inventories all 2,638 non-removed registry entries in this checkout. Static inventory is not an assertion that every source is semantically correct. The new runtime sweep covers 25 scanners; the remaining current-profile gaps are explicitly visible and populated by subsequent screening. Existing risk, margin sizing, fees, leverage and promotion thresholds are unchanged by this release.
