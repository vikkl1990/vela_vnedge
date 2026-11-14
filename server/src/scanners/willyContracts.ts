/** Author roles reviewed 2026-11-13. Native mode is opt-in and evidence-versioned. */
export const WILLY_CONTRACTS = [
  {
    "publication": "M0FCXfZC",
    "name": "HTF Sweep CISD Setups",
    "url": "https://www.tradingview.com/script/M0FCXfZC-HTF-Sweep-CISD-Setups-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "htf-sweep-cisd-market"
    ],
    "entry": "An HTF liquidity sweep must precede lower-timeframe displacement/CISD and a qualifying PD-array setup. A diamond marks order placement; the later buy/sell event marks the model entry.",
    "exits": "Structural protection and multiple targets; pending limits can expire, invalidate or be cancelled before filling. Targets reached before a limit fills can cancel it.",
    "timing": "Confirmed chart bars; forming-HTF sweeps are possible unless HTF-close waiting is selected. Pivot drawings precede the time their structure becomes known."
  },
  {
    "publication": "4Y1T9TrB",
    "name": "ICT Structure Engine",
    "url": "https://www.tradingview.com/script/4Y1T9TrB-ICT-Structure-Engine-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "ict-structure-engine"
    ],
    "entry": "A sweep and displacement/CHoCH create a setup; the qualifying PD-array retest, location, daily bias and session conditions create the entry.",
    "exits": "Sweep/zone or ATR protection, targets, break-even and reversals belong to the trade lifecycle.",
    "timing": "Uses confirmed bars and higher-timeframe context. Pivot placement is retrospective. The author distinguishes intraday settings from higher-timeframe swing settings."
  },
  {
    "publication": "HnelYN0A",
    "name": "Gold Breakout 15M Strategy",
    "url": "https://www.tradingview.com/script/HnelYN0A-Gold-Breakout-15M-Strategy-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "gold-breakout-15m-strategy"
    ],
    "entry": "An overnight range sets opposing stop entries, with one trade per day and OCO behaviour. Defaults are specifically for OANDA gold on 15m with broker-time session boundaries.",
    "exits": "Percentage protection is reset from the fill; a scheduled end-of-day exit closes the remaining trade.",
    "timing": "Stop-order activation and session times matter. Alert order levels are not necessarily the broker execution price."
  },
  {
    "publication": "mAqEoupb",
    "name": "Wyckoff Range Engine",
    "url": "https://www.tradingview.com/script/mAqEoupb-Wyckoff-Range-Engine-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "wyckoff-range-engine"
    ],
    "entry": "ATR swings establish a range, then spring/test/strength phases lead to an LPS confirmation by default; earlier spring entries are optional.",
    "exits": "Structural stop, R targets, break-even and opposite-direction handling. One internal trade is tracked.",
    "timing": "Trade at the confirmation event, not at a pattern label drawn on an earlier bar. Needs enough range and swing history."
  },
  {
    "publication": "ezWSw2f8",
    "name": "Manual Wedge Setup",
    "url": "https://www.tradingview.com/script/ezWSw2f8-Manual-Wedge-Setup-WillyAlgoTrader/",
    "role": "Manual / restricted",
    "scannerIds": [
      "manual-wedge-setup"
    ],
    "entry": "The user chooses four candles to define a wedge; the script then evaluates the first breakout and projects a plan.",
    "exits": "Wedge-derived targets and protection, with optimistic target priority in ambiguous bars.",
    "timing": "Historical anchor selection introduces discretion and hindsight; the supplied timestamps do not define an autonomous market scanner."
  },
  {
    "publication": "kcyXDIFe",
    "name": "Reaction Level Matrix",
    "url": "https://www.tradingview.com/script/kcyXDIFe-Reaction-Level-Matrix-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "reaction-level-matrix"
    ],
    "entry": "Confirmed pivots form levels; reaction strength, clustering and decay identify useful support/resistance. Qualified rejection events provide entries.",
    "exits": "A stop, three targets, break-even and reversal handling accompany the model trade.",
    "timing": "Levels become available after pivot confirmation and can be refined as later reactions accumulate. The score describes observed strength, not win probability."
  },
  {
    "publication": "E31jKiTS",
    "name": "Structure-Anchored VWAP",
    "url": "https://www.tradingview.com/script/E31jKiTS-Structure-Anchored-VWAP-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "structure-anchored-vwap",
      "structure-anchored-vwap-pivots",
      "structure-anchored-vwap-upstream-2-0"
    ],
    "entry": "Structural anchors define a volume-weighted leg. The 12 November v1.2.1 update requires close confirmation for retests by default and allows a three-bar reclaim window.",
    "exits": "ATR protection and R targets; the new version can close an opposing trade when the VWAP leg flips. Existing-position management precedes new entries.",
    "timing": "Confirmed pivots are available later than their drawn anchors. The update adds a sigma floor and changes entry/exit behaviour, not just appearance."
  },
  {
    "publication": "hkKioUnL",
    "name": "AMD Po3 with Live Edge Stats",
    "url": "https://www.tradingview.com/script/hkKioUnL-AMD-Po3-with-Live-Edge-Stats-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "amd-po3-with-live-edge-stats"
    ],
    "entry": "A mature compressed range is swept and reclaimed; the distribution confirmation is actionable. A sweep alone is a pending setup.",
    "exits": "Structural invalidation, extension target and maximum holding time define a reference cycle. Ambiguous candles favour the stop.",
    "timing": "Warmup and range maturity intentionally delay signals. v2.4 limits cumulative sweep depth, resets opposite breaches and freezes relevant geometry."
  },
  {
    "publication": "ngb1s23R",
    "name": "STRAT Trap & VWAP Engine",
    "url": "https://www.tradingview.com/script/ngb1s23R-STRAT-Trap-VWAP-Engine-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "strat-trap-vwap-engine"
    ],
    "entry": "STRAT candle sequences arm a trigger with expiry; independent trap setups also exist. Regime, volume and risk checks qualify the actual trade.",
    "exits": "Structural stop, R targets and break-even. Bare pattern alerts do not necessarily mean a new position opened.",
    "timing": "Optional Full Timeframe Continuity uses forming HTF information; it is off by default and changes replay parity when enabled."
  },
  {
    "publication": "eQPdoeM6",
    "name": "Elliott Impulse Engine",
    "url": "https://www.tradingview.com/script/eQPdoeM6-Elliott-Impulse-Engine-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "elliott-impulse-engine"
    ],
    "entry": "CHoCH and confirmed pivots build an impulse and corrective-wave interpretation with projected levels.",
    "exits": "Wave invalidation and projection updates describe a pattern; they are not an executable position lifecycle.",
    "timing": "Unfinished wave points can move. Confirmed pivots arrive after their right-hand lookback, even if labels appear earlier."
  },
  {
    "publication": "ZoccxbOB",
    "name": "Trader Assistant Pro",
    "url": "https://www.tradingview.com/script/ZoccxbOB-Trader-Assistant-Pro-WillyAlgoTrader/",
    "role": "Manual / restricted",
    "scannerIds": [
      "trader-assistant-pro"
    ],
    "entry": "The public explanation describes a staged 1–2–3 reversal, an armed projection and a later confirmed trade.",
    "exits": "Three targets and stepwise stop management; later release notes describe a fuller exit-alert lifecycle.",
    "timing": "An armed zone can change before entry. The author’s chart results omit exchange frictions and use optimistic target ordering."
  },
  {
    "publication": "73fIFFEV",
    "name": "Reactive Trail System",
    "url": "https://www.tradingview.com/script/73fIFFEV-Reactive-Trail-System-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "reactive-trail-system"
    ],
    "entry": "ALMA with ATR/deviation bands forms a ratcheting trail; RSI momentum changes its tightness. Qualified flips pass HTF, volume and quality checks.",
    "exits": "Wick/ATR protection with three targets, break-even and reversal handling.",
    "timing": "Entries confirm at bar close and HTF context is closed-bar based. Choppy markets can still produce repeated flips."
  },
  {
    "publication": "Z4DiNsKb",
    "name": "Bitcoin Almanac",
    "url": "https://www.tradingview.com/script/Z4DiNsKb-Bitcoin-Almanac-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "bitcoin-almanac"
    ],
    "entry": "Calendar cycles and a fitted logarithmic curve provide a hypothetical long-term Bitcoin path, using a very small number of historical cycles.",
    "exits": "No autonomous intraday entry, stop or exchange-position lifecycle.",
    "timing": "Designed around daily/weekly Bitcoin history and manually chosen fit points. Extrapolation is not a forecast probability."
  },
  {
    "publication": "cdnBBG0A",
    "name": "Liquidity Trail Matrix",
    "url": "https://www.tradingview.com/script/cdnBBG0A-Liquidity-Trail-Matrix-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "liquidity-trail-matrix",
      "liquidity-trail-matrix-atr-maker"
    ],
    "entry": "An ATR-band trend change establishes direction; a touch arms a retest, then reclaim and directional close must qualify within a limited window. Quality combines several factors.",
    "exits": "Wick or ATR stop, R targets and break-even; opposite signals close the existing side. The author’s model gives stop priority.",
    "timing": "Warmup, retest expiry and the internal active trade intentionally suppress repeats. HTF alignment can be a score contribution rather than a universal hard gate."
  },
  {
    "publication": "qBUHu6aW",
    "name": "Mirage Liquidity Sweep Pro",
    "url": "https://www.tradingview.com/script/qBUHu6aW-Mirage-Liquidity-Sweep-Pro-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "mirage-liquidity-sweep-pro",
      "mirage-liquidity-sweep-pro-upstream-2-0"
    ],
    "entry": "A confirmed pivot is swept and reclaimed; quality and optional CHoCH confirmation determine the entry while the model is flat.",
    "exits": "Wick-based stop with minimum ATR distance, targets and break-even.",
    "timing": "October v1.4 rejects double-sided sweeps, invalidates pending setups when the wick is retaken, and blocks wrong-side stops."
  },
  {
    "publication": "uGVA7N7G",
    "name": "Meridian Flow",
    "url": "https://www.tradingview.com/script/uGVA7N7G-Meridian-Flow-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "meridian-flow"
    ],
    "entry": "Qualified BOS/CHoCH events, HTF context and order-block construction support entries; a structure event while already active is not necessarily another order.",
    "exits": "ATR stop and three targets with break-even management.",
    "timing": "Use confirmed entry events and preserve the internal flat/active distinction."
  },
  {
    "publication": "RjkDXQnZ",
    "name": "Synapse Trail Pro",
    "url": "https://www.tradingview.com/script/RjkDXQnZ-Synapse-Trail-Pro-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "synapse-trail-pro"
    ],
    "entry": "An EMA/ATR trail flips; regime, quality and filters decide the new entry. v1.4 adds context such as nearby obstacles and extension.",
    "exits": "Thirds-based target accounting, next-bar break-even, explicit reversals and optional cost assumptions.",
    "timing": "One alert may carry old-position events followed by a new entry. JSON uses stp.events.v1; text also batches events."
  },
  {
    "publication": "H0DfZXtR",
    "name": "Volume-Weighted S/R Zones",
    "url": "https://www.tradingview.com/script/H0DfZXtR-Volume-Weighted-S-R-Zones-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "volume-weighted-s-r-zones"
    ],
    "entry": "Confirmed pivots, candle volume and subsequent reactions build clustered levels. Qualified breakouts or timed retests generate entries.",
    "exits": "Native stop, three targets and break-even form the trade plan.",
    "timing": "A pivot’s historical location is not its availability time. Candle-volume strength is an approximation, not order-book or aggressor flow."
  },
  {
    "publication": "UWC4kQ9O",
    "name": "Liquidity Pools Pro",
    "url": "https://www.tradingview.com/script/UWC4kQ9O-Liquidity-Pools-Pro-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "liquidity-pools-pro"
    ],
    "entry": "Pivot clusters form liquidity pools; a wick through the level and a qualifying close back inside can open a trade.",
    "exits": "ATR or sweep-wick protection, target and break-even updates. September v1.2 repairs exit snapshots and simultaneous-signal handling.",
    "timing": "An active trade suppresses new entries. Management alert toggles differ from entry toggles; some target/break-even messages are off by default."
  },
  {
    "publication": "6YcVIGsL",
    "name": "Adaptive Fibonacci Trailing System",
    "url": "https://www.tradingview.com/script/6YcVIGsL-Adaptive-Fibonacci-Trailing-System-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "adaptive-fibonacci-trailing-system"
    ],
    "entry": "Trail Flip and Fibonacci 0.5 Cross are distinct entry modes. v1.8 requires actual price movement for a grid-cross entry, rather than a moving grid crossing stationary price.",
    "exits": "Stop-priority accounting, configurable target handling, corrected break-even credit and restored exit/reversal events.",
    "timing": "Warmup and trail state matter. The August release changes historical outcomes and includes anti-stall trail behaviour."
  },
  {
    "publication": "DRgzod5I",
    "name": "Nexus Fusion Engine ML",
    "url": "https://www.tradingview.com/script/DRgzod5I-Nexus-Fusion-Engine-ML-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "nexus-fusion-engine-ml"
    ],
    "entry": "Several normalised momentum components feed an oscillator and signal line. Crosses, divergences, fatigue and a nearest-neighbour component provide context.",
    "exits": "No complete native price-based position lifecycle is established by the explanation.",
    "timing": "Divergences inherit pivot confirmation delay; warmup is material. Similar historical direction is not a calibrated net-return forecast."
  },
  {
    "publication": "sXFWVpmg",
    "name": "Self-Aware Trend System",
    "url": "https://www.tradingview.com/script/sXFWVpmg-Self-Aware-Trend-System-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "self-aware-trend-system"
    ],
    "entry": "Trend-quality components adapt SuperTrend bands; confirmed flips produce plans, subject to readiness, score and structural risk checks.",
    "exits": "Targets, partials, stops, reversals and timeouts. September v1.13.1 fixes remaining quantity, gap fills and per-fill costs; dynamic targets are frozen at entry.",
    "timing": "sats.events.v2 batches management before entries. The final trade summary must not double-close a trade. Auto-calibration is experimental and off by default."
  },
  {
    "publication": "hNY1hl36",
    "name": "ABCD Harmonic Projection",
    "url": "https://www.tradingview.com/script/hNY1hl36-ABCD-Harmonic-Projection-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "abcd-harmonic-projection"
    ],
    "entry": "Alternating confirmed pivots establish ABC; ratio, size and quality requirements project a D objective.",
    "exits": "A pattern invalidation and projected target define the reference plan; ambiguous candles favour invalidation.",
    "timing": "Pivot confirmation and unfinished-extreme updates mean the drawn ABC points were not necessarily tradable at their plotted times."
  },
  {
    "publication": "Zc1gOfeX",
    "name": "Trade Strategy Calculator",
    "url": "https://www.tradingview.com/script/Zc1gOfeX-Trade-Strategy-Calculator-WillyAlgoTrader/",
    "role": "Manual / restricted",
    "scannerIds": [
      "trade-strategy-calculator"
    ],
    "entry": "Manual assumptions produce position size, expected value, Kelly-style quantities and growth illustrations.",
    "exits": "No market-generated entry or position-management events.",
    "timing": "Results depend on user inputs, including fee and win-rate assumptions. July changes repaired arithmetic and displays."
  },
  {
    "publication": "qieolCzm",
    "name": "Pulse Trend Radar",
    "url": "https://www.tradingview.com/script/qieolCzm-Pulse-Trend-Radar-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "pulse-trend-radar"
    ],
    "entry": "KAMA and median-range bands identify a directional cross; confirmation uses the preceding bar. Quality grades qualify the entry.",
    "exits": "Native stop and targets; opposite flips affect the prior trade. The model prioritises stops in ambiguous bars.",
    "timing": "v3.3.1 deliberately pauses flips during an inefficient range and emits a resume event when that state ends."
  },
  {
    "publication": "MaFckffw",
    "name": "Breakout Pattern Setup",
    "url": "https://www.tradingview.com/script/MaFckffw-Breakout-Pattern-Setup-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "breakout-pattern-setup"
    ],
    "entry": "Confirmed pivots fit a converging pattern; a qualified closing breakout triggers the plan.",
    "exits": "Targets are fractions of the measured move, not automatically R multiples. Stop-priority management and break-even apply.",
    "timing": "The July update expires an internal trade after a holding limit, preventing the active state from blocking entries indefinitely."
  },
  {
    "publication": "OjoifMMY",
    "name": "Daily Volume Profile Pro",
    "url": "https://www.tradingview.com/script/OjoifMMY-Daily-Volume-Profile-Pro-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "daily-volume-profile-pro"
    ],
    "entry": "Candle-range volume builds POC, value area and session VWAP. The 80% rule looks for acceptance back inside yesterday’s value area after an outside open.",
    "exits": "The opposite value-area edge is a hypothesis target; this is not a complete stop-and-position system.",
    "timing": "Session boundaries and intraday timeframe are essential. Volume is distributed from candles, not measured tick-by-tick at each price."
  },
  {
    "publication": "d7i2KmxR",
    "name": "Fibonacci Structure Engine",
    "url": "https://www.tradingview.com/script/d7i2KmxR-Fibonacci-Structure-Engine-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "fibonacci-structure-engine"
    ],
    "entry": "v2.1 arms a zone, waits for touch and trigger with structure/confluence, then confirms an entry. A new grid resets stale pending touches.",
    "exits": "Entry-time target and invalidation are frozen; pending expiry/replacement differs from closing an entered trade.",
    "timing": "Older descriptions of immediate structure entries are superseded by the September lifecycle. Score is heuristic."
  },
  {
    "publication": "K0GnwBci",
    "name": "StealthTrail SuperTrend ML Pro",
    "url": "https://www.tradingview.com/script/K0GnwBci-StealthTrail-SuperTrend-ML-Pro-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "stealthtrail-supertrend-ml-pro"
    ],
    "entry": "Regime features adapt the trail; a weighted feature score and sigmoid qualify signals. The described scorer is not a trained profit model.",
    "exits": "Band/ATR/fixed protection and ATR-based targets. Target distances are not inherently R multiples.",
    "timing": "Its success label is a favourable ATR move over a horizon, not fee-adjusted trade profit. HTF replay parity needs direct verification."
  },
  {
    "publication": "H7k5sk0Y",
    "name": "Adaptive Ichimoku Nexus",
    "url": "https://www.tradingview.com/script/H7k5sk0Y-Adaptive-Ichimoku-Nexus-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "adaptive-ichimoku-nexus"
    ],
    "entry": "Qualified Tenkan/Kijun crosses and separate Kumo breakout/retest setups generate trades.",
    "exits": "Targets, optional next-bar break-even and replacement accounting; July revisions add thirds-based outcomes.",
    "timing": "Displayed forward cloud/twist information is not a present entry. Warmup includes cloud displacement and lookback history."
  },
  {
    "publication": "IZj18oYZ",
    "name": "Precision Sniper",
    "url": "https://www.tradingview.com/script/IZj18oYZ-Precision-Sniper-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "precision-sniper",
      "precision-sniper-upstream-6-0"
    ],
    "entry": "September v2.1 requires an EMA cross plus price beyond the averages; optional confirmation creates a candidate that can expire or invalidate.",
    "exits": "Structural/ATR protection with tick-aware risk floors, frozen targets, next-bar stop steps and optional partials.",
    "timing": "Strictly higher closed-HTF inputs; crypto VWAP filtering is off in Auto mode. Batched lifecycle schema differs from older single messages."
  },
  {
    "publication": "X6oAyAdo",
    "name": "Smart Breakout Targets",
    "url": "https://www.tradingview.com/script/X6oAyAdo-Smart-Breakout-Targets-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "smart-breakout-targets"
    ],
    "entry": "Compression creates a range; the first qualified close outside is the actionable breakout. A failed first-break filter consumes that opportunity.",
    "exits": "Opposite-range protection, R targets and full TP3 closure. A replacement closes the previous trade at market.",
    "timing": "July v1.5 fixes stale breakouts and oversized stops. Stop priority applies to ambiguous candles."
  },
  {
    "publication": "Tq7S1S64",
    "name": "Adaptive Momentum Fusion",
    "url": "https://www.tradingview.com/script/Tq7S1S64-Adaptive-Momentum-Fusion-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "adaptive-momentum-fusion"
    ],
    "entry": "Six smoothing engines produce momentum, cross and divergence information. Normalisation changes how zero should be interpreted.",
    "exits": "No complete native price-based stop/target lifecycle.",
    "timing": "August fixes materially change Jurik/FRAMA calculations; divergence timing moved to the confirmation bar. Adaptive weights are experimental and off by default."
  },
  {
    "publication": "7yozLqCv",
    "name": "Swing Volume Profile Pro",
    "url": "https://www.tradingview.com/script/7yozLqCv-Swing-Volume-Profile-Pro-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "swing-volume-profile-pro"
    ],
    "entry": "Completed pivot-to-pivot legs create volume profiles, POC and value areas. The forming leg has a separate live profile.",
    "exits": "Profiles offer contextual levels; swing reversal or value-area alerts are not a complete execution plan.",
    "timing": "Confirmed profiles arrive after pivot delay. Buy/sell volume is inferred from candle direction and range distribution, not aggressor-side exchange prints."
  },
  {
    "publication": "2GrMlaRY",
    "name": "Adaptive Spectral Forecast",
    "url": "https://www.tradingview.com/script/2GrMlaRY-Adaptive-Spectral-Forecast-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "adaptive-spectral-forecast"
    ],
    "entry": "Frequency analysis projects a possible cyclic path; directional agreement, signal-to-noise and trend conditions may produce candidate signals.",
    "exits": "Forecast bands are heuristic and do not define a validated exchange execution lifecycle.",
    "timing": "The description places expensive calculations on the last bar. A historical full-chart run may not reproduce sequential live evaluation."
  },
  {
    "publication": "fdiiZPk6",
    "name": "StealthTrail SuperTrend",
    "url": "https://www.tradingview.com/script/fdiiZPk6-StealthTrail-SuperTrend-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "stealthtrail-supertrend"
    ],
    "entry": "A trail flip can remain pending for several bars while RSI/volume filters qualify it; July v2.0.1 adds this confirmation window.",
    "exits": "Band-anchored protection, R targets, break-even and opposite-direction closure. A raw opposite flip still exits even when a new entry is filtered.",
    "timing": "Separate the time of raw flip from the later qualified entry. Internal state prevents duplicate entries."
  },
  {
    "publication": "KLEBo02H",
    "name": "Adaptive Momentum Classifier",
    "url": "https://www.tradingview.com/script/KLEBo02H-Adaptive-Momentum-Classifier-WillyAlgoTrader/",
    "role": "Signal only",
    "scannerIds": [
      "adaptive-momentum-classifier"
    ],
    "entry": "Momentum, trend, volatility and flow ranks combine into threshold-crossing signals with agreement and optional filters.",
    "exits": "No complete native price-stop/target plan in the explanation.",
    "timing": "Only one signal per direction until the opposing direction resets the lock. Closing the bot’s trade early does not reset the Pine indicator."
  },
  {
    "publication": "9z4Y3HQj",
    "name": "SmartTrend Pro",
    "url": "https://www.tradingview.com/script/9z4Y3HQj-SmartTrend-Pro-WillyAlgoTrader/",
    "role": "Trade setup",
    "scannerIds": [
      "smarttrend-pro"
    ],
    "entry": "An adaptive ATR trail identifies flips; confluence qualifies entries and separate pullback conditions can produce continuations.",
    "exits": "Entry-time protection and targets; March fixes clear stopped-trade target state and repair swing references.",
    "timing": "Substantial warmup and closed-HTF context are required. Reversal and continuation setups are different events."
  },
  {
    "publication": "aRXsTqlH",
    "name": "ICT Session Zones & Sweep Signals",
    "url": "https://www.tradingview.com/script/aRXsTqlH-ICT-Session-Zones-Sweep-Signals-WillyAlgoTrader/",
    "role": "Context",
    "scannerIds": [
      "ict-session-zones-sweep-signals"
    ],
    "entry": "A finished session range is swept and reclaimed with body, depth and cooldown requirements. The author recommends additional entry confluence.",
    "exits": "Session zones and sweep alerts do not constitute a standalone trade-management system.",
    "timing": "Designed for lower intraday timeframes; visibility/eligibility limits intentionally suppress higher-timeframe output. New York session timezone matters."
  },
  {
    "publication": "CeUI4gJs",
    "name": "Adaptive Trend Pro",
    "url": "https://www.tradingview.com/script/CeUI4gJs-adaptive-trend-pro-willyalgotrader/",
    "role": "Manual / restricted",
    "scannerIds": [
      "adaptive-trend-pro"
    ],
    "entry": "The explanation describes market/timeframe presets, an adaptive ATR trail, momentum and quality filters.",
    "exits": "Signals and displayed protection are described, but the implementation is not publicly auditable.",
    "timing": "Labels can be positioned at a stop reference rather than the actual entry price. Preset optimisation claims are not independent evidence."
  },
  {
    "publication": "XhQiviEN",
    "name": "Adaptive Squeeze Momentum Pro",
    "url": "https://www.tradingview.com/script/XhQiviEN-adaptive-squeeze-momentum-pro-willyalgotrader/",
    "role": "Signal only",
    "scannerIds": [
      "adaptive-squeeze-momentum-pro"
    ],
    "entry": "Volatility-band width inside an ATR channel defines compression; its first confirmed release carries the momentum direction.",
    "exits": "Divergences and oscillator readings supply context; there is no complete native price-based trade lifecycle.",
    "timing": "Early divergences can later invalidate; confirmed mode waits for right-hand pivots. Closed-HTF filtering is optional."
  },
  {
    "publication": "upj9fpww",
    "name": "Automatic Fibonacci Levels",
    "url": "https://www.tradingview.com/script/upj9fpww-automatic-fibonacci-levels-willyalgotrader/",
    "role": "Context",
    "scannerIds": [
      "automatic-fibonacci-levels"
    ],
    "entry": "The visible chart’s extreme high/low define the grid and entry/target zones. Zooming or scrolling changes those anchors.",
    "exits": "Targets are visual reference levels; there is no autonomous position engine.",
    "timing": "Drawings are regenerated on the last bar. Historical chart framing can incorporate later information."
  },
  {
    "publication": "ceZQ8LOe",
    "name": "Auto S/R Channels",
    "url": "https://www.tradingview.com/script/ceZQ8LOe-auto-s-r-channels-willyalgotrader/",
    "role": "Context",
    "scannerIds": [
      "auto-s-r-channels"
    ],
    "entry": "Confirmed pivot combinations identify channels; boundary reactions and qualified breakouts create structural events.",
    "exits": "The July update adds a channel-width target, but no complete trade-management system. Targets can disappear when their channel is rebuilt.",
    "timing": "Channels expire and update; old descriptions of a 300-bar scoring cap are superseded. Gap escapes can be latched without a late breakout."
  },
  {
    "publication": "9bwEi6EK",
    "name": "Squeeze Breakout Pro",
    "url": "https://www.tradingview.com/script/9bwEi6EK-squeeze-breakout-pro-willyalgotrader/",
    "role": "Trade setup",
    "scannerIds": [
      "squeeze-breakout-pro"
    ],
    "entry": "A mature compression range locks; a confirmed, filtered breakout opens a model trade. v2.0 adds momentum, minimum width and range expiry.",
    "exits": "Range, wick or ATR stops; targets can use range width or actual risk. Break-even and opposite reversals are explicit.",
    "timing": "Same-direction entries are ignored while active. Native statistics favour targets in ambiguous candles and count a TP1 touch as a win."
  },
  {
    "publication": "9wnWcxkQ",
    "name": "Smart Money Engine",
    "url": "https://www.tradingview.com/script/9wnWcxkQ-smart-money-engine-willyalgotrader/",
    "role": "Context",
    "scannerIds": [
      "smart-money-engine"
    ],
    "entry": "Structure, order blocks, gaps and liquidity pools create confluence. July v1.6.1 adds retest, OTE and sweep alerts but not a complete position strategy.",
    "exits": "Zones invalidate or mitigate; those events are not automatically closes of an exchange trade.",
    "timing": "Some retest alerts can be intrabar. Historical backfilled sweeps intentionally have no alert. OTE can trigger when the zone moves onto price."
  },
  {
    "publication": "QhXQwVpN",
    "name": "Adaptive Pivot Structure",
    "url": "https://www.tradingview.com/script/QhXQwVpN-adaptive-pivot-structure-willyalgotrader/",
    "role": "Context",
    "scannerIds": [
      "adaptive-pivot-structure"
    ],
    "entry": "Confirmed pivots classify structure; a live extreme creates a moving Fibonacci grid. CHoCH is a reversal warning followed by a proposed retracement search.",
    "exits": "No native executable stop/target lifecycle.",
    "timing": "The author explicitly describes a live analysis tool. Pivot confirmation is delayed, while the forming pivot and Fibonacci grid move."
  },
  {
    "publication": "CFgnJqe7",
    "name": "Adaptive Volatility Trend",
    "url": "https://www.tradingview.com/script/CFgnJqe7-adaptive-volatility-trend-willyalgotrader/",
    "role": "Signal only",
    "scannerIds": [
      "adaptive-volatility-trend"
    ],
    "entry": "A Kaufman adaptive average changes slope beyond an ATR dead zone; price location, score and optional RSI/volume filters qualify a buy/sell candidate.",
    "exits": "The author does not provide a complete native stop/target trading system.",
    "timing": "Confirmed-bar signals need at least 50 bars or twice the trend length. Trend transitions drive signals, not every favourable bar."
  },
  {
    "publication": "5LGQFStB",
    "name": "Phantom Trend Cloud",
    "url": "https://www.tradingview.com/script/5LGQFStB-phantom-trend-cloud-willyalgotrader/",
    "role": "Signal only",
    "scannerIds": [
      "phantom-trend-cloud"
    ],
    "entry": "A directional candle rejects an adaptive Hull/ATR cloud after a touch; quality and optional volume, RSI, ADX and HTF filters qualify the retest.",
    "exits": "The public explanation provides candidate entries, not a complete account position-management system.",
    "timing": "June v1.1 changes trend from a separate EMA cross to the cloud’s own slope and repairs automatic HTF selection. Cooldown deliberately spaces signals."
  }
] as const;
export function willyContract(id: string | undefined) { return WILLY_CONTRACTS.find(c => (c.scannerIds as readonly string[]).some(base => id === base || id === `${base}-author-native`)); }

/** Publishing an author study is not validation of a runtime adapter. */
export function willyNativeReady(id: string | undefined): boolean {
  const c = willyContract(id);
  return !!c && (c.role === 'Context' || c.role === 'Manual / restricted' ||
    ['structure-anchored-vwap', 'liquidity-trail-matrix', 'synapse-trail-pro',
      'reactive-trail-system', 'reaction-level-matrix', 'strat-trap-vwap-engine'].includes(c.scannerIds[0]));
}
