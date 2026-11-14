# Paper-copy candidate execution audit — 14 November 2026

Snapshot: 2026-11-14T17:49:14.810000+00:00. Window: 2026-11-13T17:49:14.810000+00:00 through 2026-11-14T17:49:14.810000+00:00.
Baseline: deployed commit `8c983ce6187fe04bcd120df1b183846a963ea4ea`.

The cohort is the same 28 candidates identified by the earlier qualification
audit, not a retrospective selection of winners. Copy eligibility is not full
promotion and is re-evaluated as evidence and turnover change.

## Observed conversion

- All 28 have successful scans of their most recent closed timeframe bar.
- 17 sent 78 entry signals through the account decision path.
- Eight cells received nine actual paper entry fills; a separate BNB 4h limit
  remains pending. Pending positions with quantity zero are not fills.
- Seven of the other 11 cells produced signals earlier in the window while their
  evidence or turnover did not yet qualify. Four had no new entry event.
- The current cohort had 13 one-contract sizing refusals, all AKE; 18 burst
  refusals; and five transient exchange-status refusals. These are distinct from
  whole-account counts. Existing position, alignment, regime, cooldown, depth
  and native-stop restrictions remain in force.

## Fill evidence

All nine fills have entry-execution and entry-fill-evidence records. Two are taker
fills from recorded depth (AKE DCA and INIT Standard Error Bands); seven are
explicitly labelled `limit-candle-model` maker fills. Their candle timestamps
start after placement, but they are simulated fills, not proof of exchange queue
priority or partial execution. No fee records, historical fills or evidence flags
were changed by this audit.

## Confirmed fault and correction

The feed log records heartbeat-driven reconnection at 08:01:06 UTC, followed by
a live system-status snapshot at 08:01:09.844. Five fresh entry receipts at
08:01:08.754–08:01:15.961 were completed as rejects during feed/catalogue recovery:
ETH 4h Linear Regression Channel, UNI 1h Reverse RSI, ZEC 1h NSE Elite, and BNB
and LINK 4h Half Trend Channel. Later orders show recovery, but the logs do not
record an exact product-status-ready timestamp for each symbol.

The new paper-only path retains those classes of transient receipt, preserving
the existing maximum 60-second recovery deadline. It rechecks current evidence,
allocation and turnover and executes the existing entry gates with fresh market
observations. Definitive halts, stale receipts, changed source/policy, failed
evidence and risk refusals are not retried into a trade. Exits are independent.

The three new reconnect regression cases fail on the baseline and pass with the
fix. Local validation: 1,452 server tests, 35 dashboard tests, server typecheck,
dashboard build and lint pass. Tests cover restart durability, unchanged receipt
timestamps, no invented limit fills, single fills, disconnects during depth
preparation, lost eligibility, quarantined/changed-source evidence, thin turnover,
retired allocations, fresh prices, risk refusal and live/testnet isolation.

**Limit:** These tests prove decision retention and unchanged admission checks.
They do not prove that all five historical signals would fill, or improve profit.
The audit has not reconstructed the full historical portfolio, depth and status
sequence needed to make that claim. Historical rejects are not replayed live.

## Every candidate

The last column reports actual account decisions plus pre-account copy refusals.
A now-eligible cell may legitimately have failed qualification earlier that day.

