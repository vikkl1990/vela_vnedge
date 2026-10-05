# Four composite strategies — corrected backtest, 29 September 2026

**None of the four candidates merits live promotion on this evidence.** S1 and S4 lost after the assumed costs in both halves on all three markets. S3 was rare and negative overall. S2 was positive but produced only eight trades; its benefit over the underlying breakout is unproven.

This is a fresh run of the research specifications, with explicit handling of details that were ambiguous in the proposal. It is not a test of all possible combinations or a claim that these scanner families can never work.

## Results

R is profit/loss divided by the initial entry-to-stop price risk, net of modeled fees and slippage. It is not an account return or a percentage. A dash means no trades or undefined profit factor, not zero performance.

| Strategy | ETH average R (trades) | BTC average R (trades) | SOL average R (trades) |
|---|---:|---:|---:|
| S1: Trend continuation | -0.226 (228) | -0.499 (263) | -0.211 (289) |
| S2: Compression breakout | +1.139 (4) | +1.817 (2) | +0.346 (2) |
| S3: Sweep reclaim | — (0) | -0.287 (7) | -0.919 (9) |
| S4: Range return to value | -0.213 (35) | -0.236 (44) | -0.337 (43) |

| Strategy | Base-cost trades | Base average R | Doubled-cost average R | Descriptive 95% weekly-block interval |
|---|---:|---:|---:|---:|
| S1 | 780 | -0.313 | -0.724 | -0.482 to -0.110 |
| S2 | 8 | +1.110 | +0.971 | -0.260 to +1.885 |
| S3 | 16 | -0.642 | -0.917 | -1.288 to -0.168 |
| S4 | 122 | -0.265 | -0.431 | -0.420 to -0.111 |

Pooled figures combine trade observations across markets. They do not describe an executable portfolio, equal dollar allocations, or independent market samples. The interval resamples 18 seven-day calendar blocks jointly across markets, with 2,000 deterministic bootstrap draws. It is a descriptive dependence sensitivity, not a selection-adjusted significance test. S2's eight observations cannot support a robust profitability verdict even when its interval looks attractive.

## Interpretation

- **S1 — reject this specification for promotion.** The slower trend gate modestly improves pooled expectancy from -0.336 to -0.313 R/trade, but the result remains negative on 780 trades. Later-half performance is worse on every market. An additional similar trend scanner is not supported as a fix.
- **S2 — insufficient evidence.** Only 4 ETH, 2 BTC and 2 SOL trades qualify. Relative volume removes none of the 14 underlying breakout trades in this window. Adding compression removes six trades and raises average R, but total trade R falls from 9.48 to 8.88. These few events do not establish the squeeze filter's incremental value.
- **S3 — negative and over-restricted.** The exact-level implementation produces no ETH entries, seven BTC trades and nine SOL trades. Reclaim improves the raw sweep's pooled average, yet remains negative. Adding stretch and regime reduces activity further without establishing an edge.
- **S4 — reject this specification for promotion.** The regime gate marginally improves pooled average R but it stays negative in both halves on every market. The oscillator's mature ATR(2000) branch was used throughout evaluation.

## Frozen setup and data

- BTCUSD, ETHUSD and SOLUSD perpetual candle data were fetched from Delta India's public market-data endpoints and saved locally. No account credentials or order endpoints were used.
- Each market has **20,000 contiguous closed 15m candles**, aggregated to 5,000 complete hourly bars. Input coverage: 2026-03-04T16:00:00.000Z to 2026-09-29T00:00:00.000Z (exclusive end).
- Every strategy has the same evaluation window: **31 May 2026 04:00 UTC–29 September 2026 00:00 UTC**, approximately 121 days. The initial 2,100 hours are warm-up only.
- The split is **30 July 2026 14:00 UTC**. Each half is simulated independently from flat; any position crossing its endpoint is liquidated within that half. These are retrospective stability checks, not untouched out-of-sample data: earlier research already examined overlapping periods.
- Fixed settings: source defaults; ATR14; 1.5 ATR initial stop and 2R target for S1/S2; source-level structural stops plus 0.1 ATR buffer for S3/S4; S4 freezes the weighted mean as its target. Timeouts are 24 entry-timeframe bars for S1/S2 and 12 for S3/S4. No thresholds were fitted to these results.
- Assumed **0.059% fee per side** and **2 basis points adverse slippage per fill**; stress doubles both. These are declared research assumptions, not verified fees for the user's account. Funding, variable spreads, impact, latency and account-level capital constraints are not modeled. No positive result should be treated as a net live-trading guarantee.
- Entries fill at the next bar open. Hourly positions use 15m execution paths. Stop gaps fill at the adverse open; stop wins if both stop and target occur inside the same 15m candle. All exits, including targets, receive adverse slippage and tick rounding. This target convention is conservative. Time exits fill at the open after the specified number of bars, not a later close.
- Each strategy/market owns at most one position. It cannot re-enter on another component's vote while a position is open. Cross-strategy exposures are not pooled into a trading book.

