# AlgoAlpha: every published script, studied and tested

143 scripts by AlgoAlpha are in the library. Each was run fresh on 5m, 15m, 1h and 4h across five markets (BTC, ETH, SOL, XRP, DOGE) with the live exit rules, exits resolved on 1m (5m/15m) or 15m (1h/4h) candles, fees including GST, the Scalper Offer, and a 10 bps cost stress. A script "passes" only with 30+ trades, a profit that survives the stress, at least three of five markets profitable and half the time windows positive — and passing earns a shadow-book slot, not live trading.

**Result: 3 of 143 pass. 56 produce any trade at all; 87 never signal an entry (they are dashboards, screeners and drawing tools), and 10 cannot run here.**

## Scripts that pass

| Script | Type | TF | Trades | Net | At 10 bps | Markets | Windows | What it does |
|---|---|---|---|---:|---:|---|---|---|
| **High Probability Order Blocks [AlgoAlpha]** | indicator | 4h | 168 | 629 | 362 | 4/5 | 4.4/8 | OVERVIEW This script detects and visualizes high-probability order blocks by combining a volatility-based z-score trigger with a statistical survival model inspired by Kaplan-Meier estimation. |
| **Support and Resistance Non-Repainting [AlgoAlpha]** | indicator | 4h | 145 | 176 | 56 | 4/5 | 4.6/8 | Elevate your technical analysis with the Non-Repainting Support and Resistance indicator from AlgoAlpha. |
| **Breakout Targets [AlgoAlpha]** | indicator | 1h | 65 | 278 | 27 | 3/5 | 4.0/8 | OVERVIEW This script identifies consolidation zones and provides automated breakout targets with risk management levels. |

## Scripts that trade but do not pass

