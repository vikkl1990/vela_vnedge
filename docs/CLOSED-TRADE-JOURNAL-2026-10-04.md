# Closed trade journal review — 4 October 2026

The account paper book is losing despite a 63.3% win rate. Its 79 closed trades earned $47.42 before fees and lost $130.22 after $177.64 of fees. The main observed pattern is many small trailing-exit wins offset by fewer, much larger stop losses. This does not establish that the scanners are dead: most scanner samples are small, and nearly all trades precede the hourly fleet history needed for the current evaluation.

## Scope and provenance

- Consistent SQLite read transaction on `/opt/vnedge/data/vnedge.db` on the VM; snapshot at **2026-10-04 00:57:10 IST** (2026-10-03 19:27:10 UTC).
- VM source revision inspected: `206f925cd55773235a043a468982d065c8d1241a`; execution mode: **paper**.
- Primary population: `bt=0`, `status=closed`, 79 positions; no open account positions in this snapshot. Shadow book (`bt=2`) is evaluated separately.
- Earliest account entry: 28 September 00:00:03 IST. Latest close: **3 October 12:05:39 IST**. There are no 4 October closes in this snapshot.
- Net = `realized_pnl - fees`; R = net / stored `risk_amount`, consistent with the engine's accounting. Realized P&L can include funding. These are simulated ledger dollars, not exchange profits.
- Changing sizing/configuration makes this a mixed historical cohort. No account-return percentage is inferred without reconciling equity and resets.
- Evidence: [snapshot](../_research/closed-journal-20261004/snapshot.json), [computed results and all 79 closed trades](../_research/closed-journal-20261004/analysis.json), [reproducible analysis](../_research/closed-journal-20261004/analyze.py). Run `python3 _research/closed-journal-20261004/analyze.py` from the repo root.

## Results

| Metric | Closed account paper book |
|---|---:|
| Trades / winners / losers | 79 / 50 / 29 |
| Win rate | 63.3% |
| Pre-fee P&L | +$47.42 |
| Fees | $177.64 |
| Net P&L | **−$130.22** |
| Net profit factor | 0.795 |
| Mean net R / sum net R | −0.099 / −7.784 |
| Average winner | +$10.11 / +0.382R |
| Average loser | −$21.92 / −0.928R |
| Latest 20 closes | −$166.08; 11 winners; mean −0.291R |

At the observed R payoff, break-even would require approximately **70.8% wins**, versus 63.3% observed. This is a descriptive calculation, not a forecast. No individual pre-fee-positive trade flipped negative after fees; the aggregate result flipped because costs consumed the small total surplus.

| Exit reason | Trades | Net P&L | Mean net R |
|---|---:|---:|---:|
| trail | 48 | +$459.27 | +0.363 |
| be | 2 | +$46.06 | +0.854 |
| sl | 28 | −$625.59 | −0.949 |
| reversal | 1 | −$9.97 | −0.323 |

All 28 stopped trades recorded peak R below 0.5. Moving a trail that activates at 0.5R cannot rescue those trades unless its activation changes too. The trail winners recorded average peak R of about 0.897 but realized only 0.363R net. That gap includes execution, costs and price-path effects; it is not an estimate of recoverable profit.

Do not infer that a tighter trail or SafeZone fixes this. Decision 67 already compared exit policies on 66 reconstructed paths and found no second-half winner. The existing exit-lab/shadow gate remains necessary.

## Scanner interpretation

AI Predictive Flow contributed **+$76.45**; the other scanners combined contributed **−$206.67**. This is the clearest positive contribution in this sample, but 26 trades in a narrow period do not prove a durable edge. Adaptive ATR% Extension's three SOL trades all lost, totaling −$71.89. Scanner and symbol are confounded there: these trades cannot independently establish that SOL is the problem.

Dollar and R rankings can disagree because position sizing varies. For example, Liquidity Trail Matrix loses dollars but has positive mean R. Use both measures and compare consistent cohorts.

| Scanner | Closes | Wins | Net P&L | Mean net R |
|---|---:|---:|---:|---:|
| AI Predictive Flow (Zeiierman) | 26 | 20 | $+76.45 | +0.122 |
| Dynamic Trend Bands & Anchored VWAP Signals | 1 | 1 | $+10.27 | +0.333 |
| Pivot Channel Breaks | 5 | 4 | $+8.47 | +0.010 |
| Kinetic Momentum Vectors | 3 | 2 | $+7.71 | +0.073 |
| Liquidity Trail Matrix | 4 | 3 | $-1.93 | +0.052 |
| Session Killzones & Breakouts | 3 | 2 | $-7.53 | -0.049 |
| Smart Swing VWAP (Zeiierman) | 10 | 7 | $-8.62 | -0.044 |
| High Volume Breakout Targets | 2 | 1 | $-18.53 | -0.377 |
| Machine Learning RSI / AI Classification & Ranking (Zeiierman) | 7 | 3 | $-19.59 | -0.427 |
| Volume SuperTrend AI (Expo) | 11 | 6 | $-20.63 | -0.175 |
| Smart Money Breakout Signals | 1 | 0 | $-26.56 | -0.953 |
| SuperTrend Cluster (Zeiierman) | 2 | 1 | $-26.57 | -0.433 |
| Mirage Liquidity Sweep Pro | 1 | 0 | $-31.26 | -0.993 |
| Adaptive ATR% Extension Scanner | 3 | 0 | $-71.89 | -0.898 |

