# ICT scanner family on Delta candles — 24 October 2026

Four readings of the pasted ICT scripts, each run through the bot's own path (Pine engine, the account's exits, the
0.12% round trip paid, `diagnose`), on BTC/ETH/SOL/XRP/ZEC/AKE at 15m/1h/4h, 4,000 bars each.

| script | what it asks | result |
|---|---|---|
| Python confluence scanner (`npm run ictlab`) | score ≥ 3/5 of FVG + OB + sweep, side by dominant features | no edge after costs; 15m refused by the cost rule; random-equal on 1h |
| OPERATOR06 Directional Scalper | sweep **and** zone on the same bar + HTF 60m bias | near-mute (sweep bar cannot be an FVG bar); silent above 1h; 21 trades −4.9R |
| OPERATOR07 Sweep Into Zone | sweep wick enters a zone ≤ 20 bars old, bias one step up | 305 trades: 15m −0.041/t, 1h −0.115/t, 4h +0.002/t |
| OPERATOR08 Scalper Fixed | adds displacement **on the sweep bar** (green) with a bullish OB (red) | contradiction: 0 alerts on 4 × 4,000 bars; left out of the manifest |
| OPERATOR09 Sweep + Displacement | sweep on bar n−1 into a recent zone, displacement close on bar n, min stop 0.6% | 15m −0.169/t (65); 1h +0.022/t (81); **4h +0.080/t (95)**, BTC +0.14, ETH +0.12, ZEC +0.57, SOL −0.16 |

OPERATOR07 and 09 are in the manifest as `ok`: the nightly screen judges them on every market, and the 4h reservation
(decision 182) gives a passing 4h cell a slot. Nothing is promoted by hand.

## The pasted 4h exit rules, measured on operator 09 at 4h (six markets, 96 trades, spread paid)

| exits | trades | sum R | R/trade | win | halves |
|---|---|---|---|---|---|
| current (trail from +0.5R, TP3 at 6R) | 96 | +4.7 | +0.049 | 73% | +4.7 / 0.0 |
| target 1.5R, no trail | 93 | −0.1 | −0.001 | 42% | +2.2 / −2.3 |
| target 2R, no trail | 91 | −5.3 | −0.058 | 33% | +4.5 / −9.9 |
| break-even at +1R | 83 | +1.1 | +0.013 | 8% | +17.7 / −16.5 |
| time stop 2 bars under +0.25R | 97 | +6.4 | +0.066 | 57% | +4.2 / +2.3 |
| time stop 3 bars | 97 | +6.0 | +0.062 | 64% | +5.8 / +0.2 |
| 1.5R target + 3-bar time stop | 94 | +6.7 | +0.071 | 40% | +5.7 / +1.0 |

Fixed targets and break-even at +1R are worse than the trail; the time stops are within 2R of it over 96 trades —
noise, and the broad journal (decisions 128, 141) says time stops lose. The scanner's live runner is the bot itself (a
tracker, decision 139), not a polling script; the polling script's logic is the relaxed reading, which measured flat.
