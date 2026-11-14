# Script study

Every Pine source in the library read line by line by a model reader and compared with the way the bot reads it: 2633 sources, 776,057 lines. On scripts that trade, a second reader tried to refute every claimed misread. Findings are proposals: no reading has been changed.

## What the library is

| Verdict | All scripts | Scripts that trade |
|---|---|---|
| needs-changes | 1219 | 317 |
| context-only | 1022 | 39 |
| run-as-designed | 258 | 102 |
| drop | 134 | 17 |

| Kind | Scripts |
|---|---|
| context-only | 1032 |
| signal-tool | 913 |
| complete-strategy | 688 |

| The script has its own | Scripts | Readable by the bot |
|---|---|---|
| stop | 655 | 486 |
| targets | 608 | 421 |
| exit | 1024 |  |
| open-trade state that gates its later alerts | 624 |  |

| Timing | All scripts | Scripts that trade |
|---|---|---|
| signal not known at the bar close | 128 | 1 |
| drawings or signals repaint | 394 | 15 |
| higher-timeframe data can see an unfinished bar | 70 | 10 |
| entry built on a pivot confirmed 10+ bars late | 183 | 38 |

## How the bot misreads them

A misread compares the author's intent with what the bot trades. On scripts that trade, each claim was checked by a second reader.

| Misread | Meaning | All claims | On trading scripts | Confirmed | Refuted |
|---|---|---|---|---|---|
| wrong-side | traded on the side opposite to the author's | 226 | 56 | 56 | 0 |
| exit-misread | an exit or reversal alert read on the wrong side or as an entry | 197 | 45 | 37 | 6 |
| not-an-entry | a regime, exit or information marker traded as an entry | 1035 | 229 | 189 | 40 |
| unconfirmed-marker | a marker traded without the script's own confirmation | 457 | 130 | 117 | 13 |
| entry-not-read | the author's real entry is not read | 713 | 122 | 113 | 9 |
| side-dropped | one side traded, its mirror not | 31 | 14 | 13 | 1 |

## Enabled scanners

**liquidity-trail-matrix-atr-maker** (cdnBBG0A-Liquidity-Trail-Matrix-WillyAlgoTrader.pine): run-as-designed, complete-strategy, high confidence. Four ATR trailing bands define the trend; trades trend flips (close through Band 3) and scored pullback retests that reclaim Band 1, with wick stop and 1R/2R/3R targets.
- confirmed: exit-misread "🔄 REVERSAL" (line 1461). revDir is "Long → Short" when a long closes; the alert parser takes the first LONG and inverts it, so that close is reported for the short side. Fix: Read 'A → B' as closing side A, or drop the side on REVERSAL exits.
- Own stop: Wick-anchored: beyond the signal bar wick by 0.25 ATR(14), at least 0.5 ATR from the close. (readable: alert-text). Targets: TP1, TP2, TP3 at 1R, 2R, 3R of the stop distance (Balanced preset).. Exit: Stop hit, break-even stop after TP1, TP3 touch, or reversal on an opposite flip or retest signal..
- Note: botTrades is empty only because alert text is built at run time: LONG/SHORT entries with SL and TP parse correctly. Entry alerts stop while the script's own trade is open.

**structure-anchored-vwap** (E31jKiTS-Structure-Anchored-VWAP-WillyAlgoTrader.pine): run-as-designed, complete-strategy, high confidence. A VWAP anchored at each confirmed swing pivot (55/55) forms a directional leg; enters on a retest of that VWAP in the leg direction, with ATR stop and 1R/2R/3R targets.
- No misread: the bot reads this script as its author intends.
- Own stop: Entry close minus or plus 1.5 x ATR(13) (Balanced preset); moves to entry after TP1. (readable: alert-text). Targets: TP1, TP2, TP3 at 1R, 2R, 3R of the stop distance (Balanced preset).. Exit: Stop hit, break-even stop after TP1, or TP3 touch; no exit on an opposite signal or leg flip..
- Note: Base id reads the author's entries correctly; alert and Buy/Sell shape are one event. The -pivots id trades derived HL/LH tags (judged from source). Signals pause during the script's trade.

**smart-swing-vwap-zeiierman** (K0dz3kws-Smart-Swing-VWAP-Zeiierman.pine): needs-changes, signal-tool, medium confidence. Ranks rolling swings from five lookbacks, anchors an adaptive volume-weighted line at the best one and tracks structural polarity; alerts on structure breaks, AVWAP crosses and polarity-aligned retests.
- confirmed: unconfirmed-marker "Cross above AVWAP" (line 614). xUp (line 579) is ta.crossover(close, vw) outside anchor and flip bars; polarity sd is never checked, so it fires while structure is still bearish. Fix: Map 'cross above avwap' to none; trade retests and polarity flips.
- confirmed: unconfirmed-marker "Cross below AVWAP" (line 615). xDn (line 580) is ta.crossunder(close, vw) outside anchor and flip bars; no polarity sd check, so it fires inside a bullish structure. Fix: Map 'cross below avwap' to none; trade retests and polarity flips.
- Own stop: none. Targets: none. Exit: none.
- Note: Author names no entry; every alert is an event. Retests are the only fully filtered setup. A new anchor can change polarity without any flip alert (line 348).

**machine-learning-rsi-ai-classification-ranking-zeiierman** (VrTL3VwF-Machine-Learning-RSI-AI-Classification-Ranking-Zeiierman.pine): needs-changes, complete-strategy, high confidence. kNN over eight RSI features votes a directional bias; a stance flip passing rank, confidence, trend, volatility and chop gates is the entry. An ML-adaptive Supertrend is the trailing stop.
- confirmed: not-an-entry "ST Flip Up" (line 573). 'Supertrend flip dots': stFlipUp (line 440) is the trailing-stop direction change with no rank, confidence or cooldown gate. Its mirror 'ST Flip Dn' is unread, so longs only. Fix: Map 'st flip up' and 'st flip dn' to none.
- confirmed: not-an-entry "Trend Flip Up" (line 589). Message 'ML Supertrend flipped to UPTREND'; stFlipUp is the Trend Gate regime. The real entry is 'Long Signal' (triggerLong, line 498) with rank and confidence gates. Fix: Map 'trend flip up' to none; use it at most to close shorts.
- confirmed: not-an-entry "Trend Flip Down" (line 590). Message 'ML Supertrend flipped to DOWNTREND'; stFlipDn (line 441) is the trailing-stop flip, not gated by rank, confidence, volatility band or chop filter. Fix: Map 'trend flip down' to none; use it at most to close longs.
- Own stop: ML Supertrend trailing line: hl2 minus/plus 1.5-3.0 x ATR(10), width set by engine conviction and chop. (readable: plot). Targets: none. Exit: Supertrend flip against the trade (close through the trailing line); alert only, no position state..
- Note: LONG/SHORT alert texts are right; whether '▲ Trend Up' text parses as a side is not visible here. Stance alternates: a flip bar failing rank/confidence loses that signal.

**adaptive-volatility-trend** (CFgnJqe7-adaptive-volatility-trend-willyalgotrader.pine): needs-changes, signal-tool, high confidence. Kaufman-efficiency adaptive moving average with ATR bands. Signal on the bar its slope turns, with price on the right side, RSI not extreme, volume above average and score >= 40.
- No misread: the bot reads this script as its author intends.
- Own stop: none. Targets: none. Exit: none.
- Note: Current reading is already faithful on both sides; no reading change needed. Signal fires only on the slope-turn bar, so a low-volume turn leaves the whole trend unsignalled.

