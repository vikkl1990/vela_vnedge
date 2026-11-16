# Entry-guard replay correction — 16 November 2026

**The previous cooldown recommendation is withdrawn.** Its +0.236R mean and positive lower confidence bound do not establish that removing the cooldown improves the bot. PR #35 remains a draft; this study changes no guard, account setting or evidence rule.

## What was wrong

- The old replay clipped stop distance at 3% of price. The bot caps stop loss at 3% of equity by reducing quantity; these are different rules. This changed 44 of the 74 cooldown entries that the old replay scored.
- It gave every entry a market fill and one fixed 9.4-bp fee, ignoring resting/reclaim entries, product commissions, GST, archived policies and entry size.
- It closed unfinished paths at the end of available candles. Sixty of the 74 cooldown paths did not cover seven days; reaching an earlier genuine exit is valid, inventing an end-of-cache close is not.
- Stops filled at their trigger without execution data. Summing independently modelled trade R did not simulate wallet capacity or correlated dollar drawdown.

## Corrected diagnostic

The read-only exporter preserves exact refusal reasons, joins each gated signal to its saved admission context and immutable policy, and requires explicit `FROM` and `AS_OF`. The replay uses production `resolveLevels`, `sizeContracts`, `openPosition`, `applyTrade`, fee and entry-protection functions. Native stops are preserved; the equity risk cap reduces contracts. Fills use the first sampled minute open after admission latency. A crossed stop fills at the observed price plus the policy's costs, never back at the trigger.

This is **minute-open sampling, not exchange replay**. Intraminute events, executable bid/ask/depth, historical leverage selection, funding, future script exits and competing positions are not reproduced. Resting/reclaim orders are unverified rather than converted to market. The $1,000 reference purse is an isolated diagnostic assumption, not reconstructed account equity. Every result is explicitly ineligible for promotion or guard changes.

The original export contained 908 signals (including one cooldown and one burst signal the old script silently skipped). At the same cutoff, the corrected diagnostic gives:

| Group | Signals | Sampled closes | Unverified | Sizing refusals |
| --- | ---: | ---: | ---: | ---: |
| Opened | 443 | 0 | 443 | 0 |
| Cooldown | 75 | 23 | 52 | 0 |
| Burst | 211 | 28 | 178 | 5 |
| Regime: efficiency | 179 | 38 | 122 | 19 |

Of the 75 cooldown signals, 46 have no compatible saved admission context in this export, six need resting/reclaim execution data, and 23 have complete sampled paths to an exit. Those 23 produce **+$82.65 / +0.365R average** under the sampled scenario. This is a selected coverage subset, not proof of a cooldown improvement. The other 52 cannot be assigned a win, loss or zero. The opened group needs entry-fill evidence rather than the rejected-signal snapshot used by this diagnostic, so no comparable baseline or profit lift is reported. Regime labels were checked: these 179 refusals were efficiency-ratio refusals, not every possible regime gate.

`results.txt` contains the corrected aggregate and input hashes. Per-signal data stays outside the repository. No optimistic confidence interval, cluster risk estimate or deployment recommendation is carried forward from the old run.

## Reproduce

```bash
FROM=2026-11-02T15:00:09.063Z AS_OF=2026-11-16T14:45:11.560Z \
  DB=/path/to/vnedge.db node docs/research/entry-guards-2026-11-16/export-signals.mjs > guard-signals.json
DATA_DIR=/path/to/export OUT=/path/to/diagnostic.json REFERENCE_EQUITY=1000 \
  node docs/research/entry-guards-2026-11-16/guards-replay.mjs
```

For new data, `guards-fetch.mjs` reads the version 2 window and fetches closed minute candles only up to its cutoff. Keep the input export, candle hashes, repository commit and output together. The published correction reused the original 27-market candle cache and the same 908 signal IDs.

## What would establish a guard change

A paired chronological replay must use the same observed signal universe, entry-time policies, funding, trade/depth history, latency, maker fills and shared wallet in both arms. Change only the cooldown in the candidate; keep sizing, risk caps, other gates and evidence rules fixed. Report coverage, unresolved entries, net cash profit, stop losses and drawdown for both arms on later dates. The data gaps above must be resolved or excluded equally from both arms before testing significance. Until then, keep the guard unchanged.
