# WillyAlgoTrader scripts — inventory and rebuild plan — 27 September 2026

The author has **43 published scripts**; all 43 are in the library (`scripts/manifest.json` carries
44 entries: one is a duplicate variant of AMD Po3). Nothing new since Reaction Level Matrix (24 Sep).
Profiled with `npm run profile` on ETHUSD 15m/1h/4h (`data/reports/2026-09-27-profile-willy.tsv`).

Every script is a Pine `indicator()` — none is a `strategy()`. The segregation that matters is what
each one produces in **our** runtime, which is often not what its description promises.

## A. Trade-plan scripts — the author's own engine gives entry, stop and targets (21)

These are the ones a bot can obey as written. `sources: ['alert']` locks the entry to the script's
own `alert()` trade call; everything else it draws is information.

| script | entries / 15m·1h·4h | note |
|---|---|---|
| abcd-harmonic-projection | 52 · 42 · 29 | clean |
| adaptive-fibonacci-trailing-system | 34 · 30 · 18 | clean, grades A+/A/B |
| amd-po3-with-live-edge-stats | 39 · 27 · 20 | sessions in UTC by the author's default |
| breakout-pattern-setup | 29 · 23 · 8 | clean |
| fibonacci-structure-engine | 104 · 81 · 55 | clean |
| liquidity-pools-pro | 105 · 80 · 64 | clean |
| liquidity-trail-matrix | 56 · 41 · 27 | runs now (manifest said broken) |
| meridian-flow | 80 · 56 · 39 | 120 extra shape entries on 15m → lock to alert |
| precision-sniper | 149 · 111 · 42 | clean |
| pulse-trend-radar | 63 · 53 · 35 | in the fleet (SOLUSD) |
| reactive-trail-system | 133 · 100 · 62 | clean |
| smart-breakout-targets | 11 · 9 · 5 | few signals |
| squeeze-breakout-pro | 40 · 23 · 19 | 271 alertconditions ignored once locked |
| stealthtrail-supertrend | 111 · 84 · 60 | clean |
| stealthtrail-supertrend-ml-pro | 114 · 75 · 21 | stop only, no targets (ladder applies) |
| synapse-trail-pro | 84 · 65 · — | fails on 4h: "Invalid timeframe" (its HTF input) |
| volume-weighted-s-r-zones | 144 · 83 · 65 | 19 of 144 entries have no levels → lock to alert |
| **over-read, must be locked** | | |
| adaptive-ichimoku-nexus | 336 · 241 · 161 | only 67 · 34 · 23 carry a plan; the rest are trend markers |
| mirage-liquidity-sweep-pro | 29 · 16 · 13 | only 3 · 1 · 0 carry a plan; the rest are EQH/EQL shapes |
| strat-trap-vwap-engine | **3012** · 2159 · 1391 | only 130 · 72 · 57 are trade calls; 4,182 shapes on 15m |
| daily-volume-profile-pro | 11 · 24 · 51 | targets from alertconditions, no stop — questionable; treat as levels |

## B. Signal-only scripts — a direction, no levels; our ATR stop and ladder apply (14)

| script | entries / 15m·1h·4h | where the signal comes from | note |
|---|---|---|---|
| adaptive-momentum-classifier | 92 · 84 · 41 | shapes | clean |
| adaptive-volatility-trend | 24 · 29 · 12 | shapes | clean |
| smarttrend-pro | 147 · 121 · 90 | shapes | runs now (manifest said broken) |
| phantom-trend-cloud | 243 · 177 · 130 | alert | fires on most bars of a trend: needs a rule (first bar of a flip) |
| adaptive-pivot-structure | 52 · 31 · 19 | alert | clean; 300 structure labels are information |
| adaptive-squeeze-momentum-pro | 108 · 74 · 68 | alert | clean |
| structure-anchored-vwap | 16 · 13 · 10 | derived HL/LH label rule | its own Buy/Sell never fires here (decision 44) |
| auto-s-r-channels | 1 · 0 · 2 | derived label rule | almost silent |
| swing-volume-profile-pro | 106 · 75 · 55 | labels ▲/▼ via rule | |
| ict-session-zones-sweep-signals | 76 · 214 · 260 | shapes | 260 on 4h is suspicious |
| **over-read, must be locked** | | | |
| adaptive-momentum-fusion | 450 · 312 · 224 | 1,148 alertconditions | every divergence/cross becomes an entry |
| nexus-fusion-engine-ml | 347 · 255 · 180 | 347 shapes + 1,260 info | H▲/D▲ markers read as entries |
| smart-money-engine | 209 · 142 · 83 | 479 alertconditions | CHoCH/BOS titles read as entries |
| self-aware-trend-system | 307 · 212 · 145 | its `alert()` packet | **moved to A**: with `webhookInput: true` its alert carries entry, stop and three targets, now parsed |

## C. Information only — levels, cycles, calculators (5)

automatic-fibonacci-levels, bitcoin-almanac, elliott-impulse-engine (76 alertconditions, 0 trades),
adaptive-spectral-forecast, trade-strategy-calculator. Not scanners. Candidates for the family lab's
readings, nothing more.

## D. Silent or unavailable (3)

reaction-level-matrix (runs, emits nothing: user-defined-type level engine — runtime gap),
trader-assistant-pro (invite-only), adaptive-trend-pro (protected). Plus the duplicate
`amd-po3-…-version-orga` (fails on its HTF default) — drop it.

## What the profile also showed

- The manifest's `incompatible` flag is stale: 10 scripts it calls broken run today. `npm run compat`
  needs a refresh and the flag should come from the last real run, not a report file.
- Timezone, checked: the session scripts carry their own timezone input (ICT Session Zones defaults
  to an American zone, AMD Po3 defaults to UTC by the author's choice; Precision Sniper and Strat
  Trap use no session windows at all). Running them under `America/New_York` changes nothing, so
  the earlier worry that their sessions were hours off was wrong. `scanners.<id>.timezone` exists
  now for the scripts that do read `syminfo.timezone`.
- Two scripts have a trade engine we never see: self-aware-trend-system and reaction-level-matrix.

## The rebuild, one script at a time

1. **Spec** — from the author's description: what is the entry, the stop, the target, the session.
   Written into the scanner's config as `sources`, `rule`, `inputs`, `exit`.
2. **Lock extraction** — `sources: ['alert']` for A; the one true channel for B; nothing for C.
3. **Runtime = TradingView** — one chart, one week: the same signals on the same bars, or the
   difference is understood. (The harness is the next thing to build.)
4. **Timezone** only where a script reads `syminfo.timezone` (none of the four session scripts do).
5. **Measure** — survey across markets and timeframes, halves, dollars; then the family lab's
   reading of it; then the shadow cohort. Nothing is promoted on a backtest.

Order: the clean A scripts first (they are what the bot was built for), the over-read ones after
locking, then the runtime gaps (self-aware-trend-system, reaction-level-matrix), then session
scripts after the timezone fix.

## Result of the rebuild (decision 49)

Before/after/author's-exits on 8 markets × 3 timeframes: −5,444R → −3,443R → −3,484R. Reading the
authors' trade calls only removed 24,000 phantom trades; it did not create an edge — all 22 plan
scripts lose under our exits and under their own. One sign flip (Mirage Liquidity Sweep Pro, 37
trades, +9.2R) goes to the watch list. Next: group B one by one, then the runtime gaps.