| Scanner | Pair / TF | Account entry signals | Filled positions | Pending | Observed decisions |
|---|---|---:|---:|---:|---|
| trend-impulse-channels-zeiierman | AINUSD 15m | 1 | 0 | 0 | 1× rejected:entry alignment 1h EMA21: short requires bearish context |
| dca-grid-15-orders-1-1-step-1-8-tp | AKEUSD 15m | 18 | 1 | 0 | 7× rejected:risk budget too small for one contract; 3× rejected:risk regime: choppy (efficiency 0.04 < 0.1); 2× rejected:risk regime: choppy (efficiency 0.07 < 0.1); 1× opened; 3× rejected:risk regime: choppy (efficiency 0.09 < 0.1); 2× rejected:risk burst: a long entry was already taken in the last 120s; one at a time |
| elliott-wave | ARIAUSD 15m | 0 | 0 | 0 | No new entry event |
| trend-impulse-channels-zeiierman | INITUSD 15m | 0 | 0 | 0 | No new entry event |
| signal-follow-through-ledger | INITUSD 15m | 0 | 0 | 0 | No new entry event |
| money-flow-divergence-zones | SOPHUSD 15m | 5 | 0 | 0 | 2× rejected:risk burst: a long entry was already taken in the last 120s; one at a time; 1× rejected:risk market: fresh depth cost exceeds ceiling (0.283% for $104); 2× rejected:risk burst: a short entry was already taken in the last 120s; one at a time |
| standard-error-bands | INITUSD 15m | 4 | 1 | 0 | 1× rejected:risk re-entry cooldown: INITUSD stopped by standard-error-bands 26 min ago (all scanners wait 60 min); 1× opened; 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time; 1× rejected:risk regime: choppy (efficiency 0.10 < 0.1) |
| horns-pattern-identifier | AKEUSD 15m | 1 | 0 | 0 | 1× rejected:risk budget too small for one contract |
| role-reversal | AKEUSD 15m | 1 | 0 | 0 | 1× rejected:risk budget too small for one contract |
| re-accumulation | AKEUSD 15m | 15 | 0 | 0 | 3× rejected:risk burst: a long entry was already taken in the last 120s; one at a time; 4× rejected:risk budget too small for one contract; 2× rejected:risk regime: choppy (efficiency 0.03 < 0.1); 1× rejected:risk regime: choppy (efficiency 0.08 < 0.1); 1× rejected:risk regime: choppy (efficiency 0.01 < 0.1); 2× rejected:risk regime: choppy (efficiency 0.02 < 0.1); 1× rejected:risk regime: choppy (efficiency 0.05 < 0.1); 1× rejected:risk regime: choppy (efficiency 0.04 < 0.1) |
| indicatorneo-support-resistance-alerts | ZECUSD 1h | 0 | 0 | 0 | Earlier copy holds: 1× mirror held: -0.7R over 5 shadow closes (need > 0R); 1× mirror held: -0.3R over 6 shadow closes (need > 0R) |
| linear-regression-channel-visible-range-volume-profile | ETHUSD 4h | 4 | 1 | 0 | 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time; 1× ignored:already in position; 1× rejected:exchange feed disconnected; 1× opened |
| half-trend-channel | BNBUSD 4h | 6 | 1 | 1 | 1× ignored:entry already pending; 1× pending:resting limit at 617.331, 0 ATR back, for 2 4h bars; 1× rejected:exchange product status unknown or stale; 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time; 1× opened; 1× rejected:reversal: the held position could not be closed |
| reversal-and-breakout-signals | EVAAUSD 1h | 0 | 0 | 0 | Earlier copy holds: 3× mirror held: 2/5 shadow closes; 1× mirror held: 3/5 shadow closes; 1× mirror held: 4/5 shadow closes |
| structure-trend-dashboard | EVAAUSD 1h | 0 | 0 | 0 | Earlier copy holds: 1× mirror held: 4/5 shadow closes |
| half-trend-channel | LINKUSD 4h | 3 | 0 | 0 | 1× rejected:risk max 1 positions on LINKUSD; 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time; 1× rejected:exchange product status unknown or stale |
| nse-elite-strategy-v6-full-system | ZECUSD 1h | 3 | 1 | 0 | 1× ignored:already in position; 1× opened; 1× rejected:exchange product status unknown or stale |
| uhl-adaptive-ma | AAVEUSD 1h | 0 | 0 | 0 | No new entry event |
| bollinger-bands | AAVEUSD 1h | 2 | 1 | 0 | 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time; 1× opened |
| slope-ma-cross-acc-range-filter | ZECUSD 1h | 1 | 0 | 0 | 1× rejected:the scanner's own stop: the account takes only the ATR stop (decision 146) |
| optimized-doji-breakout-strategy-short-only-v6 | UNIUSD 1h | 0 | 0 | 0 | Earlier copy holds: 1× mirror held: 4/5 shadow closes |
| band-walk | BTCUSD 1h | 3 | 2 | 0 | 2× opened; 1× ignored:already in position |
| mitigation-blocks | ETHUSD 1h | 0 | 0 | 0 | Earlier copy holds: 1× mirror held: 3/5 shadow closes; 1× mirror held: 4/5 shadow closes |
| mitigation-blocks | ZECUSD 1h | 3 | 1 | 0 | 1× ignored:already in position; 1× opened; 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time |
| reverse-rsi-signals | UNIUSD 1h | 3 | 0 | 0 | 1× rejected:no fill: price did not come back to 5.4357 within 2 1h bars; 1× rejected:exchange product status unknown or stale; 1× rejected:risk burst: a short entry was already taken in the last 120s; one at a time |
| quant-synthesis-strategy | SOLUSD 1h | 0 | 0 | 0 | Earlier copy holds: 1× mirror held: 4/5 shadow closes |
| aroon-oscillator | BTCUSD 1h | 0 | 0 | 0 | Earlier copy holds: 2× mirror held: 3/5 shadow closes; 1× mirror held: 4/5 shadow closes |
| kalman-volume-filter | AINUSD 15m | 5 | 0 | 0 | 2× rejected:risk regime: choppy (efficiency 0.06 < 0.1); 2× rejected:risk burst: a long entry was already taken in the last 120s; one at a time; 1× rejected:risk regime: choppy (efficiency 0.00 < 0.1) |
