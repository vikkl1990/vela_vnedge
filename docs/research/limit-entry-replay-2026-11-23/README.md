# Limit entry replay (23 November 2026)

**Question.** The account rests a limit order for every 1h and 4h entry: 0.1 ATR back from the signal on 1h, at the signal price on 4h, for two bars. A signal whose order never fills leaves no trade, so nothing in the journal says what those signals would have made. Are the orders that do not fill the strong breakouts (adverse selection), and does resting the order cost more than the better price and the maker fee earn?

**Method.** Every such signal is replayed two ways on 1m candles, through the engine that trades it (`resolveLevels`, `checkRiskVsFees`, `sizeContracts`, `openPosition`, `restingEntryStop`, `applyBar`):

| arm | entry | fee |
|---|---|---|
| limit | the price the engine recorded when it placed the order; filled by the first minute that started after the 1.5 s latency window and before the order expired and **traded through** it (`limitFill: through`); the stop already crossed in the fill minute is charged | maker |
| market | the open of the first minute after the latency window, with the engine's slippage | taker |

Both arms take the same ATR stop from their own entry price, the same fee and risk checks, the same size rule and the same exit engine with today's settings, and run up to 120 hours. A signal whose limit never fills contributes 0 R to the limit arm, as it did in the account. A signal an arm refuses on cost contributes 0 R to that arm. A trade still open at the horizon is censored and the signal is left out.

## Reading rule (fixed in `server/src/research/limitEntryReplay.ts` before the full run)

- **Per signal:** limit R minus market R, net of fees. Standard errors are clustered by signal day. The verdict is "limit costs R" only if the whole 95% interval is below zero, "limit adds R" only if it is above zero, otherwise "no difference detected".
- **Adverse selection:** the market arm's mean R on signals whose limit never filled, minus its mean R on signals that did fill, same interval rule. Positive means the orders that did not fill were the better trades.
- **What it can change:** nothing by itself. Minute candles are sampled prices; this is a diagnostic. A result that the limit costs R is a reason to run a market-entry arm in shadow, not to change the account.

One disclosure: a one-symbol run on AINUSD (281 signals) was read to check the plumbing before the reading rule above was frozen in code. It is part of the full run.

## Data and what is missing

`vm-queries/export-cases.mjs` reads the VM database read-only. The trace row written at placement gives the exact order price ("resting limit at X, 0.1 ATR back, for 2 1h bars") and the time. Which book keeps what decides what can be replayed:

- **Account:** complete. The signals table has the side and the signal bar.
- **Shadow, filled:** the position has the side.
- **Shadow, lapsed:** the book keeps no signal id, and the position is deleted. The side survives only in a `gated_signals` row, which exists for about half of the lapsed orders. The rest cannot be replayed and are excluded, not guessed.

So the shadow book's fill rate is overstated, and the shadow estimate of the cost of unfilled signals rests on the half that can be recovered. The account is the unbiased reading and the shadow book the larger one. Neither is promotion evidence.

## Does the replay reproduce what happened?

For every filled order the replay is compared with the recorded fill (time within two minutes and price within a tick) and its net R with the account's or shadow's net R. See `results.md`.

## Limits

- Minute candles are sampled prices. A minute that traded through the limit may not have filled it (queue position is not modelled), and the order of a minute's high and low is unknown.
- The ATR for trailing is held at its signal-bar value. The reference price is the signal bar's close, as the engine uses when the script gives none.
- Exits use today's `paper` settings, not each trade's own saved policy (there are over four thousand of them). Both arms use the same ones, so the difference is fair; the absolute R is not the historical R.
- The "all (both books)" row counts a signal once per book it reached.
- Entry-time depth and quotes are not replayed. The recorded order price already contains the quote-passivity the engine applied.

## Result

7,906 limit-path signals (account 294, shadow 7,612) over about three weeks (31 Oct to 22 Nov), 68 markets. Full tables in `results.md`, machine-readable in `summary.json`.

**The replay reproduces the books.** Of 7,250 recorded fills, 98.3% were reproduced to the minute and the tick, and the replayed net R correlated 0.93 with the recorded net R (mean -0.053R replayed against -0.047R recorded). The rebuilt ATR does not match the engine's closely, though: only 26% of 1h orders imply an ATR within 10% of the candle ATR (median ratio 1.11). The stop scale therefore differs in many cases, equally in both arms.

**Adverse selection is real and large.** The signals whose limit never fills would have made **+0.38R** at market (account +0.34R, n 37), against **-0.11R** for the signals that did fill (account -0.06R). The orders that lapse are the strong moves.

**It does not show in the total, because they are few.** 8.1% of signals never fill (633 of 7,773; account 12.8%), and the orders that do fill pay a lower fee (average $0.54 against $0.78 on the market arm) and a better price.

| per signal, net R | limit − market | reading |
|---|---:|---|
| account (complete, n 290) | +0.001 ±0.015 | no difference detected |
| shadow (n 7,483) | +0.018 ±0.010 | no difference detected |
| 1h | +0.027 ±0.010 | limit adds R |
| 4h | -0.017 ±0.012 | no difference detected |
| long | +0.026 ±0.008 | limit adds R |
| short | +0.009 ±0.019 | no difference detected |

**Read with the shadow gap in mind.** About 700 lapsed shadow orders could not be replayed (no recoverable side), so the shadow figure is too favourable to the limit. If they had behaved like the ones that could be replayed, the shadow difference would be about -0.017R rather than +0.018R. The honest range is therefore about ±0.02R per signal, with the account, which is complete, at 0.001 ±0.015.

**What this says.** The resting limit is not hurting the account, and it is not helping it either: the price and the maker fee on the 92% that fill pay for the 8% that run away. It also says there is something to capture: a strategy that took the lapsed signals late would be chasing trades that made +0.38R from the signal price, but those trades are worth less from a later entry, and that is not measured here. Any such arm is a new, separately written question, not an edit to this one.

## To run it again

```bash
# on the VM, read-only, capped
systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0 nice -n 19 node --no-warnings export-cases.mjs > export.json
# locally: split `cases` and `paper` out of export.json, then
CASES=cases.json PAPER=paper.json OUT=out CACHE=candles node server/src/cli/limit-entry-replay.ts
```

The runner fetches public 1m candles from Delta (no keys) and caches them, so a stopped run resumes.
