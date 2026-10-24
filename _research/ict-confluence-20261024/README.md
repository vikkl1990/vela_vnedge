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