| Script | Best TF | Trades | Net | At 10 bps | Why not | What it does |
|---|---|---:|---:|---:|---|---|
| Zero Lag Liquidity [AlgoAlpha] | 4h | 6 | 172 | 174 | too few trades (6) | OVERVIEW This script plots liquidity zones with zero lag using lower-timeframe wick profiles and high-volume wicks to mark key price reactions. |
| Volumetric Fair Value Gaps [AlgoAlpha] | 4h | 215 | 370 | 134 | 3.8/8 windows | 🎯 Introducing the Volumetric Fair Value Gaps by AlgoAlpha 🎯 Embrace the power of volume and price action with the Volumetric Fair Value Gaps (VFVG) indicator, designed meticulously by AlgoAlpha. |
| Session Range Breakouts With Targets [AlgoAlpha] | 5m | 22 | 67 | 73 | too few trades (22) | ⛓ ‍💥Session Range Breakouts With Targets Introducing the "Session Range Breakouts With Targets" indicator by AlgoAlpha, a powerful tool for traders to capitalize on session-based range breakouts and i… |
| High Volume Breakout Targets [AlgoAlpha] | 1h | 92 | 296 | 57 | 3.8/8 windows | OVERVIEW High Volume Breakout Targets identifies price zones formed by related pivot highs or pivot lows. |
| Exponential Trend [AlgoAlpha] | 4h | 41 | 161 | 46 | 1.8/8 windows | OVERVIEW This script plots an adaptive exponential trend system that initiates from a dynamic anchor and accelerates based on time and direction. |
| Smart Money Breakout Signals [AlgoAlpha] | 5m | 40 | 168 | 45 | 2.8/8 windows | Introducing the Smart Money Breakout Signals, a cutting-edge trading indicator designed to identify key structural shifts and breakout opportunities in the market. |
| Trend Targets [AlgoAlpha] | 4h | 58 | 47 | 11 | works on 2/5 markets only | OVERVIEW This script combines a smoothed trend-following model with dynamic price rejection logic and ATR-based target projection to give traders a complete visual framework for trading trend continua… |
| Liquidity Weighted Moving Averages [AlgoAlpha] | 15m | 1 | 4 | 3 | too few trades (1) | Description: The Liquidity Weighted Moving Averages by AlgoAlpha is a unique approach to identifying underlying trends in the market by looking at candle bars with the highest level of liquidity. |
| Reversal Signals & Trailing Stop [AlgoAlpha] | 1h | 66 | 59 | -20 | loses at 10 bps | OVERVIEW Reversal Signals & Trailing Stop identifies reversal attempts after price stretches away from a dynamic equilibrium. |
| Machine Learning Price Target Prediction Signals [AlgoAlpha] | 15m | 62 | 213 | -45 | loses at 10 bps | Introducing the Machine Learning Price Target Predictions, a cutting-edge trading tool that leverages kernel regression to provide accurate price targets and enhance your trading strategy. |
| Money Flow Divergence Zones [AlgoAlpha] | 4h | 155 | 172 | -75 | loses at 10 bps | OVERVIEW This script identifies key price levels where volume and momentum show significant disagreement, visualizing these areas as Money Flow Liquidity Zones. |
| Reversal and Breakout Signals [AlgoAlpha] | 4h | 542 | 549 | -172 | loses at 10 bps | 🌟 Introducing the Reversal and Breakout Signals by AlgoAlpha 🌟 This innovative tool is crafted to enhance your chart analysis by identifying potential reversal and breakout opportunities directly on y… |
| Swing Failure Zones and Signals [AlgoAlpha] | 5m | 68 | -37 | -226 | loses | Elevate your trading strategy with the Swing Failure Zones and Signals indicator by AlgoAlpha! |
| Swing Failure Signals [AlgoAlpha] | 4h | 90 | -200 | -241 | loses | OVERVIEW This script detects swing failure patterns by tracking how price interacts with recent swing highs and lows, then confirming those sweeps with a change in candle behavior. |
| Market Structure Confluence [AlgoAlpha] | 4h | 377 | 332 | -247 | loses at 10 bps | OVERVIEW This script is called "Market Structure Confluence" and it combines classic market structure analysis with a dynamic volatility-based band system to detect shifts in trend and momentum more r… |
| Liquidation Levels with Liquidity Sweeps/Breakouts [AlgoAlpha] | 4h | 878 | 585 | -256 | loses at 10 bps | 🌊 Dive into the depths of market liquidity with "Liquidation Levels with Liquidity Sweeps/Breakouts" - your ultimate tool for navigating the turbulent waters of trading! |
| Trend Strength Signals [AlgoAlpha] | 4h | 431 | -124 | -311 | loses | 🌟Introducing the Trend and Strength Signals indicator by AlgoAlpha ! |
| Trend Tracer [AlgoAlpha] | 5m | 161 | -179 | -354 | loses | OVERVIEW This tool builds a two-stage trend model that reacts to structure shifts while also showing how strong or weak the move is. |
| Kalman Step Signals [AlgoAlpha] | 5m | 109 | -17 | -356 | loses | Take your trading to the next level with the Kalman Step Signals indicator by AlgoAlpha! |
| Smart Money Liquidation Exploits [AlgoAlpha] | 5m | 112 | 83 | -375 | loses at 10 bps | OVERVIEW Smart Money Liquidation Exploits maps recent swing highs and lows as liquidity levels, then watches how price reacts when these levels are reached. |
| Reverse RSI Signals [AlgoAlpha] | 4h | 98 | -297 | -386 | loses | OVERVIEW This script introduces the Reverse RSI Signals system, an original approach that inverts traditional RSI values back into price levels and then overlays them directly on the chart as dynamic … |
| Standardized PSAR Oscillator [AlgoAlpha] | 5m | 99 | -295 | -483 | loses | Enhance your trading experience with the "Standardized PSAR Oscillator" 🪝, a powerful tool that combines the Parabolic Stop and Reverse (PSAR) with standardization techniques to offer more nuanced ins… |
| Liquidity Sweep Filter [AlgoAlpha] | 5m | 253 | 95 | -518 | loses at 10 bps | Unlock a deeper understanding of market liquidity with the Liquidity Sweep Filter by AlgoAlpha. |
| Nadaraya-Watson Regression Liquidity Sweeps [AlgoAlpha] | 4h | 342 | -282 | -520 | loses | OVERVIEW This script combines Nadaraya-Watson regression, momentum analysis, and liquidity level tracking into a single workflow. |
| Smart Money Volume Activity [AlgoAlpha] | 4h | 238 | -348 | -553 | loses | OVERVIEW This tool visualizes how Smart Money and Retail participants behave through lower-timeframe volume analysis. |
| Candlestick Reversal and Trend Signals [AlgoAlpha] | 4h | 819 | 297 | -565 | loses at 10 bps | Unleash your charting capabilities with the Candlestick Reversal and Trend Signals indicator by AlgoAlpha, your go-to tool for spotting pivotal market movements! |
| WaveTrend Ribbon [AlgoAlpha] | 4h | 1068 | 586 | -586 | loses at 10 bps | 🌟 Introducing the WaveTrend Ribbon by AlgoAlpha - Your Next-Level Trading Companion! |
| Smart Money Volume Index [AlgoAlpha] | 4h | 350 | -539 | -606 | loses | OVERVIEW This script measures buying and selling interest by comparing how price behaves on rising volume versus falling volume. |
| Self-Adaptive Trend Signals [AlgoAlpha] | 5m | 163 | -237 | -609 | loses | OVERVIEW This script builds on the SuperTrend by replacing its fixed ATR multiplier with one that learns from recent pullback behavior. |
| Rolling Point of Control (POC) [AlgoAlpha] | 4h | 715 | 70 | -637 | loses at 10 bps | Enhance your trading decisions with the Rolling Point of Control (POC) Indicator designed by AlgoAlpha! |
| Trend Continuation Signals [AlgoAlpha] | 4h | 573 | -184 | -761 | loses | Introducing the Trend Continuation Signals by AlgoAlpha 🌟 Elevate your trading game with this multipurpose indicator, designed to pinpoint trend continuation opportunities as well as highlight volatil… |
| Trinity Reversal Pattern [AlgoAlpha] | 5m | 121 | -354 | -803 | loses | OVERVIEW Trinity Reversal Pattern identifies three-candle reversal structures and marks the price extreme associated with each detected setup. |
| Liquidity Sweep Hunter Algo [AlgoAlpha] | 4h | 1085 | -37 | -962 | loses | OVERVIEW Liquidity Sweep Hunter Algo identifies liquidity highs and lows across three different lookback periods and keeps them active until they are mitigated. |
| Squeeze Momentum Oscillator [AlgoAlpha] | 4h | 946 | -143 | -989 | loses | 🎉 Introducing the Squeeze Momentum Oscillator by AlgoAlpha 🎊 Unlock the secrets of market dynamics with our innovative Squeeze Momentum Oscillator! |
| Dynamic Median Momentum Oscillator [AlgoAlpha] | 4h | 553 | -462 | -1000 | loses | OVERVIEW This script provides a momentum oscillator that uses a median-based approach rather than traditional averages to find the center of price action. |
| Multi-Spectral RSI Deviations [AlgoAlpha] | 4h | 1237 | 135 | -1047 | loses at 10 bps | 🌌 Multi-Spectral RSI Deviations by AlgoAlpha - Dive into Market Dynamics! |
| Change in State of Delivery CISD [AlgoAlpha] | 4h | 1153 | 90 | -1058 | loses at 10 bps | OVERVIEW This script tracks how price “changes delivery” after failed attempts to push in one direction. |
| Median Proximity Percentile [AlgoAlpha] | 4h | 1239 | 84 | -1088 | loses at 10 bps | 📊 Introducing the "Median Proximity Percentile" by AlgoAlpha, a dynamic and sophisticated trading indicator designed to enhance your market analysis! |
| Volume Weighted Median Oscillator [AlgoAlpha] | 4h | 893 | -223 | -1137 | loses | OVERVIEW This script measures price movement relative to a volume-weighted median instead of a simple average. |
| Price Action Fractal Forecasts [AlgoAlpha] | 5m | 255 | -633 | -1202 | loses | 🔮 Price Action Fractal Forecasts - Unleash the Power of Historical Patterns! |
| Reversal Signals [AlgoAlpha] | 5m | 247 | -707 | -1205 | loses | 🔄 Reversal Signals – Master Market Reversals with Precision! |
| Supertrended RSI [AlgoAlpha] | 4h | 841 | -604 | -1246 | loses | Introducing the Supertrended RSI Indicator by AlgoAlpha! |
| Zero Lag Trend Signals (MTF) [AlgoAlpha] | 5m | 259 | -996 | -1327 | loses | Zero Lag Trend Signals Ready to take your trend-following strategy to the next level? |
| Regression Trend Reversal Signals & Forecasts [AlgoAlpha] | 5m | 304 | -738 | -1396 | loses | OVERVIEW Regression Trend Reversal Signals & Forecasts combines multiple regression methods into a single trend and reversal framework. |
| Machine Learning Adaptive DMI Signals [AlgoAlpha] | 4h | 681 | -973 | -1398 | loses | OVERVIEW The Directional Movement Index (DMI) is commonly calculated using a fixed lookback length. |
| Fibonacci Entry Bands [AlgoAlpha] | 4h | 866 | -812 | -1497 | loses | OVERVIEW This script plots Fibonacci Entry Bands, a trend-following and mean-reversion hybrid system built around dynamic volatility-adjusted bands scaled using key Fibonacci levels. |
| Hullinger Bands [AlgoAlpha] | 4h | 1145 | -799 | -1514 | loses | 🎯 Introducing the Hullinger Bands Indicator ! |
| Donchian Trend Ranges [AlgoAlpha] | 4h | 735 | -1064 | -1553 | loses | 🔗 Donchian Trend Ranges 🔗 Elevate your trading game with the Donchian Trend Ranges indicator from AlgoAlpha! |
| Adaptive Schaff Trend Cycle (STC) [AlgoAlpha] | 4h | 1872 | -341 | -1671 | loses | Introducing the Adaptive Schaff Trend Cycle by AlgoAlpha: Elevate Your Trading Strategies Discover precision and adaptability with the Adaptive Schaff Trend Cycle 🎯, meticulously crafted for traders s… |
| Adaptive Smart Money Liquidity Sweep Levels [AlgoAlpha] | 4h | 1989 | -32 | -1753 | loses | OVERVIEW Adaptive Smart Money Liquidity Levels tracks liquidity resting above and below price by detecting swing highs and lows across multiple lookback periods. |
| Standardized Median Proximity [AlgoAlpha] | 4h | 1345 | -952 | -1809 | loses | Introducing the Standardized Median Proximity by AlgoAlpha 📊 – a dynamic tool designed to enhance your trading strategy by analyzing price fluctuations relative to the median value. |
| Amazing Oscillator (AO) [Algoalpha] | 4h | 1160 | -1592 | -2153 | loses | Description: Introducing the Amazing Oscillator indicator by Algoalpha, a versatile tool designed to help traders identify potential trend shifts and market turning points. |
| AI Adaptive Money Flow Index (Clustering) [AlgoAlpha] | 4h | 2698 | -808 | -2699 | loses | 🌟 Dive into the future of trading with our latest innovation: the AI Adaptive Money Flow Index by AlgoAlpha Indicator! |

