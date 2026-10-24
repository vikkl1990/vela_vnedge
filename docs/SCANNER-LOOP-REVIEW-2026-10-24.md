# Scanner and loop review — 24 October 2026

Three independent read-only reviews of the pipeline (the bar-close → run → signal → entry loop; the shadow waves and
incubator timers; the Pine pool, market gate and feed), each verifying its findings against the code. Status after
decision 184.

## Fixed in decision 184

| # | gap | where | effect before the fix |
|---|---|---|---|
| 1 | Pairs running under an `admit.reserve` reservation counted against `maxShadow` | `incubator/cycle.ts` admit | with 1,010 pairs in the book the general pool had 0 free slots: no 15m/1h candidate could be admitted (the nightly's own log: "1010 brewing, 0 free slots") |
| 2 | A pair back from the account was retired as stale / "not proven" on its first hunt | `cycle.ts` stale rule, `returningGate` | the shadow runner does not trade a live cell, so its last shadow trade predated the whole live stint; decision 171's "answer the demotion in shadow" never got the time |
| 3 | A hand screen wrote the nightly's `incubator.lastRun` | `cli/incubate.ts` | masked a died nightly, let the screen queue start over a running nightly, fired an extra hunt |
| 4 | `lastDemotion` read a stale, rejected proposal's reason for an operator's demotion | `incubator/store.ts` | a pair demoted by hand after a rejected silent proposal was held for a mirrored signal that could never come |
| 5 | The silent / cost-starved answer depended on the mirror | `cycle.ts` demotionAnswered | with the mirror off, such a demotion was a one-way trip to retirement; now the shadow record decides |
| 6 | A nightly that finished while the bot was restarting never got its hunt | `app.ts` (`incubator.huntSeenAt` persisted) | promotions waited a day |
| 7 | An account position whose symbol left every tracked set was orphaned after a restart | `app.ts` start | no 1m bars → stop, trail and targets never evaluated again until closed by hand |
| 8 | The clock announced a bar closed while the websocket was down | `candleStore.announceDueCloses` | a fragment scanned as a complete bar; the completed bar never re-scanned |
| 9 | The websocket path announced a close before the local clock agreed the bar was over | `candleStore.merge` | the run filtered out the announced bar and its entries were later dropped as "superseded" |
| 10 | A run's config was compared by identity | `scanners/engine.ts` | a config write that rebuilt an unchanged object silently discarded every in-flight run's events |
| 11 | Queue deadlines were enforced only by a ready worker; a worker that never exited after `terminate()` was lost | `pine/pool.ts` | with every worker retiring, queued live jobs never settled and the cell's `inFlight` lock held forever; the pool shrank silently |
| 12 | A dead TCP connection was asked to close, never forced | `delta/ws.ts` | up to ~15 min of frozen bars announced as closed |
| 13 | The incubator read the market gate's verdicts without an age | `incubator/store.ts`, `cycle.ts` | proposals and admissions on day-old verdicts while the account's own gate refused them |
| 14 | The memory guard read `memory.current`, which counts the page cache | `pine/pool.ts` | live runs killed as "over the guard" by cache, not heaps (decision 140's 60% trip) |

## Recorded, not changed

- **Reversal in latency mode** closes the held position before the replacement is admitted at fill time; a cancelled pending leaves the book flat (`paper/engine.ts` 330–345, 392–438). Rare; the rule at decision 77 says it cannot happen. Candidate: close the held position only when the replacement fills.
- **Shape "edge" dedupe** uses the 3-bar live tail but the full series in the backtest (`extractor.ts` 399–406); affects only `edge: true` shape sources, none enabled.
- **`emitClosed` marks the bar announced before listeners run**; a synchronous throw in one listener starves the later ones of that bar. Robustness, not observed.
- **Patch `if-array-get-field`** emits invalid Pine for `else if` and re-declares its temp name; no library script has the shape today.
- **A rejected demotion** is re-proposed at the next hunt; the market-out clock restarts after a reject (design).
- **Cross-process admission** (the bot's timer vs the nightly's own evaluate) can briefly exceed the caps; narrow window.
- **`candidateBlockers`** does not know about reservations, so 4h candidates read as `noSlot` on the Incubator page's blocker counts.
- **`setMaxBars`** does not raise existing series; the worker's HTF cache is keyed without the window (CLI only).
