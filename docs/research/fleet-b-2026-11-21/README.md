# Fleet B: a parallel scanner list for the paper account (21 November 2026)

Two operator tools and the evidence behind them. **Nothing here is applied by merging.** The tools are run by hand on the VM,
with the service stopped, and each is a dry run until `--apply` is added.

## What was asked
1. Move Nexus Fusion Engine ML on BTC out of the `willy-majors` tracker and into the shadow book, where the gate can judge it.
2. Run a second, new scanner list in the paper account in parallel with the current fleet, and measure it.

## Why this list, and what to expect
Walk-forward on 19,507 shadow trades (22 Sep to 21 Nov): train 14 days, test the next 7, unit = scanner x market x timeframe, score =
**excess R** (net R minus the average of same-side, same-timeframe shadow trades in the same window, so a long-only or short-only cell
is not credited with the market's drift). A cell's next-week excess was **0.13 x** its previous-week excess: about 87% of an observed
edge is regression to the mean. The list is therefore the best-looking cells *shrunk toward zero*, and the expected gain is small:
about **+0.02R per trade** over a book that is itself slightly negative. It is a tilt to be checked forward, not an edge.

Selection rules, applied in order by `scripts/select.mjs` to the ranked candidates (`scripts/rank.mjs`, `scripts/cands.mjs`):
shadow stage only; script in the manifest and not quarantined; fewer than 30% of the cell's account copy signals die at the fee gate
("stop too tight") or the market gate (judged with 10 or more); at most 2 cells per scanner and 2 per market; the 12 highest by expected
next-week excess. The VM facts the rules read come from `vm-queries/` (read-only queries).

| Cell | Market | Shadow trades 28d | Raw R | Excess R | Expected next excess | Copy signals 14d / opened |
|---|---|---|---|---|---|---|
| Re-accumulation | AKEUSD 15m | 45 | +0.20 | +0.25 | +0.033 | 48 / 10 |
| Aroon | BLESSUSD 15m | 28 | +0.22 | +0.25 | +0.033 | 26 / 9 |
| Machine Learning RSI | AI Classification & Ranking (Zeiierman) | ARIAUSD 15m | 39 | +0.23 | +0.25 | +0.032 | 29 / 13 |
| BB Short DCA Strategy | AINUSD 15m | 62 | +0.23 | +0.23 | +0.030 | 10 / 6 |
| Half-Trend Channel | BNBUSD 4h | 39 | +0.28 | +0.21 | +0.028 | 56 / 11 |
| Smart Money Engine | MUSD 1h | 31 | +0.17 | +0.22 | +0.028 | 4 / 2 |
| Supertrended RSI | GTCUSD 15m | 43 | +0.16 | +0.19 | +0.024 | 0 / None |
| Scalping Ichimoku | INITUSD 15m | 34 | +0.14 | +0.17 | +0.023 | 0 / None |
| Session Levels Pro | GTCUSD 15m | 45 | +0.16 | +0.17 | +0.023 | 0 / None |
| Standard Error Bands | INITUSD 15m | 134 | +0.13 | +0.16 | +0.021 | 74 / 24 |
| MACD | LABUSD 1h | 31 | +0.10 | +0.15 | +0.019 | 0 / None |
| RSI Signals Entries | ARIAUSD 15m | 38 | +0.11 | +0.13 | +0.017 | 12 / 10 |

Excluded, and why:

| Cell | First reason |
|---|---|
| nexus-fusion-engine-ml BTCUSD 15m | stage is tracked, not shadow |
| universal-signal-backtester ZROUSD 15m | 73% of its account copy signals die at the fee gate (stop too tight) |
| cb-lod-reversal ZROUSD 15m | 50% of its account copy signals die at the fee gate (stop too tight) |
| role-reversal AKEUSD 15m | not in the script manifest |
| liquidity-sweep-follow-through-guard BTWUSD 15m | 42% of its account copy signals die at the market gate |
| v-top-v-bottom ZROUSD 15m | 42% of its account copy signals die at the fee gate (stop too tight) |
| chebyshev-filter-divergences BTWUSD 15m | the list is full |
| kaufman-moving-average-adaptive-strategy-by-mkb INITUSD 15m | the list is full |
| alphamojo-supertrend-strategy-ha-with-buffer AVAXUSD 15m | stage is tracked, not shadow |
| structure-trend-dashboard AIOTUSD 15m | 32% of its account copy signals die at the fee gate (stop too tight) |
| smart-swing-vwap-zeiierman AKEUSD 15m | stage is retired, not shadow |
| amit-eth-strategy-tv-strategies AIOTUSD 15m | the list is full |

## What applying it changes in the account
- The 12 cells become explicit operator allocations (enabled, un-hidden, added to the scanner's pairs): the same change the Scanners page
  and promotion make. Four scanners are un-hidden (half-trend-channel, smart-money-engine, supertrended-rsi, session-levels-pro).
- These cells are **already** traded in the account as one-third-size copies of their shadow runs (about 85 opened trades in 14 days).
  Allocated, they stop being copies and trade at the account's normal margin sizing, about three times the size.
- Nothing else changes: the scanner's reading, exit mode and inputs, the entry gates, the risk limits, the burst rule and every other cell.
- The incubator reads the new allocations as `live` cells when the service starts.

## Run it (on the VM)
```bash
sudo systemctl stop vnedge
cd /opt/vnedge
node --no-warnings=ExperimentalWarning ops/enable-fleet-b.ts            # dry run: prints what would change
node --no-warnings=ExperimentalWarning ops/enable-fleet-b.ts --apply    # backs up config.json, applies, writes data/fleet-b.json
node --no-warnings=ExperimentalWarning ops/start-judging-tracked.ts     # dry run: Nexus BTC 15m tracked -> shadow
node --no-warnings=ExperimentalWarning ops/start-judging-tracked.ts --apply
sudo systemctl start vnedge
```
`start-judging-tracked.ts` takes `scanner:SYMBOL:tf` arguments for other cells; the default is `nexus-fusion-engine-ml:BTCUSD:15m`.
It moves only cells that are `tracked` and refuses the whole run otherwise. The judging window starts at the move; what the cell traded
while tracked stays watch-only.

**Undo:** `node ops/enable-fleet-b.ts --release --apply` removes exactly the cells it added and puts back what it enabled or un-hid.
The config backup is `data/config.json.before-fleet-b-<time>`.

## How it will be judged (fixed now, before any result)
`node ops/score-fleet-b.ts` compares the list's account trades with all other account trades over the same days, on excess R against the
same-side, same-timeframe shadow average since the list went in, with a day-clustered standard error.
- No verdict before **14 days and 60 fleet trades**.
- After that: **ahead** or **behind** only when the 95% interval of the difference excludes zero; otherwise **no difference detected**.
- If it is behind or flat after 28 days, release it. Being ahead is not a reason to enlarge it: the 13% persistence applies to this list too.

## Reproducing the research
`vm-queries/trades-120d.mjs`, `live-pairs.mjs` and `candidate-state.mjs` are read-only queries to run on the VM through the usual
`ssh ... 'cat > /tmp/x.mjs && node --no-warnings /tmp/x.mjs'` pattern; save their output as `trades120.json`, `live.json` and
`cands-vm.json`, then run `scripts/walkfwd.mjs`, `scripts/rank.mjs`, `scripts/cands.mjs` and `scripts/select.mjs` next to them.

## Limits
- One 61-day window, six walk-forward splits, windows that overlap. The 0.13 slope has its own uncertainty.
- Shadow R and account R share a fill model but not exact fills; several of these cells have few account trades of their own.
- Excess R removes same-side drift only. It does not remove everything that moves a market together.