## Scripts that never signal an entry

These draw levels, zones, dashboards or screens; they have no entry a bot can act on.

| Script | Type | Status | What it does |
|---|---|---|---|
| Smart Money Breakout Channels [AlgoAlpha] | indicator | runs | OVERVIEW This script draws breakout detection zones called “Smart Money Breakout Channels” based on volatility-normalized price movement and visualizes them as dynamic boxes with volume overlays. |
| Machine Learning Adaptive SuperTrend [AlgoAlpha] | indicator | runs | 🤖 Machine Learning Adaptive SuperTrend - Take Your Trading to the Next Level! |
| HEMA Trend Levels [AlgoAlpha] | indicator | runs | OVERVIEW This script plots two Hull-EMA (HEMA) curves to define a color-coded dynamic trend zone and generate context-aware breakout levels, allowing traders to easily visualize prevailing momentum an… |
| Volume Sentiment Breakout Channels [AlgoAlpha] | indicator | runs | OVERVIEW This tool visualizes breakout zones based on volume sentiment within dynamic price channels . |
| Liquidation Reversal Signals [AlgoAlpha] | indicator | runs | OVERVIEW This tool detects potential liquidation-driven reversals by combining z-score analysis of up/down volume with the classic Supertrend. |
| Orderblock Footprints [AlgoAlpha] | indicator | runs | OVERVIEW This script highlights orderblocks and then drills into what actually trades inside them. |
| Dynamic Supply and Demand Zones [AlgoAlpha] | indicator | runs | Introducing the Dynamic Supply and Demand Zones by AlgoAlpha. |
| Breakout and Retest Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script detects breakout and retest signals by identifying key pivot points in price action and analyzing their relationship with historical swing highs and lows. |
| Activity and Volume Orderflow Profile [AlgoAlpha] | indicator | runs | 🔍 Activity and Volume Orderflow Profile 📊 Unlock the power of market order flow analysis with the Activity and Volume Orderflow Profile indicator by AlgoAlpha . |
| Whale Liquidity and Absorption Profile [AlgoAlpha] | indicator | runs | OVERVIEW The Whale Liquidity and Absorption Profile maps intrabar buying, selling, delta, and absorption activity into stacked horizontal profiles. |
| Stochastic Z-Score [AlgoAlpha] | indicator | runs | OVERVIEW This indicator is a custom-built oscillator called the Stochastic Z-Score , which blends a volatility-normalized Z-Score with stochastic principles and smooths it using a Hull Moving Average … |
| Machine Learning Key Levels [AlgoAlpha] | indicator | runs | OVERVIEW This script plots Machine Learning Key Levels on your chart by detecting historical pivot points and grouping them using agglomerative clustering to highlight price levels with the most past … |
| Momentum Bias Index [AlgoAlpha] | indicator | runs | Description: The Momentum Bias Index by AlgoAlpha is designed to provide traders with a powerful tool for assessing market momentum bias. |
| Double Top/Bottom [AlgoAlpha] | indicator | runs | Introducing the Double Top/Bottom Indicator by AlgoAlpha, a powerful tool designed to identify key reversal patterns in the market with precision. |
| Trend Reversal Probability [Algoalpha] | indicator | runs | Introducing Trend Reversal Probability by AlgoAlpha – a powerful indicator that estimates the likelihood of trend reversals based on an advanced custom oscillator and duration-based statistics. |
| Triple Smoothed Signals [AlgoAlpha] | indicator | runs | Introducing the Triple Smoothed Signals indicator by AlgoAlpha, a powerful tool designed to help traders identify trend direction and market momentum with greater accuracy. |
| Smart Money Interest Index [AlgoAlpha] | indicator | runs | 🌟 Smart Money Interest Index by AlgoAlpha 🌟 Welcome to the innovative Smart Money Interest Index indicator, designed meticulously by AlgoAlpha to revolutionize the way you trade! |
| MA OrderBlocks [AlgoAlpha] | indicator | runs | 🟨 HMA OrderBlocks by AlgoAlpha is a powerful tool designed to help traders visualize key pivot zones and order blocks based on the Hull Moving Average (HMA). |
| Inversion Fair Value Gap Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script is a custom signal tool called Inversion Fair Value Gap Signals (IFVG) , designed to detect, track, and visualize fair value gaps (FVGs) and their inversions directly on price cha… |
| SuperTrend Confluence Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script enhances the classic SuperTrend indicator by integrating volume dynamics, retracement detection, and a multi-asset trend matrix—alongside an automatic mitigation-level drawing sys… |
| Volume Divergence Reversal Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script identifies potential trend reversals by analyzing divergences between price action and normalized volume. |
| Ranges and Breakouts [AlgoAlpha] | indicator | runs | 💥 Ranges and Breakouts by AlgoAlpha is a dynamic indicator designed for traders seeking to identify market ranges and capitalize on breakout opportunities. |
| Fourier Smoothed Volume Zone Oscillator (FSVZO) [AlgoAlpha] | indicator | unavailable | Description The Fourier Smoothed Volume Zone Oscillator (FSVZO) is an implementation of the Discrete Fourier Transform in a Volume Zone Oscillator. |
| SuperTrend Take-Profit Dimensions [AlgoAlpha] | indicator | runs | OVERVIEW A multi-dimensional take-profit aid that scores how typical the current bar looks compared to past SuperTrend pivots, so you can tell when a trend has reached favorable exit conditions. |
| Smart Signals Assistant [AlgoAlpha] | indicator | unavailable | OVERVIEW The Smart Signals Assistant is a comprehensive, all-in-one trading toolkit designed to provide a complete analytical framework on your chart. |
| Range Filtered Trend Signals [AlgoAlpha] | indicator | runs | Introducing the Range Filtered Trend Signals , a cutting-edge trading indicator designed to detect market trends and ranging conditions with high accuracy. |
| Smoothed Gaussian Trend Filter [AlgoAlpha] | indicator | runs | Experience seamless trend detection and market analysis with the Smoothed Gaussian Trend Filter by AlgoAlpha! |
| Reversal Probability Profile [AlgoAlpha] | indicator | runs | OVERVIEW Reversal Probability Profile maps where confirmed price reversals have historically concentrated. |
| Support and Resistance Retest Breakout Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script identifies support and resistance zones using pairs of swing highs and swing lows that occur within a volatility-adjusted price tolerance. |
| Standardized Orderflow [AlgoAlpha] | indicator | runs | Introducing the Standardized Orderflow indicator by AlgoAlpha. |
| Equal High/Low (EQH/EQL) [AlgoAlpha] | indicator | runs | OVERVIEW This script detects and visualizes Equal High (EQH) and Equal Low (EQL) zones—key liquidity areas where price has previously stalled or reversed. |
| Breaker Blocks Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script automates the detection of Breaker Blocks, a popular smart money concept used to identify high-probability reversal zones. |
| Fair Value Gap Profiles [AlgoAlpha] | indicator | runs | OVERVIEW This script draws and manages Fair Value Gap (FVG) zones by detecting unfilled gaps in price action and then augmenting them with intra-gap volume profiles from a lower timeframe. |
| Trend Magic Enhanced [AlgoAlpha] | indicator | runs | 🔥✨ Trend Magic Enhanced - Boost Your Trend Analysis! |
| Normalised Gaussian MACD Heikin Ashi [AlgoAlpha] | indicator | runs | 🌟 Introducing the Normalised Gaussian MACD Heikin Ashi by AlgoAlpha ! |
| Volume Weighted Relative Strength Index (VWRSI) [AlgoAlpha] | indicator | runs | Volume Weighted Relative Strength Index ✨ The Volume Weighted Relative Strength Index (VWRSI) by AlgoAlpha enhances traditional RSI by incorporating volume weighting, providing a more nuanced view of … |
| Alpha Schaff [AlgoAlpha] | indicator | unavailable | Description: The Alpha Schaff indicator is a proprietary technical analysis tool that incorporates a modified version of the Schaff Trend Cycle (STC) to generate trading signals. |
| Institutional Liquidity and Price Action Concepts [AlgoAlpha] | indicator | unavailable | Introducing the Institutional Liquidity and Price Action Concepts™ (ILPAC) , a comprehensive toolkit developed by AlgoAlpha as part of our Premium Collection. |
| Fibonacci Trend Continuation Signals [AlgoAlpha] | indicator | runs | OVERVIEW Fibonacci Trend Continuation Signals maps Fibonacci retracement levels inside an adaptive trend structure. |
| Liquidity Depth [AlgoAlpha] | indicator | runs | OVERVIEW This script visualizes market liquidity by identifying key price levels where significant volume has transacted. |
| Half Trend Regression [AlgoAlpha] | indicator | runs | Introducing the Half Trend Regression indicator by AlgoAlpha, a cutting-edge tool designed to provide traders with precise trend detection and reversal signals. |
| Institutional Activity Index [AlgoAlpha] | indicator | runs | 🌟 Introducing the Institutional Activity Index by AlgoAlpha 🌟 Welcome to a powerful new indicator designed to gauge institutional trading activity! |
| Trend Flow Trail [AlgoAlpha] | indicator | runs | OVERVIEW This script overlays a custom hybrid indicator called the Money Flow Trail which combines a volatility-based trend-following trail with a volume-weighted momentum oscillator. |
| Momentum Trail Oscillator [AlgoAlpha] | indicator | runs | OVERVIEW This script builds a Momentum Trail Oscillator designed to measure directional momentum strength and dynamically track shifts in trend bias using a combination of smoothed price change calcul… |
| Fibonacci Volume Profiles [AlgoAlpha] | indicator | runs | Unlock a deeper understanding of price action with the Fibonacci Volume Profiles indicator by AlgoAlpha! |
| Power Root SuperTrend [AlgoAlpha] | indicator | runs | Power Root SuperTrend by AlgoAlpha - Elevate Your Trading Strategy! |
| Smart Money Liquidity Heatmap [AlgoAlpha] | indicator | runs | 🌟 Introducing the Smart Money Liquidity Heatmap by AlgoAlpha! |
| Flag Breakout Forecasts [AlgoAlpha] | indicator | runs | OVERVIEW This indicator detects converging price channels — commonly called flags or wedges — directly on the chart using a zigzag-based pivot detection algorithm. |
| Bollinger Bands Percentile + Stdev Channels (BBPct) [AlgoAlpha] | indicator | runs | Description: The "Bollinger Bands Percentile (BBPct) + STD Channels" mean reversion indicator, developed by AlgoApha, is a technical analysis tool designed to analyze price positions using Bollinger B… |
| Adaptive MACD Deluxe [AlgoAlpha] | indicator | runs | OVERVIEW This script is an advanced rework of the classic MACD indicator, designed to be more adaptive, visually informative, and customizable. |
| Linear Regression Intensity [AlgoAlpha] | indicator | runs | Introducing the Linear Regression Intensity indicator by AlgoAlpha, a sophisticated tool designed to measure and visualize the strength of market trends using linear regression analysis. |
| Machine Learning Support and Resistance [AlgoAlpha] | indicator | runs | Elevate Your Trading with Machine Learning Dynamic Support and Resistance! |
| Range Breakout Signals [AlgoAlpha] | indicator | runs | OVERVIEW This script detects range-bound market conditions and breakout signals using a combination of volatility compression and volume imbalance analysis. |
| HTF Volume Liquidity Profile [AlgoAlpha] | indicator | runs | OVERVIEW This tool projects a volume profile from a higher timeframe directly onto your current chart. |
| Volume Spread Analysis [AlgoAlpha] | indicator | runs | Unleash the power of Volume Spread Analysis (VSA) with our state-of-the-art indicator designed to detect market divergences and convergences, helping you make informed trading decisions. |
| Candlestick Trend Strength [AlgoAlpha] | indicator | runs | 🎉 Introducing the Candlestick Trend Strength by AlgoAlpha, a dynamic TradingView indicator designed to visually communicate the strength and direction of market trends right on your charts! |
| Moving Average Cross Probability [AlgoAlpha] | indicator | runs | Moving Average Cross Probability ✨ The Moving Average Cross Probability by AlgoAlpha calculates the probability of a cross-over or cross-under between the fast and slow values of a user defined Moving… |
| Net Buying/Selling Flows Toolkit [AlgoAlpha] | indicator | runs | 🌟📊 Introducing the Net Buying/Selling Flows Toolkit by AlgoAlpha 🔍 Explore the intricate dynamics of market movements with the Net Buying/Selling Flows Toolkit designed for precision and effectiveness… |
| Adaptive Resonance Oscillator [AlgoAlpha] | indicator | runs | Introducing the Adaptive Resonance Oscillator , an advanced momentum-based oscillator designed to dynamically adjust to changing market conditions. |
| Efficiency Weighted OrderFlow [AlgoAlpha] | indicator | runs | Introducing the Efficiency Weighted Orderflow Indicator by AlgoAlpha! |
| Adaptive SuperTrend Oscillator [AlgoAlpha] | indicator | runs | Adaptive SuperTrend Oscillator 🤖 Introducing the Adaptive SuperTrend Oscillator , an innovative blend of volatility clustering and SuperTrend logic designed to identify market trends with precision! |
| SuperTrend Fisher [AlgoAlpha] | indicator | runs | 🌟 Introducing the "Super Fisher" by AlgoAlpha, a sophisticated and versatile tool crafted for the discerning trader. |
| Trend Flow Profile [AlgoAlpha] | indicator | runs | Description: The "Trend Flow Profile" indicator is a powerful tool designed to analyze and interpret the underlying trends and reversals in a financial market. |
| BTC Supply in Profits and Losses (BTCSPL) [AlgoAlpha] | indicator | runs | Description: 🚨The BTC Supply in Profits and Losses (BTCSPL) indicator, developed by AlgoAlpha, offers traders insights into the distribution of INDEX:BTCUSD addresses between profits and losses based … |
| Backtest - Strategy Builder [AlgoAlpha] | strategy | unavailable | OVERVIEW This script by AlgoAlpha is a modular Strategy Builder designed to let traders test custom trade entry and exit logic on TradingView without writing their own Pine code. |
| Peak & Valley Levels [AlgoAlpha] | indicator | runs | The Peak & Valley Levels indicator is a sophisticated script designed to pinpoint key support and resistance levels in the market. |
| Visible Range Support and Resistance [AlgoAlpha] | indicator | runs | 🌟 Introducing the Visible Range Support and Resistance 🌟 Discover key support and resistance levels with the innovative "Visible Range Support and Resistance" indicator by AlgoAlpha! |
| VWAP Reversal Probability Signals | indicator | runs | OVERVIEW VWAP Reversal Probability Signals tracks price movements around an anchored VWAP and two volume-weighted standard deviation bands. |
| LRI Momentum Cycles [AlgoAlpha] | indicator | runs | Discover the LRI Momentum Cycles indicator by AlgoAlpha, a cutting-edge tool designed to identify market momentum shifts using trend normalization and linear regression analysis. |
| Squeeze & Release [AlgoAlpha] | indicator | runs | Introduction: 💡The Squeeze & Release by AlgoAlpha is an innovative tool designed to capture price volatility dynamics using a combination of EMA-based calculations and ATR principles. |
| Market Sentiment Fear and Greed [AlgoAlpha] | indicator | runs | Unleash the power of sentiment analysis with the Market Sentiment Fear and Greed Indicator! |
| MVRV Z-Score [AlgoAlpha] | indicator | runs | Introducing the ∑ MVRV Z-Score by AlgoAlpha, a dynamic and sophisticated tool designed for traders seeking to gain an edge in INDEX:BTCUSD analysis. |
| Volume-Trend Sentiment (VTS) [AlgoAlpha] | indicator | runs | Introducing the Volume-Trend Sentiment by AlgoAlpha, a unique tool designed for traders who seek a deeper understanding of market sentiment through volume analysis. |
| Market Pressure Index [AlgoAlpha] | indicator | runs | The Market Pressure Index is a cutting-edge trading tool designed to measure and visualize bullish and bearish momentum through a unique blend of volatility analysis and dynamic smoothing techniques. |
| Volume Exhaustion [AlgoAlpha] | indicator | runs | Introducing the Volume Exhaustion by AlgoAlpha, is an innovative tool that aims to identify potential exhaustion or peaks in trading volume , which can be a key indicator for reversals or continuation… |
| Hullinger Percentile Oscillator [AlgoAlpha] | indicator | runs | Introducing the Hullinger Percentile Oscillator by AlgoAlpha! |
| Unmitigated Liquidity Imbalances [AlgoAlpha] | indicator | runs | 🎉 Introducing the Unmitigated Liquidity Imbalance Indicator by AlgoAlpha! |
| Momentum Concepts [AlgoAlpha] | indicator | unavailable | Introducing the Momentum Concepts™ , a robust multi-layered momentum analysis tool developed by AlgoAlpha . |
| Limited Growth Stock-to-Flow (LGS2F) [AlgoAlpha] | indicator | runs | Description: The "∂ Limited Growth Stock-to-Flow (LG-S2F)" indicator, developed by AlgoAlpha, is a technical analysis tool designed to analyze the price of Bitcoin (BTC) based on the Stock-to-Flow mod… |
| Crypto Realized Profits/Losses Extremes [AlgoAlpha] | indicator | runs | 🌟 Introducing the Crypto Realized Profits/Losses Extremes Indicator by AlgoAlpha 🌟 Unlock the potential of cryptocurrency markets with our cutting-edge On-Chain Pine Script™ indicator, designed to hig… |
| Screener (MC) [AlgoAlpha] | indicator | unavailable | OVERVIEW This script is a multi-symbol scanner that works as a companion to the "Momentum Concepts" indicator. |
| Enhanced Candle Sticks [AlgoAlpha] | indicator | runs | 🌟 Introducing the Enhanced Candle Sticks by AlgoAlpha, a Pine Script tool designed to provide traders with an enhanced view of market dynamics through candlestick analysis. |
| Screener (SSA) [AlgoAlpha] | indicator | unavailable | OVERVIEW This script is a multi-symbol screener that serves as a dashboard companion to the "Smart Signals Assistant (SSA)" indicator. |
| Directional Bias [AlgoAlpha] | indicator | unavailable | The Directional Bias indicator is a premium script expertly crafted to enhance market trend visualization on trading charts. |
| Rolling Price Activity Heatmap [AlgoAlpha] | indicator | runs | Rolling Price Activity Heatmap 🔥 Enhance your trading experience with the Rolling Price Activity Heatmap , designed by AlgoAlpha to provide a dynamic view of price activity over a rolling lookback per… |
| Santa's Adventure [AlgoAlpha] | indicator | runs | Introducing "Santa's Adventure," a unique and festive TradingView indicator designed to bring the holiday spirit to your trading charts. |
| Screener (ILPAC) [AlgoAlpha] | indicator | unavailable | OVERVIEW This script is a powerful multi-symbol scanner designed to work as a companion to the "Institutional Liquidity & PA Concepts" (ILPAC) indicator. |
