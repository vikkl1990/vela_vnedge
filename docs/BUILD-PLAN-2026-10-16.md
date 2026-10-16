# The build-up: from a scanner bot to an operating system for one account (16 October 2026)

The reference is the AITOS flow (`docs/REFERENCE-AITOS-FLOW-2026-10-16.md`). This is the order in
which VNEdge grows into it, phase by phase, each with what it needs from the one before, what
"done" means, and what only the operator can do. Phases are small enough to land in days, not
weeks; every one leaves the bot running and the docs of truth current.

## Where it stands (the floor)

- 2,628 runnable scripts, 40 live cells on 18 markets, a shadow book of ~200 pairs, a nightly
  screen that now survives a hog and a memory leak (decision 98).
- The cost truth (decision 96): the 15m book eats the edge; the screen hunts the wrong timeframe;
  the stop-versus-cost ratio is too lax. **Two Settings changes by the operator unblock
  everything below: `paper.minRiskFeeRatio` 2 → 6, `incubator.tf` 15m → 1h.**
- Every gate exists; none is visible as a whole.

## Phase 1 — Gate Center (this week)

One page listing every gate between a setup and real money with its live state and what would
clear it: kill switch, daily and weekly loss, drawdown scaling, cooldowns, burst and re-entry,
position caps, exposure, market gate (how many markets allowed and why the rest are out),
stop-versus-cost ratio, liquidation headroom rule, regime, alerts channel, nightly job, shadow
cap, go-live rule, execution locks (mode, host, production double-lock, bracket).

*Needs:* nothing new; every state is already computed somewhere.
*Done when:* `/gates` shows every gate with state `open | armed | blocking | off | attention`,
the number behind it and the next step; the Overview's attention line links to it; a gate that
blocks an entry on the Signals page names the same gate.

## Phase 2 — Market context (next)

A context bar and a daily context record: BTC and ETH bias on 4h and 1d, the fleet's funding skew
(crowded side), open-interest change per market, the session (Asia, London, New York), the next
scheduled event from a static calendar, and a regime verdict per market per day (trending,
ranging, dead) from efficiency ratio and range-versus-ATR.

*Needs:* Delta ticker OI field; a calendar file; the regime maths already in `chopGate`.
*Done when:* the bar shows on every page, the record is stored per day, and the Analytics page
can cut R by regime and by session.

## Phase 3 — Context in the gate

Entries must agree with the context: a long on a market whose daily regime is "dead" or whose
higher frame is against it is refused with that reason; the efficiency gate becomes a regime
verdict rather than one number. Measured first with diagnose variants on the 83 cells, adopted
only if it improves most cells against the honest base (decision 96's table is the yardstick).

*Needs:* phase 2's record.
*Done when:* the variant table is filed as a decision and the live gate reads the record.

## Phase 4 — Staged signals

A cell carries a stage: watch (scanner enabled, market allowed), building (higher frame and
regime agree), confirmed (the scanner's alert fired), entry ready (every gate open), in trade,
exit. The Signals page shows stages and the reason at every step; the Overview shows what is
building now.

*Needs:* phases 1 and 3.
*Done when:* every signal row carries the stage it reached and the gate that stopped it.

## Phase 5 — Health check and self-heal

One button: feeds, candles per market, workers, the nightly job, the shadow book, the database,
each with pass/fail and the restart the monitor already knows (recycle workers, resubscribe,
re-judge, re-run the screen). The attention line becomes the summary of this check.

*Needs:* phase 1's page as the home for it.
*Done when:* the check runs from the page, every fix it applies is logged, and the operator
never needs the service log to know what is wrong.

## Phase 6 — Discovery at full speed

The screen on 1h (operator setting), the shadow cap raised or drained (operator setting), the
malloc drop-in on the units (operator, root), process workers for the live bot once a week of
nightly runs shows them clean, and the library sync for the four TradingView authors on a weekly
timer like LuxAlgo's.

*Done when:* a slice finishes every night, candidates enter the shadow book the night they pass,
and the Incubator page shows the week's admissions.

## What the operator owns, in order

1. Settings: minimum stop over round-trip cost 2 → 6; incubator timeframe 15m → 1h.
2. Scanners: Release on Pulse Trend Radar.
3. Incubator: the shadow cap (raise, or wait for retirements).
4. The units: the malloc drop-in from decision 98, `daemon-reload`, restart.
5. Telegram: the two environment variables, so a halt reaches a phone.

## The rule for every phase

Measured before adopted, every number in the decisions log, and nothing switched on by a page
that a browser could reach without the operator's own hand. Live orders stay where they are.
