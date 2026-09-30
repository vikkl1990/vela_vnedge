# Next build phase — proposed 2026-09-30

## Where the evidence stands after four days of journal

| | value |
|---|---|
| Live paper trades closed | 58 (27–30 Sep) |
| Net after fees | +$22 on $1,000; fees $125 = 85% of gross |
| Expectancy | −0.04R per trade; 26 trail exits +0.39R vs 19 stops −0.94R |
| Equity vs peak | 1,022 vs 1,163, 12% below (alert line 10%) |
| Where the R came from | AI Predictive Flow +4.4R over 18 trades; the other ten scanners net −2.9R |
| Shadow book, 14 days | 451 trades across 38 scanners, −0.12R per trade; one pair (Bollinger simple on AIN 15m) above PF 1.2 with 20+ trades |
| Screens and surveys | Everything positive in both halves sits on 4h; 15m and 1h lose on every author family surveyed |

The machinery is built: gate, incubator with automatic promotion and operator demotion, exits with
lock and trail, exchange path with ledger and recovery, runtime upgraded, library at 3,033 scripts.
What is thin is the edge itself, and the fleet trades on the timeframe where the evidence is worst.

## Phase 4: evidence-first fleet (two weeks)

1. **Re-time the fleet to where it pays.** The proposal from the fee and ATR study stands:
   keep 15m only for pairs whose live journal is positive (AI Predictive Flow's), move the
   halves-positive pairs to 4h, drop the rest to shadow. Fewer trades, a fraction of the fee
   drag, and every live trade backed by evidence on its own timeframe. Needs the `(scanner,
   market, timeframe)` deployment tuple from the architecture review, since the config is still
   per scanner. Two days.
2. **Verdicts with confidence, not averages.** The incubator gate, the "not paying" rule and the
   dashboard's per-scanner numbers use plain averages on 20–60 trades. Replace with a lower
   confidence bound on E[R] (bootstrap or Wilson on the win rate with the R distribution), and
   promote or demote on that bound. This is what turns "few days of journal" into decisions that
   survive a bad Sunday. Two days.
3. **Cost-of-edge admission.** Fees plus book cost are known per market (decision 56b). Admit a
   pair only when its shadow gross R per trade exceeds that cost by a margin; show the margin
   next to every pair. The book is losing to costs, not to direction. One day.
4. **A composite strategy layer.** The one candidate with positive second halves on three
   markets is a composite (Liquidity Entry Zones + family7, 4h). Build the small thing the review
   asked for: a strategy spec with typed components, one intent per strategy and market, run in
   the shadow book like any scanner. Fix the family lab's holdout leak first (indicator test,
   diversity and eligibility on the first half only; a frozen consensus threshold), then retest
   that candidate cleanly and put it in shadow. Four days.
5. **Shadow book in R only.** The shadow purse is $10M by design so no trade is ever skipped for
   margin; its dollar figures (a trade at $35M notional) mislead anyone reading the page. Show R
   and trade counts, hide dollars. Half a day.
6. **A written go-live rule.** Going live is currently a feeling. Make it a rule the dashboard
   evaluates: N live paper trades, lower-bound E[R] above zero after costs, no halt breach in the
   window, alerts configured. Until it is green, the exchange keys stay unset. Half a day.

Not in this phase: more scanners (the library is not the constraint), wider stops or looser trails
(measured, no help), any change to execution or the production rule.

## What the operator decides

- "re-time the fleet" (item 1 changes what trades live).
- Whether the go-live rule's thresholds are the ones above.
