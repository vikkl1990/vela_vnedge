# Script audit

Generated 2026-11-11 by `npm run script-audit`. A static read of 2640 Pine sources against the bot's reading of each. Findings are proposals to confirm, not changes.

### All scripts (2640 scripts)

| Finding | Scripts |
|---|---|
| A marker is traded on the side opposite to its drawing | 14 |
| One side of a mirrored pair is not traded | 29 |
| A traded title reads like a state change or information | 156 |
| The script's own stop is sent and discarded | 6 |
| Own stop or targets are plotted and unread | 149 |
| Own stop or targets exist only in variables or drawings | 358 |
| Alert switches default to off | 37 |
| Pivots confirm ten or more bars late | 168 |
| Higher-timeframe data can look ahead | 45 |
| Nothing reads as an entry | 1108 |

### Scripts with a written reading (119 scripts)

| Finding | Scripts |
|---|---|
| A marker is traded on the side opposite to its drawing | 3 |
| One side of a mirrored pair is not traded | 6 |
| A traded title reads like a state change or information | 15 |
| The script's own stop is sent and discarded | 0 |
| Own stop or targets are plotted and unread | 0 |
| Own stop or targets exist only in variables or drawings | 21 |
| Alert switches default to off | 16 |
| Pivots confirm ten or more bars late | 18 |
| Higher-timeframe data can look ahead | 2 |
| Nothing reads as an entry | 3 |

### Enabled scanners (18 scripts)

| Finding | Scripts |
|---|---|
| A marker is traded on the side opposite to its drawing | 2 |
| One side of a mirrored pair is not traded | 6 |
| A traded title reads like a state change or information | 5 |
| The script's own stop is sent and discarded | 0 |
| Own stop or targets are plotted and unread | 1 |
| Own stop or targets exist only in variables or drawings | 1 |
| Alert switches default to off | 3 |
| Pivots confirm ten or more bars late | 4 |
| Higher-timeframe data can look ahead | 0 |
| Nothing reads as an entry | 0 |

## Enabled scanners, finding by finding

**Structure-Anchored VWAP** (`structure-anchored-vwap`, 1389 lines)

- medium, alerts-off-by-default, line 227: 2 alert switches default to off: "Alert on TP / Break-Even", "Alert on New Leg / VWAP Cross". Turn them on in the scanner inputs if the bot should hear those events (targets, break-even, exits).
- review, late-pivot, line 412: A pivot is confirmed 55 bars after it happens: 13.8 h on 15m, 55 h on 1h, 220 h on 4h. Check that signals built on it are still timely on each timeframe; shorten the pivot length where the author suggests it.

**Liquidity Trail Matrix** (`liquidity-trail-matrix`, 1494 lines)

- medium, alerts-off-by-default, line 308: 2 alert switches default to off: "Alert on TP / Break-Even", "Alert on LVN Break". Turn them on in the scanner inputs if the bot should hear those events (targets, break-even, exits).

**Trend Lines** (`trend-lines`, 163 lines)

- review, late-pivot, line 52: A pivot is confirmed 50 bars after it happens: 12.5 h on 15m, 50 h on 1h, 200 h on 4h. Check that signals built on it are still timely on each timeframe; shorten the pivot length where the author suggests it.

**Kinetic Momentum Vectors** (`kinetic-momentum-vectors`, 122 lines)

- medium, side-dropped, line 119: "Bull Spike" is traded as a long; its mirror "Bear Spike" is not (not in the allow-list). Trade "Bear Spike" as a short, so the script is read on both sides.
- review, not-an-entry, line 120: "Bull Spike" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.

**Session Killzones & Breakouts** (`session-killzones-breakouts`, 464 lines)

- medium, side-dropped, line 408: "Asia Bull Breakout" is traded as a long; its mirror "Asia Bear Breakout" is not (not in the allow-list). Trade "Asia Bear Breakout" as a short, so the script is read on both sides.

**Pivot Channel Breaks** (`pivot-channel-breaks`, 210 lines)

- medium, side-dropped, line 123: "Break Up" is traded as a long; its mirror "Break Dn" is not (the reading switches it off). Trade "Break Dn" as a short, so the script is read on both sides.
- review, late-pivot, line 45: A pivot is confirmed 10 bars after it happens: 2.5 h on 15m, 10 h on 1h, 40 h on 4h. Check that signals built on it are still timely on each timeframe; shorten the pivot length where the author suggests it.

**Smart Money Breakout Signals** (`smart-money-breakout-signals`, 289 lines)