**session-killzones-breakouts** (uf6Cby1s-Session-Killzones-Breakouts-BigBeluga.pine): needs-changes, signal-tool, high confidence. Boxes Asia, London and New York UTC sessions with volume profile and POC; after a session ends, the first close through its high or low is a breakout with targets.
- confirmed: side-dropped "Asia Bear Breakout" (line 408). Lines 286 and 305 are mirror branches of one rule: close above prev_max_h gives trig_up, close below prev_min_l gives trig_dn. Only the bull shape is allow-listed. Fix: Add 'Asia Bear Breakout' as short, or record the long-only choice as deliberate.
- Own stop: none. Targets: Three levels: broken extreme plus session range x 0.5/1.0/1.5 (Asia) or 0.5/1.5/2.0 (London, NY); lines only.. Exit: none.
- Note: The all-sessions id reads all six markers correctly. The base id's Asia-long-only allow-list looks deliberate; London and NY are covered by the sibling id, so not flagged.

**session-killzones-breakouts-all-sessions** (uf6Cby1s-Session-Killzones-Breakouts-BigBeluga.pine): needs-changes, signal-tool, high confidence. Boxes Asia, London and New York UTC sessions with volume profile and POC; after a session ends, the first close through its high or low is a breakout with targets.
- No misread: the bot reads this script as its author intends.
- Own stop: none. Targets: Three levels: broken extreme plus session range x 0.5/1.0/1.5 (Asia) or 0.5/1.5/2.0 (London, NY); lines only.. Exit: none.
- Note: The all-sessions id reads all six markers correctly. The base id's Asia-long-only allow-list looks deliberate; London and NY are covered by the sibling id, so not flagged.

**supertrend-cluster-zeiierman** (r8j7m88J-SuperTrend-Cluster-Zeiierman.pine): needs-changes, signal-tool, high confidence. Five SuperTrends on smoothed hlc3 vote by weight. When 60% of the weight agrees and base SuperTrend 3 points the same way, the cluster regime flips: Major Long or Short.
- confirmed: unconfirmed-marker "Base ST Long" (line 265). flipBu = ta.crossover(dB, 0) (line 236) is one SuperTrend flipping, without the consensus test scBu >= thr (line 241); the dot is coloured bearish while dLast < 0. Fix: Map 'base st long' to none; trade 'Major Long' / 'Long' only.
- confirmed: unconfirmed-marker "Base ST Short" (line 266). flipBe = ta.crossunder(dB, 0) (line 237) is the base SuperTrend alone, without scBe >= thr (line 242); it can fire while cluster regime dLast is still bullish. Fix: Map 'base st short' to none; trade 'Major Short' / 'Short' only.
- Own stop: none. Targets: none. Exit: none.
- Note: The static audit missed the Base ST dots. Plot 'Active Cluster Line' (line 278) could serve as a trailing level if the bot ever reads plots.

**smart-money-breakout-signals** (IV6eZF3w-Smart-Money-Breakout-Signals-AlgoAlpha.pine): needs-changes, complete-strategy, high confidence. Tracks 25/25 swing pivots; the first close beyond the latest swing high or low is a BOS/CHoCH breakout, with stop and three targets sized from the range since that pivot.
- confirmed: side-dropped "Bearish Breakout Detected" (line 72). lowBroken (line 53) mirrors highBroken (line 50) and sends its own alert with its own SL and TPs (lines 112-121); the allow-list holds only the bullish text. Fix: Add 'Bearish Breakout Detected' as short, or record long-only as deliberate.
- Own stop: Broken swing level minus (long) or plus (short) one third of the high-low range since the pivot. (readable: no). Targets: Three levels at 1/3, 2/3 and 1 x dist beyond the broken level; dashed lines only.. Exit: Internal only: SL touched or farthest TP reached ends the trade state; drives bar colour and statistics..
- Note: botTrades is empty because alert text is read at run time; the allow-list trades the bullish text. The 'active' state does not gate alerts. Stop is measured from the level.

**ai-predictive-flow-zeiierman** (qaaxkW1P-AI-Predictive-Flow-Zeiierman.pine): needs-changes, signal-tool, medium confidence. kNN over the last 20 ten-bar patterns predicts the 2-bar EMA return; smoothed into an oscillator with signal line. Marks oscillator/signal crosses; background shows a predicted trend regime.
- confirmed: not-an-entry "Background Turned Bullish" (line 270). bgBull = trendUp and not trendUp[1] (line 249); trendUp only colours bgcolor 'Predicted Trend Regime' (line 240), set when predLine + 2 ATR makes a 30-bar high. Fix: Map both background titles to none, or keep it knowingly as a regime-flip experiment.
- confirmed: entry-not-read "Bullish Cross" (line 256). The script's only plotted signal markers are 'Bull'/'Bear' (lines 242-243), 'bullish and bearish crossover markers'; 'Bullish Cross' is their alert and is outside the allow-list. Fix: Allow-list 'Bullish Cross' as long.
- confirmed: entry-not-read "Bearish Cross" (line 257). bear = ta.crossunder(osc, sig) and sig <= 0 (line 228) is the script's short marker; its alert 'Bearish Cross' is outside the allow-list. Fix: Allow-list 'Bearish Cross' as short.
- Own stop: none. Targets: none. Exit: none.
- Note: Author alerts on every state change and names no entry; crosses are the only drawn markers. ta.ema/ta.rsi run inside a loop (lines 104-106): check the runtime matches TradingView.

**pivot-channel-breaks** (Esore3IT-Pivot-Channel-Breaks-BigBeluga.pine): needs-changes, signal-tool, high confidence. Each confirmed 40/10 pivot sets a horizontal channel: the pivot price and an opposite SMA10 plus/minus RMA-range band. The first break of either line marks a breakout.
- confirmed: side-dropped "Break Dn" (line 123). break_dn := ta.crossunder(high, point_l) (line 63) is the exact mirror of break_up (line 62) and is plotted the same way; the reading maps it to none. Fix: Map 'break dn' to short, as the two-sided reading does.
- Own stop: none. Targets: none. Exit: none.
- Note: Two-sided id also reads the untitled lines 177/186 shapes; sides are right but they never fire on default inputs. Pivot inputs (40 left, 10 right) are untitled.

**trend-lines** (vE8YNVgM-Trend-Lines-LuxAlgo.pine): needs-changes, signal-tool, high confidence. Draws a down-trendline through two falling 50-bar pivot highs and an up-trendline through two rising pivot lows, extends them, and marks the close crossing through.
- No misread: the bot reads this script as its author intends.
- Own stop: none. Targets: none. Exit: none.
- Note: Bot reading matches the author on both sides. Break test ignores isOnH/isOnL, so a stale line keeps extrapolating and signalling after a newer pivot pair fails (lines 100, 148).

**kinetic-momentum-vectors** (DBgT7UX4-Kinetic-Momentum-Vectors-BigBeluga.pine): context-only, context-only, medium confidence. Volume times absolute close change, normalised over 100 bars, drawn as fuel candles around an EMA100 baseline; the highest-energy bar is marked as a spike and leaves a horizontal level.
- confirmed: not-an-entry "Bull Spike" (line 120). kineticFuel = volume * math.abs(priceChange) (line 32): the spike has no bar direction. 'Bull' only means close > EMA100 (line 27), so a large down bar also marks it. Fix: Treat as context; do not open trades from spike squares.
- Own stop: none. Targets: none. Exit: none.
- Note: No alerts and no entry concept in the source. Spike squares mark a volume-and-move climax on the trend side of EMA100; the author's levels (lines 55-97) carry no marker.