## What the journal cannot yet answer

- **Current hourly fleet:** 78 closed trades are 15m (−$131.62); only one is 1h (+$1.40). The lone hourly close is not enough to evaluate the retimed fleet and should not be presented as its post-deployment performance.
- **Regime filters:** only 13 trades have `er20` and `chop14`; none have `adx14` or `day_range_used`. Missing features must not be treated as zero. ADX/ADR splits cannot be measured from these closes yet.
- **All scanner families:** these closes cover 14 scanners. Scanners without closed account trades may have no events, rejected events, shadow-only trades, unsupported extraction, or simply insufficient opportunity. Account P&L alone cannot distinguish those cases.
- **Shadow equivalence:** 618 closed shadow trades have 43.7% wins, mean −0.092R and profit factor 0.858; 10 remain open. Their experimental sizing and execution/admission differences prevent combining them with the account book.

## Journal integrity and corrections

**Accounting checks pass for all 79 positions.** Embedded-fill fees match position fees, embedded-fill P&L matches position realized P&L, order fees match position fees, and summed order exit quantity matches original quantity. These are reconciliation checks, not proof of realistic market execution.

**Reference-price attribution needs repair.** Eighteen order rows have reference prices differing by more than 20% from the fill price; this threshold is a diagnostic flag, not proof of an execution error. For example, EVAA position #768 closed around 0.770086 while its order reference is 9.158, despite bid/ask near 0.7692/0.7695. Funding rows are included in the flagged count and should not be treated as normal executions.

The inspected VM code contains a concrete leakage path: `server/src/paper/engine.ts:291` sets engine-wide `fillContext` before level, fee, risk, size and exposure checks that can return early. `persistFill` at lines 778–787 consumes and clears that shared context for whichever position fills next. A rejected entry can therefore leave a reference/source for an unrelated later fill. The observed anomalies are consistent with this path; exact historical causation was not replayed. This finding undermines slippage attribution, not the reconciled booked P&L.

Recommended correction: pass reference/source explicitly with each fill, avoid shared mutable context, and give funding its own metadata treatment. Regression coverage should reject an entry for symbol A and then exit symbol B, asserting that B never inherits A's reference/source. Quote freshness and whether a quote actually priced the fill should also be recorded explicitly. Historical malformed references should be marked invalid rather than guessed.

## Prioritized follow-up

1. Correct fill provenance before using the journal to calibrate slippage; preserve the original snapshot.
2. Evaluate closes by entry-time configuration, scanner, market and timeframe. Record a configuration/source version per position so old 15m results cannot be mistaken for current 1h evidence.
3. For stopped trades that never reached 0.5R, inspect entry quality, stop placement, costs and market conditions in replay. Do not change live gates from this small retrospective sample.
4. Continue the existing exit-lab holdout and shadow evaluation; do not promote an exit policy just because trail winners surrendered part of their recorded peak.
5. Accumulate closed positions with ADX/ADR coverage and fix the family-lab holdout before choosing family composites. Report scanner opportunity, extracted events, gate rejections, entries and closes separately to diagnose why apparently dead scanners are inactive.

This review read the VM and created local evidence/report files. It did not alter trading settings, application code, orders or VM data.

## Latest ten closes (IST)

| ID | Closed | Scanner | Market / TF | Exit | Net | Net R |
|---|---|---|---|---|---:|---:|
| 694 | 2026-10-01 05:50:10 | AI Predictive Flow (Zeiierman) | UNIUSD / 15m | trail | $+4.11 | +0.208 |
| 703 | 2026-10-01 09:52:02 | Smart Swing VWAP (Zeiierman) | LINKUSD / 15m | trail | $+3.45 | +0.219 |
| 712 | 2026-10-01 20:13:31 | Kinetic Momentum Vectors | UNIUSD / 15m | sl | $-25.85 | -0.950 |
| 717 | 2026-10-02 00:06:04 | Smart Swing VWAP (Zeiierman) | LINKUSD / 15m | sl | $-19.53 | -0.977 |
| 730 | 2026-10-02 10:01:56 | Kinetic Momentum Vectors | UNIUSD / 15m | trail | $+5.50 | +0.262 |
| 732 | 2026-10-02 10:28:33 | Pivot Channel Breaks | ZECUSD / 15m | trail | $+9.00 | +0.345 |
| 734 | 2026-10-02 11:09:41 | High Volume Breakout Targets | ZECUSD / 15m | sl | $-25.57 | -0.983 |
| 747 | 2026-10-02 22:13:36 | SuperTrend Cluster (Zeiierman) | ETHUSD / 15m | trail | $+1.41 | +0.097 |
| 758 | 2026-10-03 07:40:12 | AI Predictive Flow (Zeiierman) | UNIUSD / 15m | sl | $-16.03 | -0.903 |
| 768 | 2026-10-03 12:05:39 | Liquidity Trail Matrix | EVAAUSD / 1h | trail | $+1.40 | +0.323 |
