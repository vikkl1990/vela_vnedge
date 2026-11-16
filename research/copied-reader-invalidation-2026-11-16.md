# Copied reader correction and entry-invalidation evaluation — 16 November 2026

## Shipped correction

Band Walk's copied BTCUSD 1h trade 18809 opened a short on “Bearish Band Walk Ended” and lost $3.98. The Pine source and [author explanation](https://www.luxalgo.com/library/indicator/band-walk/) distinguish walk confirmation/pullbacks from ending momentum. The copied path correctly used its configuration; that configuration had never selected the corrected reader.

Add an explicit Band Walk specification: reader 2; Started and Midline Pullback titles keep their original long/short directions; both Ended titles map to none. No allocation is enabled. The new reading automatically has a new policy/evidence identity. Old-reader trades stay unchanged and do not qualify this reading for copying or promotion. Unrelated identities, evidence requirements, margin, risk and execution settings remain unchanged.

An existing UNIUSD 4h shadow position keeps its saved price-management policy. This patch adds no new script-exit interpretation. The missing/non-entry marker is not converted into an exit or reverse entry.

## Preselected invalidation tests

Use all retained, source-bound SIM211 closed ordinary paper/shadow trades for:
- Trend Impulse on INIT/PARTI;
- Donchian on INIT;
- Elliott Wave on ARIA.

Do not mix older fill models, tracker trades or execution-plan experiments. There are 87 selected trades. A common coverage cohort of 72 trades (19 paper, 53 ordinary shadow) remains after excluding incomplete price sampling or unpriceable hypothetical exits.

Three hypotheses, fixed before evaluating outcomes:
1. Exit on the first recorded price beyond the adverse extreme of the closed signal candle, only when that level is between entry and the original stop.
2. Require two such observations at least 30 seconds apart; recovery resets confirmation.
3. After two entry timeframes, exit below −0.25 price R if the running sampled peak never reached +0.2R.

These are research-only sampled-price hypotheses, not author-native exits or tick-perfect strategy replays. A gap greater than two minutes makes the trial unverified. No path after the actual exit is invented.

Hypothetical execution uses verified archived order-book sequences/checksums, a fresh book after 1,500 ms configured latency plus 1,000 ms arrival allowance, and recorded executable size. Stress adds two further seconds and 5 bps adverse price. Full entry costs remain paid; exit fees/GST/Scalper eligibility use each immutable policy; funding is allocated at actual settlement times to the quantity still held. No freed-capital/re-entry benefit is assumed. No complete fill within 30 seconds and before the actual exit means unverified.

Split entry dates at 14 November 2026 00:00 UTC. Archive coverage is incomplete for some older trades; missing books are never replaced with candle fills.

## Results on the common covered cohort

| Scanner / pair | Paper trades | Confirmed candle invalidation: net change | Ordinary shadow change | Decision |
|---|---:|---:|---:|---|
| Donchian / INIT | 13 | −$6.22 / −1.614R | −1.615R over 35 | Reject: cuts two winners; no reduction in full SLs |
| Trend Impulse / INIT | 2 | $0 / 0R | +0.559R over 9 | Insufficient: no priced paper improvement |
| Elliott Wave / ARIA | 4 | +$13.58 / +1.627R | +1.631R over 9 | Promising; insufficient independent opportunities |
| Trend Impulse / PARTI | 0 in common cohort | Not established | No current-model sample | No change |

ARIA's four paper trades improve from approximately −$22.55 to −$8.97. Three full stop-loss exits become earlier losing exits; **all three are still losers**. The one winner is unchanged. Stress still improves the result by $13.77, but all four paper opportunities fall in the later period, and the benefiting shadow trades largely mirror those same opportunities. They cannot be counted as independent confirmation. Five earlier ARIA shadow trades are unchanged.

Across all covered paper cells, confirmed invalidation improves dollars by $7.36 but only +0.013R: earlier trades worsen by $6.22/−1.614R while later trades improve by $13.58/+1.627R. It is not a robust universal fix.

The immediate wick rule worsens covered paper net by $9.39. The two-bar no-follow-through rule improves overall dollars by $2.49 but worsens net R by −0.117R and cuts three winners. On Donchian INIT specifically it worsens net by $4.43 while reducing SL-labelled exits from four to two and increasing losing trades from four to seven. Fewer stop labels alone is not an improvement.

PARTI has just one retained current-model paper trade. Its signal wick is outside the useful entry-to-stop interval, and the no-follow-through evaluation encounters a sample gap. It is excluded from common coverage; no result is inferred.

## Validation and deployment boundary

- 87 actual exit reports independently reproduce their recorded depth prices.
- 90 hypothetical fills independently reprice from retained books, with causal arrival/freshness checks.
- Three Band Walk regression tests cover source/version, preserved genuine signals, copied-only default loading, unchanged risk/allocation, and rejection of old-reader qualification evidence.
- Four research-rule tests cover signal-bar causality, observation order/gaps, short symmetry, confirmation reset and running-peak timing.
- Full server suite: 1,578 passed; typecheck clean.
- Dashboard: 89 tests passed; lint and production build passed.
- Only the Band Walk contract changes trading interpretation. Research rules have no runtime caller and are not activated.
- Paper mode, persisted capital/risk configuration and evidence thresholds remain unchanged.

Private replay inputs, checksums, raw outputs and verification receipts are retained in the task's `work/reader-entry-invalidation-20261116` directory. They are not promotion evidence.