**rsi-volume-ladder** (XuywwObg-RSI-Volume-Ladder.pine): run-as-designed, complete-strategy, medium confidence. Long-only dip buyer: RSI(14) under 30 with volume above 1.5x its SMA20, averaging down up to three fills 1.5% apart, one shared 4% target and 3% stop.
- No misread: the bot reads this script as its author intends.
- Own stop: 3% below the lowest ladder fill, strategy.exit stop; first issued the bar after the fill. (readable: strategy-order). Targets: 4% above the average position price, strategy.exit limit; recalculated after each added fill.. Exit: Whole position closes at the TP limit or SL stop; no signal exit. 3-bar cooldown after a stop..
- Note: Static botTrades is empty; entries and the exit are strategy fills read at run time, long only by design. Fills 2-3 are averaging-down adds; the fill bar has no stop.

**trend-impulse-channels-zeiierman** (d3IaFa7c-Trend-Impulse-Channels-Zeiierman.pine): needs-changes, signal-tool, high confidence. Step trend line re-anchored at close whenever price closes 2.86 ATR(200) beyond it, with bands at 2.02 ATR; marks pullbacks to the trend-side band as retests.
- confirmed: wrong-side "Lower Retest" (line 101). Crossunder := ta.crossunder(low,lower) and trendDirection == 1 (line 98), drawn shape.triangleup, location.belowbar in colorUp2: a dip buy in an uptrend, read as short. Fix: Map 'lower retest' to long.
- confirmed: wrong-side "Upper Retest" (line 102). Crossover := ta.crossover(high,upper) and trendDirection == -1 (line 99), drawn shape.triangledown, location.abovebar in colorDown2: a rally sell in a downtrend, read as long. Fix: Map 'upper retest' to short.
- refuted: not-an-entry "Bullish Step" (line 104). Tooltip t7 (line 15): markers for each structural trend advancement. TrendStepSignal defaults false (line 33), so it never plots on default inputs. Fix: Map 'bullish step' to none.
- refuted: not-an-entry "Bearish Step" (line 105). Mirror of Bullish Step: trendStep and dir == -1, a trend-advance marker gated by TrendStepSignal, default false (line 33). Fix: Map 'bearish step' to none.
- Own stop: none. Targets: none. Exit: none.
- Note: Default Max Step Size is negative: the line drifts 0.034 ATR per bar against the trend and steps only on re-anchor bars. Retest sits 0.84 ATR from the flip level.

**trend-impulse-channels-zeiierman-maker** (d3IaFa7c-Trend-Impulse-Channels-Zeiierman.pine): needs-changes, signal-tool, high confidence. Step trend line re-anchored at close whenever price closes 2.86 ATR(200) beyond it, with bands at 2.02 ATR; marks pullbacks to the trend-side band as retests.
- confirmed: wrong-side "Lower Retest" (line 101). Crossunder requires trendDirection == 1 (line 98) and is drawn as an up-triangle below the bar in the up colour; the reading trades it short. Fix: Map 'lower retest' to long.
- confirmed: wrong-side "Upper Retest" (line 102). Crossover requires trendDirection == -1 (line 99) and is drawn as a down-triangle above the bar in the down colour; the reading trades it long. Fix: Map 'upper retest' to short.
- Own stop: none. Targets: none. Exit: none.
- Note: Default Max Step Size is negative: the line drifts 0.034 ATR per bar against the trend and steps only on re-anchor bars. Retest sits 0.84 ATR from the flip level.

**alphamojo-supertrend-strategy-ha-with-buffer** (pIdVZEJY-Alphamojo-Supertrend-Strategy-HA-with-Buffer.pine): run-as-designed, complete-strategy, medium confidence. Supertrend(10, 3) on Heikin Ashi candles; on each flip it places a stop-entry just beyond the HA flip bar's high or low and reverses on the opposite fill.
- No misread: the bot reads this script as its author intends.
- Own stop: none. Targets: none. Exit: Stop-and-reverse: the opposite stop-entry fill closes and reverses the position; never flat after the first fill..
- Note: Static botTrades is empty; both sides are strategy fills read at run time. Unfilled stop-entries are never cancelled, so a stale one can fill later. Needs ticker.heikinashi support.

## Confirmed side errors on scripts that trade