## Component contracts and implementation choices

S1 uses the actual local Zero Lag direction calculated on closed 1h bars and the Dynamic script's explicit 15m breakUp/breakDn variables. The unrelated MTF dashboard requests are removed from the research adapter; the local direction formula is retained. Higher-timeframe state is joined only after its hour closes.

S2 arms above PSI 80; a cross below 80 opens a three-bar release window, including the release bar. It requires the actual structural breakout Boolean and volume/SMA20 ≥1.2, with the current completed bar included in SMA20. Recompression cancels the window; a qualifying entry consumes it once.

S3 exports the **actual lineLevel** at the point where Liquidity Sweep Filter detects a sweep. When several levels are crossed on the same bar, a bullish setup must reclaim the highest crossed level; a bearish setup must reclaim the lowest. This conservative rule was fixed before the run. The sweep extreme is retained for the stop. Reclaim must occur on the sweep bar or the next bar, while ER remains below 0.35. A setup additionally requires oscillator ≤−100 for longs or ≥100 for shorts. This replaces the old harness's prior-20-bar-extreme proxy.

S4 arms once at the start of a stretch episode, permits a return within the following three bars, and does not renew the expiry on each continuously stretched bar. Both setup and entry require ER below 0.35. The structural extreme includes bars through the trigger; the weighted-mean target is frozen then. A confirmed regime change schedules an exit for the next open. The baseline removes the entry regime gate but preserves the same exit policy, isolating the entry gate's contribution.

For all four, conflicting same-bar long/short triggers are skipped. The Market Regime adapter exports its ER branch only; the previously inconsistent volatility-clustering branch is not used. Source and adapter hashes, derived Pine copies, snapshots and component feature arrays are retained in the research directory.

## Baseline and ablation comparison

| Variant | Trades | Average net R | Sum of trade R |
|---|---:|---:|---:|
| S1_base: Dynamic break alone | 949 | -0.336 | -318.95 |
| S1: Dynamic break + Zero Lag direction | 780 | -0.313 | -243.86 |
| S2_base: Structural breakout alone | 14 | +0.677 | 9.48 |
| S2_volume: Structural breakout + relative volume | 14 | +0.677 | 9.48 |
| S2: Breakout + relative volume + squeeze release | 8 | +1.110 | 8.88 |
| S3_base: Sweep alone | 984 | -0.648 | -637.51 |
| S3_reclaim: Sweep + actual level reclaim | 582 | -0.404 | -235.13 |
| S3: Reclaim + stretch + regime | 16 | -0.642 | -10.28 |
| S4_base: Range re-entry, without entry regime gate | 190 | -0.280 | -53.28 |
| S4: Range re-entry + entry regime gate | 122 | -0.265 | -32.31 |

These are separate simulations with the same exit policy within each comparison, not the same trades with labels changed. Removing a gate changes which positions occupy the book and can therefore change later opportunities. S3_base enters on the sweep without reclaim; S3_reclaim adds exact reclaim without the stretch/regime gates. All variants run over identical evaluation dates.

## Stability by half

| Strategy | Market | First half average R (n) | Second half average R (n) |
|---|---|---:|---:|
| S1 | ETHUSD | -0.089 (122) | -0.384 (106) |
| S1 | BTCUSD | -0.256 (132) | -0.745 (131) |
| S1 | SOLUSD | -0.100 (148) | -0.328 (141) |
| S2 | ETHUSD | +1.899 (2) | +0.379 (2) |
| S2 | BTCUSD | — (0) | +1.817 (2) |
| S2 | SOLUSD | -1.137 (1) | +1.829 (1) |
| S3 | ETHUSD | — (0) | — (0) |
| S3 | BTCUSD | -0.120 (6) | -1.284 (1) |
| S3 | SOLUSD | -1.158 (2) | -0.851 (7) |
| S4 | ETHUSD | -0.228 (22) | -0.187 (13) |
| S4 | BTCUSD | -0.252 (26) | -0.212 (18) |
| S4 | SOLUSD | -0.357 (23) | -0.314 (20) |

