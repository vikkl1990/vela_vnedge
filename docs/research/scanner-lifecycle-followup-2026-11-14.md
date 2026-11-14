# Scanner lifecycle corrections — 14 November 2026

Four separately versioned profiles can now be evaluated without overwriting current readers.
The rollout adds four ETHUSD 15m experimental cells within the user-authorized
increase from 30 to 34 research slots. Account scanner activation, paper mode,
$150 margin, risk ceilings and evidence requirements remain unchanged.

| Profile | Entry treatment | Exit treatment |
| --- | --- | --- |
| Reactive Trail System | Confirmed full-risk long/short alerts; filtered flips excluded | Native stop, TP3 closure, acknowledged BE; reversal waits for actual close |
| Reaction Level Matrix | Scored reaction entries; level-break notices excluded | Native stop, TP3 closure, acknowledged BE; reversal waits for actual close |
| STRAT Trap & VWAP Engine | Full-risk v1.9.0 JSON; setups and filtered triggers excluded | BE amends the stop instead of closing; native SL/TP3 lifecycle |
| Smart Swing VWAP | Polarity-aligned retests only; crosses/flips remain in the unchanged control | Bot-defined exits explicitly retained because author defines none |

Native TP1/TP2 messages are milestones. They do not sell an arbitrary third of a
position. No author marker or historical candle extreme creates a retrospective
fill; stop exits require later executable observations, including latency and fees.

The reversal regression compares the existing caller, which cancels the incoming
entry when a causal close is merely pending, against the new isolated profile.
The correction waits through partial exits, then reprices and rechecks the
replacement. It preserves the 60-second deadline, rejects invalid levels or renewed
risk blocks, and cancels market entry requests on restart without inventing fills.
Existing account and other research cohorts do not acquire this execution version.

The linked JSON records actual Pine runs on 1,000 saved ETHUSD 15m candles,
current/candidate reader counts, prefix causality checks, simulated shadow fills,
restart checks and exclusion from eligible evidence. The generated market path
and depth are synthetic. These are execution-mechanics results, **not a profitability
backtest, exchange queue proof, or permission to promote a profile**.

- [Machine-readable validation](scanner-lifecycle-validation-2026-11-14.json)
- [Reactive Trail author](https://www.tradingview.com/script/73fIFFEV-Reactive-Trail-System-WillyAlgoTrader/)
- [Reaction Level author](https://www.tradingview.com/script/kcyXDIFe-Reaction-Level-Matrix-WillyAlgoTrader/)
- [STRAT Trap author](https://www.tradingview.com/script/ngb1s23R-STRAT-Trap-VWAP-Engine-WillyAlgoTrader/)
- [Smart Swing author](https://www.tradingview.com/script/K0dz3kws-Smart-Swing-VWAP-Zeiierman/)

The author explanations are the previously retained November 13 review receipts;
this work revalidates source outputs and execution. It does not claim a fresh
publication update check. Remaining native target adapters, stop-entry expiry,
external-series and per-pattern invalidation stay pending. Context-only tools
must not be forced into entries.

The completed run passed **287 closed-bar prefix checks**, exercised **35 simulated
entries and 35 completed positions**, and performed **28 restarts**. Zero positions
qualified for promotion evidence. Source entries were 30 Reactive, 40 Reaction,
40 STRAT and 15 Smart Swing retests. Compared with the current readers, entry counts
are unchanged for the first three; their differences are native management and
context handling. Smart Swing's current broad reader sees 51 entries; the retest
profile deliberately tests a narrower author-described condition.

The candle-path mechanics replay uses tape mode and 100ms latency to exercise
ordering deterministically. A separate baseline/corrected regression verifies the
VM's actual candle-entry mode and 1500ms latency. Those production settings are
preserved. Fee/geometry refusals remain visible; no gate was lowered to manufacture
these fills.