- medium, side-dropped: The allow-list trades the alert "Bullish Breakout Detected"; the script also sends "Bearish Breakout Detected", which is not traded. Add "Bearish Breakout Detected" to the allow-list, so the script is read on both sides.
- medium, levels-not-exported: The script computes its own stop or targets, but only in variables or drawings the bot cannot read. Add plot() exports for those levels in the patch layer, then read them.
- review, late-pivot, line 13: A pivot is confirmed 25 bars after it happens: 6.3 h on 15m, 25 h on 1h, 100 h on 4h. Check that signals built on it are still timely on each timeframe; shorten the pivot length where the author suggests it.

**Smart Swing VWAP (Zeiierman)** (`smart-swing-vwap-zeiierman`, 620 lines)

- review, not-an-entry, line 612: "Bullish polarity flip" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 613: "Bearish polarity flip" is traded as a short entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 614: "Cross above AVWAP" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 615: "Cross below AVWAP" is traded as a short entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.

**Machine Learning RSI | AI Classification & Ranking (Zeiierman)** (`machine-learning-rsi-ai-classification-ranking-zeiierman`, 603 lines)

- medium, side-dropped, line 574: "ST Flip Up" is traded as a long; its mirror "ST Flip Dn" is not (no direction in the title). Trade "ST Flip Dn" as a short, so the script is read on both sides.
- review, not-an-entry, line 573: "ST Flip Up" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 589: "Trend Flip Up" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 590: "Trend Flip Down" is traded as a short entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.

**AI Predictive Flow (Zeiierman)** (`ai-predictive-flow-zeiierman`, 272 lines)

- medium, side-dropped, line 271: "Background Turned Bullish" is traded as a long; its mirror "Background Turned Bearish" is not (not in the allow-list). Trade "Background Turned Bearish" as a short, so the script is read on both sides.
- review, not-an-entry, line 270: "Background Turned Bullish" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.

**Trend Impulse Channels (Zeiierman)** (`trend-impulse-channels-zeiierman`, 108 lines)

- high, side-against-drawing, line 101: "Lower Retest" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower Retest" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 102: "Upper Retest" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper Retest" as a short, or record why the opposite reading is intended.
- review, not-an-entry, line 104: "Bullish Step" is traded as a long entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.
- review, not-an-entry, line 105: "Bearish Step" is traded as a short entry, but the title describes a state change or information. Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.

**RSI Volume Ladder** (`rsi-volume-ladder`, 118 lines)

- medium, levels-plotted-unread: The script computes its own stop or targets and plots them ("Take Profit", "Stop Loss", "Trafienie TP", "Trafienie SL"); no entry carries them. Read those plots as the stop and targets of the entry.

**Liquidity Trail Matrix | ATR maker** (`liquidity-trail-matrix-atr-maker`, 1494 lines)

- medium, alerts-off-by-default, line 308: 2 alert switches default to off: "Alert on TP / Break-Even", "Alert on LVN Break". Turn them on in the scanner inputs if the bot should hear those events (targets, break-even, exits).

**Trend Impulse Channels | continuation maker** (`trend-impulse-channels-zeiierman-maker`, 108 lines)

- high, side-against-drawing, line 101: "Lower Retest" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower Retest" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 102: "Upper Retest" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper Retest" as a short, or record why the opposite reading is intended.

## Readings that contradict the source

**Multi Ranges Volume Distribution** (`multi-ranges-volume-distribution`, 225 lines)

- high, lookahead, line 92: request.security reads "ticks" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Depth of Market (DOM)** (`depth-of-market-dom`, 748 lines)

- high, lookahead, line 328: request.security reads "ticks" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**HTF Candle Consistency** (`htf-candle-consistency`, 202 lines)

- high, lookahead, line 68: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**High Volume Pivot Support & Resistance Zones** (`high-volume-pivot-support-resistance-zones`, 281 lines)

- high, side-against-drawing, line 272: "Resistance Breakout" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Resistance Breakout" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 273: "Support Breakdown" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Support Breakdown" as a short, or record why the opposite reading is intended.

**Volume Acceptance Zones** (`volume-acceptance-zones`, 308 lines)

- high, side-against-drawing, line 292: "Upper Extremes" is drawn as a short (shape.arrowdown, location.abovebar) and read as a long. Read "Upper Extremes" as a short, or record why the opposite reading is intended.
- high, side-against-drawing, line 301: "Lower Extremes" is drawn as a long (shape.arrowup, location.belowbar) and read as a short. Read "Lower Extremes" as a long, or record why the opposite reading is intended.

**Trend Deviation Channel (Zeiierman)** (`trend-deviation-channel-zeiierman`, 434 lines)