| Scanner | Pairs | Marker | Line | Problem | Evidence |
|---|---|---|---|---|---|
| trend-impulse-channels-zeiierman | 13 | Lower Retest | 101 | wrong-side | Crossunder := ta.crossunder(low,lower) and trendDirection == 1 (line 98), drawn shape.triangleup, location.belowbar in colorUp2: a dip buy in an uptre |
| trend-impulse-channels-zeiierman | 13 | Upper Retest | 102 | wrong-side | Crossover := ta.crossover(high,upper) and trendDirection == -1 (line 99), drawn shape.triangledown, location.abovebar in colorDown2: a rally sell in a |
| liquidity-trail-matrix | 8 | 🔄 REVERSAL | 1461 | exit-misread | revDir is "Long → Short" when a long closes; the alert parser takes the first LONG and inverts it, so that close is reported for the short side. |
| universal-signal-backtester | 8 | Long Win | 579 | exit-misread | isLongWin is set at L379 inside 'if closedThisBar' (L369): the bar a simulated long closes in profit. On an opposite cross (L361) a short opens that s |
| universal-signal-backtester | 8 | Long Loss | 580 | exit-misread | isLongLoss is set at L386 when a simulated long closes at a loss (stop hit L317-323 or bearish cross L361). Bot buys at the long's stop-out. |
| universal-signal-backtester | 8 | Short Win | 582 | exit-misread | isShortWin is set at L381 when a simulated short closes in profit (targets filled or bullish cross L361). Bot sells where the short was covered. |
| universal-signal-backtester | 8 | Short Loss | 583 | exit-misread | isShortLoss is set at L388 when a simulated short closes at a loss (stop hit or bullish cross L361). Bot sells at the short's stop-out. |
| support-and-resistance-non-repainting | 8 | Bullish Zone Invalidated | 184 | wrong-side | Bullish box removed when close < its bottom (support broken, bearish) or after 300 bars; bot trades it long. |
| support-and-resistance-non-repainting | 8 | Bearish Zone Invalidated | 185 | wrong-side | Bearish box removed when close > its top (resistance broken, bullish) or after 300 bars; bot trades it short. |
| estrategia-dpo-artedejubilarte | 5 | Cierre LONG | 654 | exit-misread | Plots longCloseByMa: signalState == 1 and fast SMA crosses under slow SMA (line 448); it closes the long, text 'C-LONG'. |
| estrategia-dpo-artedejubilarte | 5 | Cierre SHORT | 665 | exit-misread | Plots shortCloseByMa: signalState == -1 and fast SMA crosses over slow SMA (line 449); it closes the short, text 'C-SHORT'. |
| estrategia-dpo-artedejubilarte | 5 | CIERRE LONG por cruce bajista SMA | 729 | exit-misread | Condition is longCloseByMa (line 448); the message says the long is closed because the fast SMA crossed under the slow SMA. |
| estrategia-dpo-artedejubilarte | 5 | CIERRE SHORT por cruce alcista SMA | 735 | exit-misread | Condition is shortCloseByMa (line 449); the message says the short is closed because the fast SMA crossed over the slow SMA. |
| sbp-crypto-volume-structure-indicator | 5 | Buy or Sale | 220 | wrong-side | alertcondition(finalBuy or finalSale, "Buy or Sale") also fires on Sale bars but is read as long. |
| adaptive-bounds-rsi | 5 | Lower Bound Cross | 114 | wrong-side | Lower bound is the oversold cluster: input "Lower Bound Color (OS)" uses BULL_COLOR and colours the lower cross marker (lines 22, 103). |
| adaptive-bounds-rsi | 5 | Upper Bound Cross | 115 | wrong-side | Upper bound is overbought: input "Upper Bound Color (OB)" uses BEAR_COLOR for the upper cross marker (lines 23, 104). |
| elliott-wave | 4 | New EW Corrective Bullish Pattern found | 302 | wrong-side | An ABC rally found only when the last motive is bearish (getEW.dir == -1, line 283); the script next watches for a new bearish wave (420-426). Read as |
| elliott-wave | 4 | New EW Corrective Bearish Pattern found | 413 | wrong-side | An ABC decline found only when the last motive is bullish (getEW.dir == 1, line 394); the script next watches for a new bullish wave (309-315). Read a |
| liquidity-heatmap-sweep-radar | 4 | Buy-side sweep | 183 | wrong-side | _sweep for buy pools: high > _p.price and close < _p.price; stop-hunt above that closes back down, a bearish rejection; bot reads 'buy' as long. |
| liquidity-heatmap-sweep-radar | 4 | Sell-side sweep | 184 | wrong-side | _sweep for sell pools: low < _p.price and close > _p.price; stop-hunt below that closes back up, bullish; bot reads 'sell' as short. |
| adaptive-structural-liquidity-map | 3 | Upper Structural Sweep | 151 | wrong-side | Fires when high pierces an upper pool and close is back below it (144-145); drawn as a red triangledown above the bar. Read as long. |
| adaptive-structural-liquidity-map | 3 | Lower Structural Sweep | 152 | wrong-side | Fires when low pierces a lower pool and close is back above it (147-148); drawn as a green triangleup below the bar. Read as short. |
| adaptive-structural-liquidity-map | 3 | Upper Structural Sweep | 449 | wrong-side | Same upperSweep flag: wick through an upper pool with the close back below it (144-145), a bearish rejection. Read as long. |
| adaptive-structural-liquidity-map | 3 | Lower Structural Sweep | 450 | wrong-side | Same lowerSweep flag: wick through a lower pool with the close back above it (147-148), a bullish rejection. Read as short. |
| band-walk | 3 | Bullish Band Walk Ended | 319 | exit-misread | endUpEvent is set when a bullish walk closes below the midline or misses the band 5 closes running (lines 166-170); read as a long entry. |
| band-walk | 3 | Bearish Band Walk Ended | 320 | exit-misread | endDnEvent is set when a bearish walk closes above the midline or misses the band 5 closes running (lines 178-182); read as a short entry. |
| liquidity-trail-matrix-atr-maker | 2 | 🔄 REVERSAL | 1461 | exit-misread | revDir is "Long → Short" when a long closes; the alert parser takes the first LONG and inverts it, so that close is reported for the short side. |
| smart-money-concepts-smc | 2 | Bullish Internal OB Breakout | 837 | wrong-side | L493-496: flag is set when the low (mitigation source) falls below barLow of a BULLISH order block, i.e. demand zone broken downward and removed. Bot  |
| smart-money-concepts-smc | 2 | Bearish Internal OB Breakout | 838 | wrong-side | L487-490: flag is set when the high (mitigation source) exceeds barHigh of a BEARISH order block, i.e. supply zone broken upward and removed. Bot sell |
| smart-money-concepts-smc | 2 | Bullish Swing OB Breakout | 839 | wrong-side | Same mitigation logic L493-498: bullish swing OB broken downward. Never fires on defaults: Swing Order Blocks is false (L100) so deleteOrderBlocks() i |
| smart-money-concepts-smc | 2 | Bearish Swing OB Breakout | 840 | wrong-side | Same mitigation logic L487-492: bearish swing OB broken upward. Never fires on defaults: Swing Order Blocks is false (L100, L797). |
| kinetic-trend-momentum-oscillator-driver-cluster | 2 | Main Chart Bull Brake | 339 | exit-misread | brakeBull is set when a long leg ends: legState 1 with triggerBullBrake sets legState to 0 (224-227). Square above the bar, text 'BRAKE'. |
| kinetic-trend-momentum-oscillator-driver-cluster | 2 | Main Chart Bear Brake | 340 | exit-misread | brakeBear is set when a short leg ends: legState -1 with triggerBearBrake sets legState to 0 (233-236). Square below the bar, text 'BRAKE'. |
| session-vwap-profile-candle-delta | 2 | Upper Reversal | 439 | wrong-side | upperSignal = high > upperBand and close < upperBand (L432), drawn as triangledown above the high in the down colour: a rejection of the upper band. |
| session-vwap-profile-candle-delta | 2 | Lower Reversal | 440 | wrong-side | lowerSignal = low < lowerBand and close > lowerBand (L433), drawn as triangleup below the low in the up colour: a rejection of the lower band. |
| measured-move | 2 | Bullish Measured Move Invalidated | 402 | exit-misread | bullInvalidEvent is set when low < m.aPrice voids an active bullish construction (lines 320-323) or re-anchoring falls below the origin (lines 306-308 |
| measured-move | 2 | Bearish Measured Move Invalidated | 403 | exit-misread | bearInvalidEvent is set when high > m.aPrice voids an active bearish construction (lines 320-325): the short idea has failed, yet the title reads as a |
| vwap-mean-reversion-vs-trend-regimes | 2 | Fade Setup at Upper Outer Band | 390 | wrong-side | The alert fires on fadeShortSetup = regime == REGIME_REVERT and upperOuterTag (line 285): a short fade back to VWAP. 'Upper' in the title makes the bo |
| vwap-mean-reversion-vs-trend-regimes | 2 | Fade Setup at Lower Outer Band | 391 | wrong-side | The alert fires on fadeLongSetup = regime == REGIME_REVERT and lowerOuterTag (line 286): a long fade back to VWAP. 'Lower' in the title makes the bot  |
| liquidity-dynamics-structure-engine | 2 | Buy-side Liquidity Sweep | 330 | wrong-side | buySweep = high > buyLiq and close < buyLiq (line 94); it sets lastSweepDir := -1 and structureState 'BEARISH REJECTION' (lines 98-100). |
| liquidity-dynamics-structure-engine | 2 | Sell-side Liquidity Sweep | 331 | wrong-side | sellSweep = low < sellLiq and close > sellLiq (line 95); it sets lastSweepDir := 1 and structureState 'BULLISH REJECTION' (lines 106-108). |
| golden-pocket | 2 | Bullish Pocket Broken | 310 | exit-misread | brokenEvent is a close below the bullish pocket bottom (lines 110-112); alert text says acceptance below the band points toward 0.786. Read as long. |
| golden-pocket | 2 | Bearish Pocket Broken | 314 | exit-misread | brokenEvent is a close above the bearish pocket top (lines 110-112); alert text says acceptance above the band points toward 0.786. Read as short. |
| golden-pocket | 2 | Bullish Pocket Invalidated | 311 | exit-misread | invalidatedEvent is a close below the invalidation level (lines 114-116), 'breaking the continuation premise'. Read as long. |
| golden-pocket | 2 | Bearish Pocket Invalidated | 315 | exit-misread | invalidatedEvent is a close above the invalidation level (lines 114-116), 'breaking the continuation premise'. Read as short. |
| speed-resistance-lines | 2 | Rising Fan Line Break | 277 | wrong-side | riseAnyBreak = close below a rising-fan line; xcross plotted abovebar in bear colour. Bearish, read as long. |
| speed-resistance-lines | 2 | Falling Fan Line Break | 278 | wrong-side | fallAnyBreak = close above a falling-fan line; plotted belowbar in bull colour. Bullish, read as short. |
| speed-resistance-lines | 2 | Full Line Break (Rising Fan) | 287 | wrong-side | riseFullBreak: close < fullLineVal; message 'price closed below the full speed line of the rising fan'. |
| speed-resistance-lines | 2 | 2/3 Speedline Break (Rising Fan) | 288 | wrong-side | rise23Break: close < twoThirdVal; 'first pullback defense lost'. Bearish event read as long. |
| speed-resistance-lines | 2 | 1/3 Speedline Break (Rising Fan) | 289 | wrong-side | rise13Break: close < oneThirdVal; 'the advance's rate has failed'. Bearish event read as long. |
| speed-resistance-lines | 2 | Broken Line Retest (Rising Fan) | 291 | wrong-side | riseRetest: high >= line and close < line; 'broken support acting as resistance'. Bearish, read as long. |
| speed-resistance-lines | 2 | Full Line Break (Falling Fan) | 292 | wrong-side | fallFullBreak: close > fullLineVal of falling fan. Bullish event read as short. |
| speed-resistance-lines | 2 | 2/3 Speedline Break (Falling Fan) | 293 | wrong-side | fall23Break: close > twoThirdVal; 'first bounce defense lost'. Bullish event read as short. |
| speed-resistance-lines | 2 | 1/3 Speedline Break (Falling Fan) | 294 | wrong-side | fall13Break: close > oneThirdVal; 'the decline's rate has failed'. Bullish event read as short. |
| speed-resistance-lines | 2 | Broken Line Retest (Falling Fan) | 296 | wrong-side | fallRetest: low <= line and close > line; 'broken resistance acting as support'. Bullish, read as short. |
| high-volume-pivot-support-resistance-zones | 2 | Resistance Breakout | 272 | wrong-side | plotshape(triggerResBreak, style = shape.triangleup, location = location.belowbar, text = 'Res Breakout'); fires on close > rTop |
| high-volume-pivot-support-resistance-zones | 2 | Support Breakdown | 273 | wrong-side | plotshape(triggerSupBreak, style = shape.triangledown, location = location.abovebar); fires on close < sBottom |
| btcusd-4h-ema-swing-strategy | 2 | SELL | 230 | exit-misread | shortExitBySignal = strategy.position_size < 0 and sellSignal -> strategy.close("Short", comment="SELL exit") |
| btcusd-4h-ema-swing-strategy | 2 | SELL | 279 | exit-misread | alertcondition(sellSignal, title="SELL"); sellSignal used only as short exit at line 151 |
| strategy-432-btc-donchian-breakout-continuation | 2 | Salida Long | 148 | exit-misread | plotshape(showSignals and longExit, title Salida Long, text EXIT); Salida is Spanish for exit, yet read as a long entry |
| strategy-432-btc-donchian-breakout-continuation | 2 | Salida Short | 158 | exit-misread | plotshape(showSignals and shortExit, title Salida Short, text EXIT); a short exit read as a short entry |
| supertrended-rsi | 2 | RSI Bullish Reversal | 89 | wrong-side | crossover(rsiSupertrend, rsiValue) and rsiSupertrend > 70 = RSI falling below supertrend from overbought; drawn as red triangledown 'Crossover Down' l |
| supertrended-rsi | 2 | RSI Bearish Reversal | 90 | wrong-side | crossunder(rsiSupertrend, rsiValue) and rsiSupertrend < 30 = RSI rising from oversold; drawn as green triangleup 'Crossunder Up' line 84. |
| trend-impulse-channels-zeiierman-maker | 1 | Lower Retest | 101 | wrong-side | Crossunder requires trendDirection == 1 (line 98) and is drawn as an up-triangle below the bar in the up colour; the reading trades it short. |
| trend-impulse-channels-zeiierman-maker | 1 | Upper Retest | 102 | wrong-side | Crossover requires trendDirection == -1 (line 99) and is drawn as a down-triangle above the bar in the down colour; the reading trades it long. |
| re-accumulation | 1 | Support lost | 372 | exit-misread | Label drawn on invalidatedEvent, the decisive loss of range support. The written reading lists the label channel and 'support' reads as up, so it beco |
| wyckoff-wave-volume-studies | 1 | Buying Wave Drying Up | 448 | wrong-side | readColorOf (152-154) gives drying on a buying wave the bear color, 'argues the other side'; it fires once price has already reversed down by the thre |
| auto-trendlines | 1 | Resistance Trendline Broken | 378 | wrong-side | broke = close > v + tol (line 188) sets resBreak; message 'Price closed above the falling trendline'; label 'Break ↑' (223). An upside breakout, read  |
| auto-trendlines | 1 | Support Trendline Broken | 379 | wrong-side | broke = close < v - tol (line 298) sets supBreak; message 'Price closed below the rising trendline'; label 'Break ↓' (330). A downside break, read as  |
| volatility-supply-and-demand-zones | 1 | Sell zone broken | 349 | exit-misread | deadSell counts sell zones where close > box top (line 120): a bullish break that retires the zone, read as a short. |
| volatility-supply-and-demand-zones | 1 | Buy zone broken | 350 | exit-misread | deadBuy counts buy zones where close < box bottom (line 120): a bearish break that retires the zone, read as a long. |
| velocity-breakout-strategy-vbs | 1 | SELL MARKER | 250 | exit-misread | visualAtrExit = (pos == -1 and pos[1] == 1) feeds strategy.close("Long", comment="Trail Exit") at line 253; the strategy never opens a short. |
| 10-tech-indexes-score-system | 1 | ⬛ Cierre Long | 282 | exit-misread | closeLong = totalBear >= threshold and strategy.position_size > 0 (line 188); it closes a long on a bearish score, read as a long entry. |
| 10-tech-indexes-score-system | 1 | ⬛ Cierre Short | 283 | exit-misread | closeShort = totalBull >= threshold and strategy.position_size < 0 (line 189); it closes a short, read as a short entry. |
| dynamic-rsi-regression-bands-zeiierman | 1 | Upper Rejection | 221 | wrong-side | upperReject: high crossed above upper band, then close < upperreg and close < open (line 202); red marker above price. |
| dynamic-rsi-regression-bands-zeiierman | 1 | Lower Rejection | 222 | wrong-side | lowerReject: low crossed below lower band, then close > lowerreg and close > open (line 203); green marker below price. |
| trend-targets | 1 | Trend Change: Bullish | 207 | exit-misread | Condition is ta.crossover(close, SL): price crossing the stored stop, i.e. a short stop-out, not the tL turn. |
| trend-targets | 1 | Trend Change: Bearish | 208 | exit-misread | ta.crossunder(close, SL): long stop-out, not the plotted trend change. |
| market-structure-break-retest | 1 | Resistance Holds | 152 | wrong-side | supportRetest; message 'Price retested broken resistance and remained above it.' Bullish, read as short. |
| market-structure-break-retest | 1 | Support Holds | 158 | wrong-side | resistanceRetest; message 'Price retested broken support and remained below it.' Bearish, read as long. |
| market-structure-break-retest | 1 | Resistance Holds | 119 | wrong-side | plotshape(showLabels and supportRetest, title="Resistance Holds"): close > brokenResistance retest, bullish. |
| market-structure-break-retest | 1 | Support Holds | 128 | wrong-side | plotshape(showLabels and resistanceRetest, title="Support Holds"): close < brokenSupport retest, bearish. |
| ichimoku-crypto-swing-alert | 1 | Short | 112 | exit-misread | alertcondition(condition=exitLongConditions, title="Short") fires only when longOpeneds[1] and sellcond: it closes the long. |
| ichimoku-crypto-swing-alert | 1 | Short  | 115 | exit-misread | plotshape(exitLongConditions, title="Short ") is the long exit, not a short entry. |
| 9-21-ema-volume-spike-bollinger-bands-vwap | 1 | Sell Signal | 110 | exit-misread | if sellSignal: strategy.close("Long") at line 102; the strategy never opens shorts, so Sell Signal means close the long |
| ma-oscillator-map | 1 | Upper Signals Chart | 90 | wrong-side | Fires when osc falls from +100, drawn at high[1] in colDn (red); line 50 sets upper := high[1] as resistance |
| ma-oscillator-map | 1 | Upper Signals | 91 | wrong-side | Same condition as line 90, pane copy in colDn with offset -1 |
| ma-oscillator-map | 1 | Lower Signals Chart | 93 | wrong-side | Fires when osc rises from -100, drawn at low[1] in colUp (blue); line 54 sets lower := low[1] as support |
| ma-oscillator-map | 1 | Lower Signals | 94 | wrong-side | Same condition as line 93, pane copy in colUp with offset -1 |
| smart-money-volume-index | 1 | Smart Money Buy Interest turned negative | 96 | wrong-side | crossunder(sig_buy, 0): net index turned negative, bearish, yet read as long |
| smart-money-volume-index | 1 | Smart Money Sell Interest turned negative | 98 | wrong-side | sig_sell = -net_index; crossunder 0 means net turned positive, bullish, yet read as short |
| sma-4-sma-30 | 1 | Sell | 39 | exit-misread | flatCondition only triggers strategy.close("Long") at line 52; the strategy never opens a short |
| nifty-supertrend-ce-strategy-alice-blue | 1 | SELL | 35 | exit-misread | plotshape(exitSignal, title="SELL", ... text="EXIT"); exitSignal closes the long via strategy.close("LONG") line 30. Script is long-only. |

## Scripts that trade and can run as their author designed them

| Scanner | Pairs | Style | Own stop | Idea |
|---|---|---|---|---|
| hemant-gold-strategy | 10 | structure | strategy-order | Liquidity-sweep reversal: wick below prior 10-bar low then close back above, with close above EMA200 (mirror f |
| structure-anchored-vwap | 9 | structure | alert-text | A VWAP anchored at each confirmed swing pivot (55/55) forms a directional leg; enters on a retest of that VWAP |
| liquidity-trail-matrix, liquidity-trail-matrix-atr-maker | 8 | trend | alert-text | Four ATR trailing bands define the trend; trades trend flips (close through Band 3) and scored pullback retest |
| alphamojo-supertrend-strategy-ha-with-buffer | 6 | trend | none | Supertrend(10, 3) on Heikin Ashi candles; on each flip it places a stop-entry just beyond the HA flip bar's hi |
| pulse-trend-radar | 5 | trend | alert-text | Kaufman adaptive average with median-true-range bands; a close beyond the opposite band flips the trend and si |
| self-adaptive-trend-signals | 5 | trend | plot | Supertrend whose ATR multiplier is learned separately for up and down trends from the 85th percentile of past  |
| decoded-volatility-expansion | 5 | breakout | strategy-order | Stop-entry orders 1.5 ATR beyond the prior 20-bar range; stop at range midline, target at 2R from the trigger. |
| tectonic-regime-protocol | 4 | trend | strategy-order | Regime-gated trend strategy: ADX/EMA50 regime, VWMA200, HMA ribbon and 4h EMA50 filter, six-pillar confluence  |
| supertrend-regime-confluence | 4 | trend | strategy-order | Adaptive-multiplier SuperTrend flip, taken only with a five-factor confluence score >= 65, EMA50 alignment, no |
| golden-trident-swing-anchored-vwap-trend-system | 4 | trend | strategy-order | Long-only gold trend strategy: enters when the latest 30-bar high is newer than the latest low, above EMA200 a |
| kaufman-moving-average-adaptive-strategy-by-mkb | 4 | trend | none | Long-only KAMA strategy: buys when price crosses above KAMA + 0.5 x stdev(20), and sells when price crosses ba |
| volatility-surge-strategy | 4 | mean-reversion | strategy-order | Volatility index = drop from highest close; when it exceeds its Bollinger upper band on two bars, trade the ca |
| high-activity-penny-stock-strategy-v6 | 4 | trend | strategy-order | SuperTrend(10,2) flip filtered by volume > 1.2x 20-bar average and close vs SMA50; fixed 10% target, 5% stop,  |
| breakout-pattern-setup | 3 | breakout | alert-text | Fits converging trendline channels through confirmed pivots (optional volume contraction), then trades the fir |
| trend-target-ribbon | 3 | trend | no | ALMA(34) trend state: flips bull when close exceeds ALMA plus 0.65 stdev with positive ATR-normalised slope, b |
| ewmac-trend-signals | 3 | trend | none | Blends volatility-normalised EMA crossover scores (fast vs 4x slow, spans 4-32) into one trend score; bullish  |
| bb-kc-squeeze-breakout | 3 | breakout | strategy-order | Bollinger inside Keltner squeeze; close beyond the Keltner band within 3 bars of the squeeze ending enters; st |
| qqe-channel-strategy | 3 | trend | strategy-order | High/low EMA(60) channel sets trend direction; a QQE-style trailing band on smoothed RSI sets momentum. Enters |
| qqe-trend-strategy | 3 | oscillator | none | Dual QQE (RSI 14 smoothed, fast 2.618 and slow 4.236 trailing bands). Trades slow-band trend reversals filtere |
| aurora-kama-kama-adaptive-trend-strategy | 3 | trend | strategy-order | Kaufman adaptive MA (10, 2, 30). Long when KAMA has risen 3 bars above SMA200, short when fallen 3 bars below; |
| donchian-trend-rules | 3 | breakout | plot | Turtle-style Donchian rules: close beyond prior 20-bar channel enters, break of prior 10-bar opposite extreme  |
| real-strength-scalper | 3 | trend | strategy-order | Strength = smoothed ROC x volume ratio x ADX boost; enters with DI direction and SMA30/60 trend, exits on stre |
| btc-trend-momentum-strategy | 3 | trend | none | Stoch RSI K crossing out of 20/80 with Chaikin Money Flow sign and rising-ATR filter; longs need close above E |
| asian-box-breakout-strategy | 3 | session | strategy-order | Builds the Asian session high/low box (05-13 Bangkok), then places stop orders at both edges during the tradin |
| ll-momentum-and-curl-master | 3 | trend | alert-text | Momentum(20) sign with SMA50 slope, EMA200 trend guard and volume above 1.2x average; ATR stop beyond the sign |
| inside-day-breakout-strategy | 3 | breakout | strategy-order | After an inside day, places buy stop at prior day high and sell stop at prior day low; stop at opposite extrem |
| santoshpsiii-crypto-algo | 3 | trend | none | Supertrend(10,3) flip entries, filtered by Bollinger width above its 20-SMA (trending); any opposite flip clos |
| bollinger-squeeze-breakout-volume | 3 | breakout | strategy-order | After BB width falls below 0.8x its 50-bar average, trade close breaking a band with above-average volume; sto |
| precision-sniper | 2 | trend | alert-text | EMA fast/slow cross with a 10-point confluence score (trend EMA, RSI, MACD, VWAP, volume, ADX, HTF bias), grad |
| stealthtrail-supertrend | 2 | trend | alert-text | SuperTrend whose ATR multiplier adapts to volatility; a confirmed flip beyond a cushion, with RSI agreement, o |
| supertrend-take-profit-dimensions | 2 | trend | plot | SuperTrend (ATR 10, factor 3) trend flips, plus a 0-100 exit-favourability score comparing current volume, tim |
| concordance-strategy | 2 | trend | strategy-order | Scores trend regime (EMA 34/89/200, 4h bias, ADX), liquidity sweeps, Fib OTE, volume pressure and regression s |
| simple-scalper-pro-v1-1-alx-sport-tour | 2 | trend | plot | EMA 9/50 cross opens a trade; stop 1.5 x ATR(30) taken from the 1-minute timeframe; exit when EMA 9 crosses EM |
| smart-flow-imbalance | 2 | oscillator | no | 0-100 score from volume-weighted flow, candle displacement and 24-bar range position; crossing above 72 opens  |
| smart-money-liquidation-exploits | 2 | structure | none | Keeps 3-bar pivot highs/lows as liquidity for 10 bars; a wick through a level with the body back inside is a s |
| alma-slope-adx-cross-system | 2 | trend | strategy-order | ALMA(9) slope crossing zero, filtered by rising ADX above 20, with mid-trend re-entries after a cooldown; exit |
| execution-aware-trend | 2 | breakout | plot | Donchian breakout with trend filter: close beyond the prior 20-bar channel while EMA 50 is beyond a sloping EM |
| ma-trend-ribbon | 2 | trend | none | Six-line HMA ribbon (40 + 8 steps); always-in trend system that buys when fastest MA crosses above slowest and |
| btcusd-4h-ema-swing-strategy | 2 | trend | strategy-order | EMA200 regime flip with ATR buffer and 2-bar confirmation; reversing long/short, 4 ATR stop, short TPs at 4/7  |
| vwap-suite-trend-mean-reversion-with-adaptive-filters | 2 | trend | strategy-order | Daily-anchored VWAP with stdev bands; default trend mode trades VWAP crosses filtered by volume, ATR, bandwidt |
| vumanchu-wt-zero-cross-strategy-v1-2-3 | 2 | oscillator | strategy-order | WaveTrend WT1 zero-line cross after a swing of at least 10 beyond zero; reverses positions, ATR stop, partial  |
| hyperliquid-ready-webhook-strategy-template | 2 | trend | strategy-order | EMA21/EMA55 cross with RSI50 filter; 1.5 ATR stop, 3 ATR target, 2 ATR ratcheting trail; JSON webhook payloads |
| adaptive-multi-facto-9-years | 2 | oscillator | none | Eight-factor vote (MACD, stoch, momentum, RSI, vortex, DMI, MFI, Fisher) plus PSAR side; long at score >= 4, s |
| ai-triple-confirmation-strategy | 2 | breakout | strategy-order | Long when EMA50>EMA200, RSI>55 and close crosses the last 5/5 swing high; mirror for shorts. ATR stop, 3R targ |
| apex-fusion-ai-smart-trend-engine | 2 | trend | strategy-order | Additive score of EMA200, SuperTrend, volume spike, MACD, momentum, fractal break, fib zone, POC proxy; score  |
| nq-scalp-fix-signals | 2 | trend | strategy-order | EMA 5/24/150 stack trend scalp: close crosses EMA5 in trend direction with RSI 55/45 filter; fixed 1.5 ATR sto |
| ema-pullback-trend-continuation-strategy-with-volume-and-momentu | 2 | trend | strategy-order | In a 50/200 EMA trend, buy when price touched the 50 EMA last bar and closes back on the trend side, with abov |
| amit-eth-strategy | 2 | trend | none | MACD(12,26,9) signal-line cross confirmed by close versus EMA18; exits on opposite MACD cross or close through |
| amit-eth-strategy-tv-strategies | 2 | trend | none | MACD(12,26,9) signal-line cross confirmed by close versus EMA18; exits on opposite MACD cross or close through |
| albtrader-nq-beast-supertrend-macd-rsi | 2 | trend | strategy-order | Supertrend(3,10) direction plus MACD signal cross, RSI guard and EMA200 bias; 1.2 ATR stop, 2 ATR target, exit |
| ahlenaz | 2 | breakout | strategy-order | EMA50/200 trend filter plus 20-bar high/low breakout on a 1.5x volume candle; ATR stop via strategy.exit. |
| supertrend-bb-strategy | 2 | trend | strategy-order | Supertrend(10,3) flip confirmed by close on the right side of SMA50; fixed 1.5 ATR stop and 1.5R limit target, |
| vwap-mean-reversion-strategy-with-session-and-volume-filter | 2 | mean-reversion | strategy-order | Fade price stretched 1.5 ATR beyond daily VWAP on below-average volume during 9:45-15:15 ET; target VWAP, stop |
| supertrend-strategy | 2 | trend | strategy-order | SuperTrend(10,3) stop-and-reverse strategy: enter long on flip to uptrend, short on flip to downtrend, with th |
| supertrend | 2 | trend | plot | Classic SuperTrend (ATR 10, factor 3) trailing band; trend flips when close crosses the opposite band, line ac |
| trend-efficiency-framework | 2 | trend | strategy-order | Trend with EMA20/50 direction plus efficiency ratio (net move / path over 20 bars) above 0.55; ATR 1.5x stop,  |
| market-breadth-trend-strategy | 2 | trend | strategy-order | Long while EMA50>EMA200 and 20-bar share of closes above EMA200 >60%; short mirror <40%. ATR 1.5x stop, 2R tar |
| ac20-55emagdcrosstest | 2 | trend | none | Always-in-market EMA20/EMA55 crossover strategy: golden cross reverses to long, death cross reverses to short. |
| amd-po3-with-live-edge-stats | 1 | structure | alert-text | Detects a compressed range, waits for a one-sided sweep that closes back inside, then opens a reversal referen |
| stealthtrail-supertrend-ml-pro | 1 | trend | alert-text | Self-tuning SuperTrend (regime-weighted ATR length, multiplier, cushion, cooldown). Trades confirmed band flip |
| squeeze-breakout-pro | 1 | breakout | alert-text | Locks the high/low of a Bollinger-inside-Keltner squeeze (ADX below 21), then trades a confirmed close outside |
| tp-sl-toolkit | 1 | trend | strategy-order | Teaching strategy: EMA 9/21 crossover entries wrapped in reusable exits, by default a 2x ATR target and stop,  |
| aetheredge-triaxial-consensus-strategy | 1 | trend | strategy-order | Scores trend, momentum and volatility axes (-100..100) with adaptive weights, regime multipliers and 1h/4h ali |
| abcd-harmonic-projection | 1 | pattern | alert-text | ZigZag pivots form an A-B-C swing; when BC retraces 38-89% of AB with a sufficient score, it trades the projec |
| cause-effect | 1 | breakout | no | Wyckoff cause and effect: finds 20+ bar ranges capped at 3.5x ATR(200), trades the close out of the range, pro |
| parallax-covenant-strategy | 1 | trend | strategy-order | Ichimoku-style composite baseline regime, body-pressure oscillator, RSI price mapping, pivot/volume zones, wav |
| universal-aggressive-trend-macd-v3-3-trailing-tp | 1 | trend | strategy-order | Trend-following MACD(14,39,9): a fresh cross or 5-bar breakout continuation, filtered by EMA99 side and slope, |
| trend-pulse-channel-strategy | 1 | breakout | none | Four cascaded EMAs approximate a Gaussian channel (period 144) with true-range bands; long when close crosses  |
| 3-way-bollinger-trend | 1 | trend | no | Pullback entry: price crosses back over the HMA(20) centre line and holds two bars, in the direction of the la |
| multi-ma-slope-adx | 1 | trend | strategy-order | ALMA(9) slope turning or accelerating with ADX above 20 and rising opens a trade; a ratcheting ATR-percent sto |
| concordance-allocation-strategy | 1 | trend | strategy-order | Trades with an adaptive ATR bias band when a two-state trend/range probability, smoothed-stochastic momentum a |
| aureate-market-architecture-strategy | 1 | trend | strategy-order | Regime (ATR ratio, range balance), structure bias (BOS over 13-bar pivots plus EMA 21/55), multi-ROC pressure  |
| gravity-trend-adx-strength-meter-quality-scored-dmi-system | 1 | trend | strategy-order | DMI trend regime (DI side, ADX>=20, DI spread>10, price versus EMA 50) entered on a pullback through EMA 9 and |
| master-structural-engine | 1 | trend | strategy-order | Pullback in an EMA 5/100/200 channel trend with RSI, Heikin Ashi wick, doji, spike and compression filters; st |
| slope-ma-cross-acc-range-filter | 1 | trend | strategy-order | Hull MA(100) slope-acceleration zero-cross entries, gated by a slope-angle trend filter, with percent stop, sh |
| concordance-execution-model | 1 | trend | strategy-order | Score of pivot-structure break, 4h EMA bias, multi-timeframe ALMA vote, kinetic filter, regression R2 and delt |
| reverse-bb-kc | 1 | mean-reversion | strategy-order | Fades the first Keltner breakout after a BB-inside-KC squeeze ends: bullish close above KC upper goes short, b |
| fast-v-slow-moving-averages-strategy-variable-divonn1994 | 1 | trend | none | Fast (24) versus slow (65) moving average; long on fast crossing above slow, exit (or short if enabled) on cro |
| tradleware-gaussian-channel-stochrsi-eth | 1 | breakout | strategy-order | Long-only Gaussian channel breakout: close above rising upper band, StochRSI extreme, above 200-bar SMA, green |
| tradleware-gaussian-channel-stochrsi-btc | 1 | breakout | strategy-order | Long-only Gaussian channel (144) breakout: close above rising upper band with StochRSI K > 80 or < 15; exit be |
| strategy-461-ts-m15 | 1 | pattern | strategy-order | Sweep candle: after an opposite-coloured bar, the bar takes only the prior low (or high) and closes back. Trad |
| ms-hypersupertrend | 1 | trend | strategy-order | Three Supertrends (ATR 10/11/12, factors 1/2/3) plus EMA233. Long when all three turn bullish above the EMA; e |
| autotrade-bot-v12 | 1 | trend | alert-text | Liquidity sweep of a 14-bar low/high, then reclaim with HMA20 and 1H EMA115 rising/falling and Williams %R con |
| bitcoin-superflip-supertrend-ema-trend-following-strategy | 1 | trend | none | Supertrend(10,1.8) flip taken only in the direction of the 200 EMA (optional ADX filter); positions closed on  |
| trendshift-supertrend-adx-regime-adaptive-strategy | 1 | trend | none | Supertrend whose multiplier switches between tight (ADX>25) and wide (ADX<20); flips are entries, blocked in c |
| optimized-keltner-channels-strategy | 1 | breakout | none | Keltner channel (EMA20, 2x ATR10) breakout: close crossing a band places a stop order one tick past that bar's |
| vumanchu-wt-zero-cross-v1-1b | 1 | oscillator | strategy-order | WaveTrend WT1 crossing zero reverses long/short; optional EMA200 filter; each position stopped at a higher-tim |
| donchian-breakout-with-atr-trailing-stop-trend-following | 1 | breakout | strategy-order | Close above prior 20-bar high and EMA200 goes long (short optional, off); 2.5 ATR ratcheting trailing stop; fl |
| vumanchu-wt-zero-cross-strategy-v1-2-2 | 1 | oscillator | none | WaveTrend WT1 zero-line cross stop-and-reverse strategy; takes 50% profit when WT1/WT2 cross in the opposite e |
| vwap-reversal-strategy-v1 | 1 | mean-reversion | strategy-order | Daily VWAP breakout-retest: after a close crosses VWAP, a retest and confirming candle within 10 bars enters,  |
| institutional-ob-entry-exit-sl-strategy | 1 | structure | strategy-order | After a 20-bar break of structure, buys a retest of the last opposite candle (order block) with EMA50/200, RSI |
| quanloki-qqe-system-opposite-signal-only-points | 1 | oscillator | none | QQE: smoothed RSI crossing its ATR-of-RSI trailing band; always-in stop-and-reverse, positions closed only by  |
| compression-breakout-system | 1 | breakout | plot | Long-only: after a bottom-quartile Bollinger width rank, buy a close above the prior 20-bar high on above-aver |
| nnfx-btc-ssl-qqe-signalforge | 1 | trend | strategy-order | NNFX-style strategy: source crosses its 20 EMA baseline, filtered by a smoothed RSI (QQE-like) histogram and b |
| oi-cvd-ichimoku-pro-strategy | 1 | trend | strategy-order | EMA13/25 cross filtered by open-interest change or CVD sign and price beyond the Ichimoku cloud; ATR stop, two |
| nas100-ema-scalper | 1 | trend | none | EMA10/20 cross in the direction of the 50/200 EMA trend, with EMA5>10>20 stack and candle colour filter in sca |
| session-king-alma-with-session-filter | 1 | session | strategy-order | Trades the side of an ALMA(9) baseline only inside London and NY AM windows, optional TTM squeeze gate, 3 ATR  |
| my-strategy-9 | 1 | trend | none | TradingView default template: SMA14/SMA28 crossover always-in-market reversal, plus unrelated plots of daily,  |
| lvn-rejection-acceptance-strategy | 1 | other | strategy-order | 'LVN' is just SMA40 +/- 0.8 ATR band; long on low-volume rejection of lower band or two closes above upper ban |
| box-breakout-strategy-dt4b-trader | 1 | breakout | strategy-order | Close beyond the prior 20-bar high/low with above-average volume enters; ATR 1.5x stop and 2R limit. |
| stochastic-bot-with-sl-tp | 1 | mean-reversion | strategy-order | Long-only: Stochastic %K crosses over %D below 20; exit at 2.5% stop, 6% target, or %K crossing under %D above |
| rsi-volume-ladder | 0 | mean-reversion | strategy-order | Long-only dip buyer: RSI(14) under 30 with volume above 1.5x its SMA20, averaging down up to three fills 1.5%  |

## The static audit against the model readers

Each reader confirmed or rejected the rule-based audit's findings for its scripts.

| Audit finding | Confirmed | Rejected | Confirmed share |
|---|---|---|---|
| side-against-drawing | 13 | 1 | 93% |
| side-dropped | 18 | 13 | 58% |
| not-an-entry | 80 | 96 | 45% |
| own-stop-discarded | 5 | 1 | 83% |
| levels-plotted-unread | 104 | 45 | 70% |
| levels-not-exported | 87 | 271 | 24% |
| alerts-off-by-default | 22 | 13 | 63% |
| late-pivot | 142 | 24 | 86% |
| lookahead | 15 | 30 | 33% |
| no-entry-read | 963 | 145 | 87% |

## Files

- `contracts.jsonl`: one contract per script, with each misread marked confirmed, refuted, unchecked or not-trading.
- `proposed-readings.json`: for each trading scanner with a confirmed misread, its current reading, the proposed reading and the evidence.

