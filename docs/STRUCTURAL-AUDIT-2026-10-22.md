# Structural audit — 22 October 2026

Read-only pass over the VM database (`/opt/vnedge/data/vnedge.db`, 18:30 UTC), the live config, and Delta India's
public ticker feed. Account book since the 5 October reset; shadow book over the same period. The question asked was
not "which bug" but "what is structurally wrong"; the first section answers it, the rest is the evidence.

## The gap in one paragraph

The bot is a search engine over other people's indicators, and its selection threshold sits below the noise floor
of what it measures. It screens ~2,660 scripts × ~85 markets × 3 timeframes on 20–40 trades, promotes at 30 trades
with a mean of +0.1R, and the standard error of a 30-trade mean is ±0.15R. So it reliably finds cells that *look*
good, promotes them, and watches them regress: the cells it promoted carried +0.144R/trade in shadow before promotion
and did +0.070R/trade in the account afterwards, while the shadow book on the same cells over the same period did
−0.028R. Everything downstream then works on a signal stream with no proven edge: an exit structure that caps the
average winner at 0.54R against a 0.98R loser (break-even win rate 64.5%, actual 61%), eight concurrent alt positions
that are one BTC-beta bet (daily P&L correlates 0.54 with BTC's daily move), and a live roster that sits on Delta's
illiquid tail where the 2-bp paper fill is fiction. The money the account has made (+$182) is three manual exits
(+$234); the bot's own 368 trades net −$51, t = −1.0. The halts and the 50% scaling are not the problem; they are the
only things that have worked.

## 1. The books

| | trades | net | R/trade | win | PF | fees / gross | avg win | avg loss |
|---|---|---|---|---|---|---|---|---|
| Account, all | 371 | +$182 | −0.026 | 61% | 1.09 | 60% | $9.97 | $14.45 |
| Account, bot only (ex 3 manual exits) | 368 | −$51 | −0.040 | 61% | — | — | — | — |
| Shadow, all | 2,665 | — | +0.052 | 60% | 1.15 | 60% | — | — |
| Shadow 15m | 1,990 | — | +0.052 | 61% | 1.15 | 63% | | |
| Shadow 1h | 354 | — | −0.042 | 60% | 0.88 | — | | |
| Shadow 4h | 321 | — | +0.152 | 58% | 1.44 | 18% | | |

Equity 1,182 against a 1,498 peak: 21.8% drawdown in 17 trading days. One day (20 October, +$343) is the whole
profit; the worst five days sum to −$312.

t-statistics: account −0.61 (bot-only −1.00); shadow +2.53; shadow 4h +2.01. At the account's own mean it would
take ~4,000 trades to establish a sign. At the shadow 15m mean (+0.052R) it takes ~1,600 — and fees are 0.045R a
trade, so that edge is the fee.

## 2. Selection below the noise floor

- Funnel since the reset: 505 candidate→shadow, 27 shadow→live, 34 live→demote-proposed, 13 live→retired; 100
  different scanners have traded the account in 17 days. Live now: 27 pairs on 14 markets. Shadow: 693 pairs on 85
  markets (cap 800).
- Gate: `minTrades 30`, `minAvgR 0.1`, `minPfR 1.2`. σ(R) ≈ 0.8–1.1, so SE at n = 30 is 0.15–0.20R. The gate cannot
  tell +0.1R from zero; it passes the upper tail of noise by construction.
- Measured regression on the 89 promoted cells with a shadow history: +0.144R/trade before promotion (522 trades) →
  +0.070R in the account after (183 trades); shadow-before beat account-after in 52 of 89 cells.
- The other 188 account trades came from 81 cells with **no shadow record at all** before their first account trade
  (the explicit scanner list and early mirrors): −0.119R/trade, −$303. The evidence discipline exists but a third of
  the book bypasses it.

## 3. Payoff arithmetic

Exit reasons, account: trail 221 trades at +0.54R; SL 134 at −0.98R; script/reversal 11 at −0.26R; manual 3 at +1.75R.
Peak R reached: 148 trades (40%) never saw 0.5R and lost $2,061; 193 (52%) reached 0.5–1R and all closed as winners
at +0.45R; only 30 of 371 (8%) ever reached 1R; two reached 3R.

With a 0.54R winner and a 0.98R loser the break-even hit rate is 64.5%. The book runs at 61%. Decision 175 showed the
10% give-back beats wider give-backs — true, but it is the best point on a curve that cannot pay more than ~0.5R.
The shadow 4h book, with its ladder reaching TP3 (+4.68R on 56 exits), is the only cut whose payoff is > 1.

Hold time says the same thing: trades closed inside an hour are +0.056R (256 trades); 1–4 h is −0.262R (85). The
structure is a bet that price moves 0.5R before 1R against it on a 15m bar; after fees that is a coin with a
house edge.

## 4. One bet, eight times

- `risk.maxBetaExposurePct` is 0 (off). Net long-minus-short exposure at entry reached +4 on 18 entries and ±3 on 39;
  70 of 371 entries were opened with three or more same-side positions already open.
- Daily P&L vs BTC daily return: correlation **+0.54** (17 days); vs |BTC move| −0.38. Longs +$363 (PF 1.37), shorts
  −$180 (PF 0.84). 22 October: BTC −3.5%, book −$211, the daily halt.
- Max concurrent 8 at $16.6 risk each: 9% of equity at risk at once, on one factor. The daily loss limit is the only
  correlation control, and it acts after the loss.

## 5. Where the roster sits on Delta India

237 USD perpetuals; 96% of turnover in the top ten (BTC $1,038M, XAUT $897M, ETH $671M, PAXG $185M, SOL $131M,
AKE $39M, XRP $16M…).

Live markets by 24h turnover: BTC (2 pairs; account 5 trades −$6; shadow −0.186R), ETH (2; 4 trades −$10), ZEC #9
$11M (3; +$196), UNI #11 (3; −$17), then **ten markets under $2M a day**: BCH, VVV, STRK ($1.35M, 61 account
trades), FIL, GRIFFAIN ($0.63M), NEAR, MUBARAK ($0.34M, **5 live pairs**), AIN ($0.26M), AIOT ($0.13M),
1000PEPE ($0.10M).

