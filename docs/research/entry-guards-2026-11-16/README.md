# What the three entry guards of PR #35 actually refused (16 November 2026)

PR #35 proposed switching off the burst guard, the re-entry cooldown and the whipsaw gate because aggregate shadow averages showed no difference. A review objected that means of R do not show correlated drawdown and that the position cap the PR leaned on (`maxPositionsTotal`) is now 0. This replays the entries the guards really refused.

## Method
`export-signals.mjs` (VM, read-only): every entry signal of the last 14 days that was opened (443) or refused by the burst guard (210), the re-entry cooldown (74) or the regime gate (179). `guards-fetch.mjs` pulls Delta India 1-minute candles for the 27 markets. `guards-replay.mjs` replays each signal from the next minute's open under the account's recipe: stop = max(1.5 ATR14 of the signal timeframe, the fee floor), capped at 3%; trail arming at 0.5R, keep 90/92/94%, TP 6R; fee 9.4 bp a round trip; 7-day horizon. Intervals are bootstrapped by calendar day.

## Result (`results.txt`)
| Group | n | avg R | 95% interval |
|---|---|---|---|
| Taken | 443 | +0.049 | -0.043 to +0.128 |
| Burst-refused | 210 | +0.088 | -0.009 to +0.188 |
| Cooldown-refused | 74 | +0.236 | +0.003 to +0.537 |
| Regime-refused | 179 | +0.022 | -0.134 to +0.173 (long +0.145, short -0.149) |

- **On average the refused entries were no worse than the taken ones.** That agrees with PR #35's measurement.
- **Correlation is the real cost of the burst guard.** 110 same-side clusters (two or more entries within 120 s, across markets) hold 296 entries, the largest has 6. Taking every entry, a cluster's summed R has a 5th percentile of -2.8R and a worst of -5.2R; with only the entries the account actually took, the same clusters' 5th percentile is -1.1R and the worst -1.1R. Mean R is positive, the tail is five times heavier.
- **The cap that bounded that tail is gone.** `maxPositionsTotal` is 0 on the VM, so only one position a symbol, four a scanner and the 15% daily loss limit remain.
- The regime gate refused entries that average about zero (neutral -0.002): switching it off adds trades and fees without adding R.

## Limits
14 days; the replay is optimistic (no stop slippage, 1-minute bars) but equally so for both groups; entry price is the next minute's open because 91% of signal rows carry no price; refused entries in live cells have no shadow twin, so the replay stands in for it.

## Reading
Cooldown relaxation is supported (small sample, interval just above zero). Burst removal is not: its mean is fine and its tail is not, and nothing else limits the tail. Regime removal changes nothing worth the risk. #35 should not apply all three.