- high, side-against-drawing, line 419: "Upper 2D Re-entry" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper 2D Re-entry" as a short, or record why the opposite reading is intended.
- high, side-against-drawing, line 420: "Lower 2D Re-entry" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower 2D Re-entry" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 422: "Upper 3D Re-entry" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper 3D Re-entry" as a short, or record why the opposite reading is intended.
- high, side-against-drawing, line 423: "Lower 3D Re-entry" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower 3D Re-entry" as a long, or record why the opposite reading is intended.

**Trend Impulse Channels (Zeiierman)** (`trend-impulse-channels-zeiierman`, 108 lines)

- high, side-against-drawing, line 101: "Lower Retest" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower Retest" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 102: "Upper Retest" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper Retest" as a short, or record why the opposite reading is intended.

**Dividend Calendar (Zeiierman)** (`dividend-calendar-zeiierman`, 508 lines)

- high, lookahead, line 226: request.security reads "time" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 227: request.security reads "close" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**False Breakout (Expo)** (`false-breakout-expo`, 86 lines)

- high, side-against-drawing, line 78: "False Breakout Up" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "False Breakout Up" as a short, or record why the opposite reading is intended.
- high, side-against-drawing, line 79: "False Breakout Down" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "False Breakout Down" as a long, or record why the opposite reading is intended.

**Candle Range** (`candle-range`, 787 lines)

- high, side-against-drawing, line 739: "Lower execution range sweep" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower execution range sweep" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 741: "Upper execution range sweep" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper execution range sweep" as a short, or record why the opposite reading is intended.

**AMD Po3 with Live Edge Stats WillyAlgoTrader  Version OrGa** (`amd-po3-with-live-edge-stats-willyalgotrader-version-orga`, 1324 lines)

- high, lookahead, line 330: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Ayoub SMC Analyst** (`ayoub-smc-analyst`, 168 lines)

- high, side-against-drawing, line 105: "Lower Low" is drawn as a long (shape.labelup, location.belowbar) and read as a short. Read "Lower Low" as a long, or record why the opposite reading is intended.

**Adaptive Structural Liquidity Map** (`adaptive-structural-liquidity-map`, 451 lines)

- high, side-against-drawing, line 151: "Upper Structural Sweep" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper Structural Sweep" as a short, or record why the opposite reading is intended.
- high, side-against-drawing, line 152: "Lower Structural Sweep" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower Structural Sweep" as a long, or record why the opposite reading is intended.

**Day/Session Separator for TTW** (`day-session-separator-for-ttw`, 1447 lines)

- high, lookahead, line 727: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 728: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Futures Settlement [DigitalD] - Labeled** (`futures-settlement-digitald-labeled`, 640 lines)

- high, lookahead, line 237: request.security reads "close" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 277: request.security reads "syminfo.expiration_date" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**VWAP + EMAs + Levels (ATR / Premarket / Yesterday)** (`vwap-emas-levels-atr-premarket-yesterday`, 161 lines)

- high, lookahead, line 109: request.security reads "atrTop" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 110: request.security reads "atrBottom" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Session Levels Pro** (`session-levels-pro`, 87 lines)

- high, lookahead, line 29: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Asian Box Breakout - EDA Tuned** (`asian-box-breakout-eda-tuned`, 167 lines)

- high, lookahead, line 61: request.security reads "close" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Delta MTF v3** (`delta-mtf-v3`, 1052 lines)

- high, lookahead, line 63: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 64: request.security reads "close" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 65: request.security reads "volume" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 199: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 200: request.security reads "close" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 324: request.security reads "high" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 325: request.security reads "low" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.
- high, lookahead, line 326: request.security reads "volume" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**No-Wick Retest Levels** (`no-wick-retest-levels`, 219 lines)

- high, side-against-drawing, line 209: "No Lower Wick" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "No Lower Wick" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 210: "No Upper Wick" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "No Upper Wick" as a short, or record why the opposite reading is intended.

**Pivot Points Standard** (`pivot-points-standard`, 165 lines)

- high, lookahead, line 54: request.security reads "open" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar. Do not trade signals that depend on it until a prefix-stability check passes.

**Significant Breakout Levels (FVG)** (`significant-breakout-levels-fvg`, 151 lines)

- high, side-against-drawing, line 146: "Resistance Breakout" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Resistance Breakout" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 147: "Support Breakout" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Support Breakout" as a short, or record why the opposite reading is intended.

**Trend Impulse Channels | continuation maker** (`trend-impulse-channels-zeiierman-maker`, 108 lines)

- high, side-against-drawing, line 101: "Lower Retest" is drawn as a long (shape.triangleup, location.belowbar) and read as a short. Read "Lower Retest" as a long, or record why the opposite reading is intended.
- high, side-against-drawing, line 102: "Upper Retest" is drawn as a short (shape.triangledown, location.abovebar) and read as a long. Read "Upper Retest" as a short, or record why the opposite reading is intended.