## Additional metrics

| Strategy | Market | Net win rate | Profit factor | Closed-trade drawdown R | Long / short trades |
|---|---|---:|---:|---:|---:|
| S1 | ETHUSD | 34.2% | 0.693 | 69.09 | 111/117 |
| S1 | BTCUSD | 31.9% | 0.461 | 139.54 | 130/133 |
| S1 | SOLUSD | 37.4% | 0.722 | 87.39 | 140/149 |
| S2 | ETHUSD | 75.0% | 5.206 | 1.08 | 3/1 |
| S2 | BTCUSD | 100.0% | — | 0.00 | 2/0 |
| S2 | SOLUSD | 50.0% | 1.609 | 1.14 | 1/1 |
| S3 | ETHUSD | 0.0% | — | 0.00 | 0/0 |
| S3 | BTCUSD | 42.9% | 0.630 | 3.74 | 2/5 |
| S3 | SOLUSD | 11.1% | 0.179 | 8.27 | 7/2 |
| S4 | ETHUSD | 45.7% | 0.631 | 10.69 | 26/9 |
| S4 | BTCUSD | 38.6% | 0.570 | 10.51 | 27/17 |
| S4 | SOLUSD | 37.2% | 0.409 | 15.54 | 24/19 |

Drawdown here is the peak-to-trough sum of sequential closed-trade R within one strategy and market. It excludes intratrade mark-to-market excursions and is not account drawdown. Profit factor is undefined when there are no losing trades, so the BTC S2 value is left blank rather than treated as proof of quality.

## Verification and differences from the earlier run

The earlier committed harness and results are preserved. This rerun removes their scratch-directory dependency and corrects material differences: approximate sweep levels; missing stop/target exit slippage; stop-gap handling; time-exit indexing; unequal historical coverage; and repeated range setup arming. It also uses the report's current-bar SMA20 volume denominator and actual slipped entry to place ATR stops. Consequently, trade counts need not match the earlier report.

- **9 execution-model unit tests passed**, covering ambiguous candles, adverse gaps, exit timing, costs on stop fills, actual-entry ATR risk, split boundaries, shorts and regime exits.
- **42 Pine worker executions passed**: seven adapters × three markets × full/prefix runs. All **21 prefix comparisons** matched every selected semantic numeric output. Dynamic events and actual swept levels were included. One prefix per component/market is a spot check, not exhaustive non-repainting or TradingView-parity certification.
- **180 result rows** cover ten strategy/ablation variants × three markets × full/first/second periods × base/stress costs. 14,634 stored trade records (including repeated variants and periods) passed chronology, overlap, interval, accounting and summary-reconstruction checks.
- Node v25.5.0; PineTS 0.9.34. Input OHLC continuity and data bounds were checked. The snapshots, source hashes, feature fingerprints and execution-harness hashes make this run reviewable and reproducible.

Reproduce from the repository root:

```sh
node --test _research/composite-validation-20260929/simulator.test.mjs
VNEDGE_WORKER_HEAP_MB=1024 node --no-warnings=ExperimentalWarning _research/composite-validation-20260929/run.mjs
node _research/composite-validation-20260929/report.mjs
```

The runner reuses local snapshots and feature caches when fingerprints match. Delete or move only those research feature cache files if intentionally validating a changed Pine runtime; the current feature key does not contain the runtime version. The recorded verification file identifies the version used here.

Artifacts: [frozen specification](/Users/scorpion/Desktop/Vela_VNEdge/_research/composite-validation-20260929/spec.json), [trade-level results](/Users/scorpion/Desktop/Vela_VNEdge/_research/composite-validation-20260929/results.json), [runner](/Users/scorpion/Desktop/Vela_VNEdge/_research/composite-validation-20260929/run.mjs), [execution tests](/Users/scorpion/Desktop/Vela_VNEdge/_research/composite-validation-20260929/simulator.test.mjs), [verification hashes](/Users/scorpion/Desktop/Vela_VNEdge/_research/composite-validation-20260929/verification.json).

## Decision

**Do not enable these four composites for live trading on the basis of this run.** S1 and S4 have substantial negative sample evidence at the tested settings. S3 lacks both activity and positive results. S2 remains a sparse research hypothesis; the compression gate has not demonstrated incremental value over the breakout alone.

The existing inverted family7 benchmark was not retested here; it is a different strategy and its training-boundary problems remain. Production code, scanner source files, account state and live configuration were not changed by this test.