Nothing live on SOL, XRP, AKE, DOGE, AAVE; gold (XAUT/PAXG, the #2 and #4 markets) excluded by `cryptoOnly`. The
market gate requires $50k/day; incubator admission $1M; the book-cost probe is $2,500. The account's 20× tier puts
$3,000 of notional on a trade — 1–3% of a day's volume on five of the live markets — against a paper fill model of
2 bps slippage. The paper record on those markets is not a forecast of a live fill.

## 6. Smaller drags (real, not structural)

- Entry delay after bar close since 19 Oct: median 35.5 s, p90 86.5 s (was ~60 s median). 4% of a 15m bar.
- Fees 0.045R per trade; `minRiskFeeRatio 6` holds, so stops are not fee-starved. The fee is simply the size of the
  measured edge.
- 20× "strong record" tier: 39 trades, −$19, PF 0.93. Record does not predict; it is the same regression as §2.
- Weekday/hour cuts are noise at this sample size and should not be acted on.

## What would close the gap (in order)

1. **Raise the evidence bar above noise.** Promote on a t-statistic (≥ 2 on mean R, net of fees), not on a mean at
   n = 30. Shrink cell means toward the scanner-family mean (a hierarchical estimate) so one lucky market cannot
   carry a cell. Expect far fewer promotions; that is the point.
2. **Nothing trades the account without a record.** Route the explicit scanner list through the same gate; until it
   passes, it is shadow. That alone removes the −$303 cohort.
3. **Cap net directional exposure.** Turn `maxBetaExposurePct` on (net long-minus-short ≤ 2 positions, or hedge net
   delta with BTC) and treat correlated alts as one position for sizing.
4. **Fix the payoff before tuning the trail.** Move live weight to 4h/1h where the ladder can reach 2–4R; on 15m,
   require either a measured hit rate above 65% or a stop tight enough that 0.5R is worth taking after fees.
5. **Liquidity floor for live.** ≥ $5M/24h to be live, book-cost probe at the actual intended notional (the 20× tier),
   slippage from the probed book instead of a constant. Shift shadow and live attention to the top-20 markets where
   the fills will exist.

Items 2, 3 and 5 are configuration and gate changes. Item 1 is a change to the incubator's promotion statistic.
Item 4 is a design decision for the user.

## Addendum, 23 October: what was done

Items 1, 2 and 5 are in as decision 177 (`gate.minT` 2, `mirror.minTrades` 5 / `minNetR` 0 / `minTurnoverUsd` $2M,
`gate.minTurnoverUsd` $5M). Item 3 was replayed and rejected: a net-side cap removed the trend-day winners along with
the losers (±2: 38 trades, +$73 given up). Item 4 (timeframe weight and payoff) remains the user's decision.
