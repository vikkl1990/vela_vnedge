# Reference: the AITOS Trade flow, read against VNEdge (16 October 2026)

The operator named https://aitostrade.com/#flow as the shape the bot should grow into: a reference
for the *flow*, not a product to copy. AITOS trades Indian index options and MCX commodities; VNEdge
trades crypto perpetuals on Delta India. What transfers is the operating model, the staging of a
signal, the gate center, and the promise. What does not is the instrument-specific intelligence
(option chains, FII/DII, expiry plays), which has crypto equivalents named below.

## The operating model, step by step

| AITOS step | VNEdge today | Gap |
|---|---|---|
| 01 Input: live data and chains | Delta candles (1m…1d), trades, mark, funding, top of book, 24h turnover | no open interest, no liquidation feed, no cross-market cues |
| 02 Analyze: AI and quant | 2,628 Pine scripts under PineTS, a learned win model (advisory) | nothing reads the market as a whole; every reading is one script on one market |
| 03 Scan: multi-timeframe context | scanners per cell; the Frames view (decision 97) shows a market across timeframes | no cross-timeframe *rule* at entry; the trend gate is one higher-frame EMA |
| 04 Select: strategy selection | the incubator picks cells by evidence (screen, shadow, delivery) | selection is by cell, never by regime or by what the day looks like |
| 05 Control: risk validation | kill switch, daily and weekly loss, cooldown, burst, re-entry, market gate, stop-versus-cost, size cap, liquidation-aware leverage | the gates exist; they are not shown as one list with live progress |
| 06 Evaluate: paper and shadow | paper account, shadow book, both quoted and charged alike | the shadow book is over its cap; discovery screens one timeframe |
| 07 Promote: evidence gate | screen on a holdout, 30 shadow trades over 14 days, PF 1.2, positive weeks, delivery retirement | promotion is slow by design; fine |
| 08 Authorize: separately approved live | demo host only; production double-locked (`allowProduction` and `DELTA_LIVE=1`); market orders only | keep exactly as is |

The spine is already VNEdge's spine. The difference is what the reference puts *in front* of the
spine (context) and *around* it (staging and the gate center).

## Four groups, what transfers

**See the market.** AITOS: a pulse bar (global bias, India mood, VIX, flows, the next event) and
six intel agents. The crypto equivalents are real and cheap: BTC and ETH trend on 4h and 1d as
the "global bias"; the day's realised range against its ATR as the "mood"; funding across the
fleet's markets (crowded longs or shorts); open interest change per market from Delta's tickers;
the largest liquidation clusters; the session (Asia, London, New York) and the next scheduled
event (FOMC, CPI, large option expiries) from a static calendar. VNEdge has the funding feed
already and none of the rest. This is the one group that would change *which* trades are taken,
because decision 96 showed the only filter that improves most cells is a regime filter.

**Read the chart.** AITOS: order blocks, FVG, BOS/CHOCH, OI flow, liquidity pools, EMA/VWAP. VNEdge
has these as *scripts* (hundreds of them), which is a strength: the reading is not one model's
opinion but a library judged on evidence. What is missing is the reading as *context* rather
than as a signal: a market's dealing range, its last BOS, its nearest liquidity pool, shown on the
chart and available to the gate, independent of which scanner fired.

**Decide.** AITOS: a staged pipeline WATCH → EARLY WARNING → BUILDING → CONFIRMED → ENTRY READY,
each stage explained. VNEdge's signal is binary: an entry event, then a verdict (opened or a
rejection reason). The stages are what the Signals page's buckets are groping toward. A staged
signal would let a cell say "building" on the 1h while the 15m entry has not fired, and let the
operator watch a setup form instead of reading a log of verdicts. The reason at every step is
already VNEdge's habit (the funnel, the rejection buckets, the decisions log).

**Stay in control.** AITOS: a risk engine, a Gate Center with live progress, a health check with
auto-heal, an assistant. VNEdge has the risk engine and, since decision 91, the attention line, the
memory watchdog, the job markers; the go-live rule on Analytics is a gate center in miniature. The
Gate Center as one page, every gate between a setup and real money with its current state and
next step, is the most direct lift from the reference and needs no new data.

## What does not transfer

Option chains, per-strike OI, expiry plays, FII/DII, MCX, voice. Their crypto counterparts are in
"See the market" above; the rest has no equivalent and should not be imitated.

## The order of work this suggests

1. **Gate Center** on the dashboard: every gate (kill switch, loss limits, cooldown, burst,
   re-entry, market gate, stop-versus-cost, size, liquidation headroom, regime, go-live rule) as one
   list with its live state and what would clear it. Data exists; one page.
2. **Market context bar**: BTC/ETH bias on 4h and 1d, the fleet's funding skew, session, next
   event. Funding exists; OI needs one ticker field; the calendar is a file.
3. **Staged signals**: a cell's state (watch, building, confirmed, entry ready, in trade, exit)
   derived from the higher-frame trend, the regime gate and the scanner's own alert, with the
   reason at each step; the Signals page shows stages, not only verdicts.
4. **Context the gate can use**: a regime verdict per market per day (trending, ranging, dead)
   from efficiency ratio and range-versus-ATR, replacing the single `minEr` number, and entries
   that need the regime to agree with the signal's side.
5. **Health check and self-heal** as a button: feeds, candles, workers, the nightly job, the
   shadow book, with the restarts the monitor already knows how to do.

Everything above sits on top of the cost truth of decision 96: no context layer rescues a cell
whose stop cannot pay its round trip, so the two Settings changes named there come first.
