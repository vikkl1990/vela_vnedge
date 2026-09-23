import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = process.env.VNEDGE_DATA_DIR || path.join(ROOT_DIR, 'data');
export const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
export const PINE_DIR = path.join(SCRIPTS_DIR, 'pine');
export const DASHBOARD_DIST = path.join(ROOT_DIR, 'dashboard', 'dist');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export type ExitMode = 'levels' | 'script' | 'both';

export interface PairTakeProfit {
  /** Preserve valid script targets, or replace them with this pair's risk multiples. */
  mode: 'fallback' | 'override';
  rr: [number, number, number];
  split: [number, number, number];
}

export interface PaperConfig {
  /** Exact exchange symbols. null removes an override through the merge-based API. */
  takeProfitBySymbol?: Record<string, PairTakeProfit | null>;
  initialEquity: number;
  riskPerTradePct: number;
  maxLeverage: number;
  /** `risk`: size so the stop loses riskPerTradePct of equity. `quality`: notional = equity × leverage, leverage scaled from minLeverage (no/low score) to maxLeverage (score 100). */
  sizingMode: 'risk' | 'quality';
  minLeverage: number;
  /** Model exchange liquidation: position closes when the loss reaches its margin (notional / leverage) less maintenance. */
  liquidation: boolean;
  maintenanceMarginPct: number;
  /** Reject entries whose stop distance is less than this multiple of the round-trip taker fee (0 = off). */
  minRiskFeeRatio: number;
  /**
   * Per-market override of `minRiskFeeRatio`. BTC and ETH trade with tight stops, so costs are a
   * third of every R there; a wider minimum turns them from losing to profitable while the same
   * minimum on alts only removes good trades (decision 21).
   */
  minRiskFeeRatioBySymbol?: Record<string, number>;
  /** Hard cap: the modelled loss at the stop may never exceed this % of equity, in ANY sizing mode (0 = off). */
  maxStopLossPct: number;
  /**
   * Reject entries whose signal bar closed more than this many seconds ago (0 = off).
   * Measured bar-close lag on this feed: median 11 s, p90 71 s, worst 234 s on thin symbols
   * (their websocket candle simply arrives late), so 300 s passes every legitimate run while
   * still blocking the restart replays that acted on bars 3 h old.
   */
  maxSignalAgeSec: number;
  /** Cross the live spread when a fresh quote exists: buy at the ask, sell at the bid (falls back to the slippage model). */
  useSpread: boolean;
  /** A quote older than this is not used for spread crossing. */
  quoteMaxAgeMs: number;
  /**
   * With `useSpread`, refuse an entry that cannot be priced off a fresh top-of-book instead of
   * assuming the reference price plus slippage. Exits are never gated on a quote. Leave this off
   * until the quote feed is proven, or a silent book outage stops all trading.
   */
  requireQuote: boolean;
  feeRatePct: number;
  /** Fee for take-profit limit fills (maker). */
  makerFeeRatePct: number;
  /**
   * Tax charged on top of every trading fee, in percent of the fee. Delta India adds 18% GST to the
   * published 0.05% / 0.02% rates, so the real cost is 0.059% taker and 0.0236% maker.
   */
  feeTaxPct?: number;
  /**
   * Delta India's Scalper Offer: no closing fee when a futures position is closed within the window
   * of opening (30 min BTCUSD/ETHUSD, 15 min others; partial closes qualify; liquidations and the
   * listed contracts do not). The account must opt in on Delta ("Join Now"), so it is off by default.
   */
  scalperOffer?: { enabled: boolean; majors: string[]; majorsMinutes: number; othersMinutes: number; excluded: string[] };
  slippageBps: number;
  tpSplit: [number, number, number];
  breakEvenAfterTp1: boolean;
  /**
   * Trailing stop, in R (0 = off). Once the position's favourable excursion reaches
   * `trailAfterR`, the stop follows the best price seen, `trailDistanceR` behind it, and never
   * moves against the position. It replaces the break-even jump, which exits a runner flat.
   * The trail is updated from a bar only after that bar's exits have been checked, so it can
   * never use a high the stop had not yet seen.
   */
  trailAfterR: number;
  trailDistanceR: number;
  /**
   * Proportional give-back (percent, 0 = off). When set, an armed trail keeps
   * `peak × (1 − giveBack)` instead of sitting a fixed `trailDistanceR` behind the peak. It is
   * tight in absolute terms while the trade is small and loose once it runs, which is the
   * opposite of a fixed distance and the point of it.
   */
  trailGiveBackPct: number;
  /**
   * Volatility trail (0 = off): the stop follows the best price by `trailAtrMult` × ATR, measured
   * from the ATR now rather than the risk fixed at entry. An R-based trail keeps a constant
   * distance while the market's own range changes underneath it; this one widens when the market
   * gets noisy and tightens when it calms. Armed by `trailAfterR` like the others.
   */
  trailAtrMult: number;
  /**
   * Profit floor (0 = off). Once the trade has shown `floorAtR`, the stop may never sit below
   * `floorKeepR` of profit. Unlike a trail it does not keep tightening, so it banks a small
   * gain without capping the trade; the trail still takes over at `trailAfterR`.
   */
  floorAtR: number;
  floorKeepR: number;
  /**
   * Time stop (0 = off). A position still below `staleMinR` after this many bars is closed at
   * market: the money is better used elsewhere and these rarely recover.
   */
  staleBars: number;
  staleMinR: number;
  allowReversal: boolean;
  /**
   * Minimum open result, in R, before an opposite signal is allowed to close the position.
   * 0 (the default) reverses on every opposite signal. A positive value means "only bank a
   * reversal once the trade is actually ahead"; a losing position is left to its stop instead.
   */
  reversalMinR: number;
  fallbackAtrSl: number;
  fallbackRR: [number, number, number];
  maxOpenPositions: number;
  // ---- execution realism (phase 2) ----
  /** `tape`: fill on Delta's trade stream (1m candles only when the tape is silent > tapeFallbackMs). `candles`: legacy 1-minute candle fills. */
  fillSource: 'candles' | 'tape';
  /** Resting take-profit limits (tape mode): `through` needs a print beyond the level, `touch` fills on a print at the level. */
  limitFill: 'touch' | 'through';
  /** Book-depth assumption: USD notional that moves the price 1 bp; market fills add notional / depthUsdPerBp bps of slippage (0 = fixed slippageBps only). */
  depthUsdPerBp: number;
  /** Tape mode: a signal's entry fills at the first print after signal time + latencyMs (candles mode fills immediately). */
  latencyMs: number;
  /** Tape mode: fall back to 1m candles when no print arrived for this long. */
  tapeFallbackMs: number;
  /** Charge Delta funding (rate × notional, sign by side) to open positions at every funding timestamp. */
  fundingCharges: boolean;
}

export interface ScannerConfig {
  enabled: boolean;
  /** Removed from the dashboard list (kept disabled); restorable. */
  hidden?: boolean;
  symbols: string[] | null;
  timeframes: string[] | null;
  exitMode: ExitMode;
  /** Generic derivation rule for scripts that never phrase a trade call (see scanners/rules.ts). */
  rule?: GenericRule | null;
  /** Per-script Pine `input.*` overrides keyed by variable name or title (see pine/inputs.ts). */
  inputs?: Record<string, number | string | boolean>;
}

export interface ExecutionConfig {
  /** `paper` runs the internal simulator. `dry-run` logs the exact exchange order payloads without sending. `testnet` sends them to Delta's demo account (needs API keys). */
  mode: 'paper' | 'dry-run' | 'testnet';
  /** Place exchange-side reduce-only stop + take-profit orders after each paper entry (cancel/replace on break-even). */
  bracket: boolean;
  /** Reconcile the exchange account with paper positions every N seconds (0 = off). */
  reconcileSec: number;
  /** Production host is only selectable when this is true AND env DELTA_LIVE=1; even then only market orders with reduce-only exits are sent. */
  allowProduction: boolean;
}

export interface SymbolUniverse {
  /** `list`: use `symbols` as given. `top`: the `top` most-traded Delta perpetuals by 24h turnover. `all`: every live Delta perpetual. */
  mode: 'list' | 'top' | 'all';
  top: number;
  /** Symbols never scanned (illiquid or unwanted), applied in top/all modes. */
  exclude: string[];
}

export interface MlConfig {
  /** Skip entries whose predicted win probability is below this (0 = off). */
  minProb: number;
  /** When a script publishes no score, use the ML probability (×100) as the quality score for leverage. */
  useAsScore: boolean;
}

/**
 * The incubator: disabled scanner/market pairs are screened daily, the promising ones trade in a
 * shadow book on live data, and those that prove themselves there are proposed for promotion.
 * A backtest screen over tens of thousands of pairs finds hundreds of lucky ones, so promotion rests
 * only on shadow trades taken after the pair was picked. See docs/DECISIONS.md, decision 17.
 */
export interface IncubatorConfig {
  /** Run shadow pairs in the bot. The daily screen is a separate job (`npm run incubate`). */
  enabled: boolean;
  tf: string;
  /** Most liquid USD perpetuals screened, by 24h turnover, and the turnover floor. */
  universeTop: number;
  minTurnoverUsd: number;
  /** Shadow pairs running at once (each is one script run per bar close). */
  maxShadow: number;
  screen: { bars: number; slices: number; minTrades: number; minProfitFactor: number; minWindowsUp: number; stressBps: number };
  gate: { minTrades: number; minDays: number; minPfR: number; minPositiveWeeksPct: number; minAvgR: number; maxOverlapPct: number; maxDays: number; failPfR: number };
  promote: { maxPerWeek: number; maxFleet: number };
  demote: { window: number; minTrades: number; maxPfR: number };
  /** A pair that failed shadow is not screened again for this long. */
  cooldownDays: number;
}

export interface AutoTuneConfig {
  /** Re-tune scanner symbol lists automatically after warm-up and every `intervalHours`. */
  enabled: boolean;
  minTrades: number;
  minProfitFactor: number;
  intervalHours: number;
  /** Out-of-sample gate: keep a scanner×symbol only when its walk-forward OOS result passes (falls back to in-sample when no walk-forward data). */
  oos: OosTuneConfig;
  /** Also tune each scanner's timeframe list: every configured (symbol, tf) pair is evaluated separately. */
  tuneTimeframes: boolean;
}

export interface OpsConfig {
  /** UTC hour of the nightly SQLite snapshot into data/backups. */
  backupHourUtc: number;
  /** Snapshots older than this are deleted after every backup run. */
  backupKeepDays: number;
  /** Rotate data/logs/vnedge.log when it exceeds this size. */
  logMaxBytes: number;
  /** Rotated files kept (vnedge.log.1 … .N). */
  logMaxFiles: number;
  /** Worker queue depth that counts as "too deep" for the queue alert. */
  queueDepthAlert: number;
  /** Free disk space (MB) on the data volume below which an alert fires. */
  diskLowMb: number;
  /** Clock drift versus Delta server time above which a warning is logged / alerted. */
  driftWarnMs: number;
  /** Max time graceful shutdown waits for in-flight script runs before exiting. */
  shutdownTimeoutMs: number;
}

export interface AlertsConfig {
  /** Telegram target; `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` override these (preferred: keeps the token out of config.json). */
  telegram: { botToken: string; chatId: string };
  /** Alert when equity falls this far (%) below its all-time peak. */
  drawdownPct: number;
  /** Send a message on every closed live trade. */
  onTrade: boolean;
  /** UTC hour of the daily summary; null disables it. */
  dailySummaryHourUtc: number | null;
  /** A condition that stays active is re-sent at most every this many minutes. */
  repeatMinutes: number;
  /** Hard cap on messages per hour (dedupe + rate limit). */
  maxPerHour: number;
}

export interface AppConfig {
  ops: OpsConfig;
  alerts: AlertsConfig;
  symbols: string[];
  universe: SymbolUniverse;
  ml: MlConfig;
  autoTune: AutoTuneConfig;
  incubator: IncubatorConfig;
  timeframes: string[];
  historyBars: number;
  paper: PaperConfig;
  execution: ExecutionConfig;
  risk: RiskConfig;
  scanners: Record<string, ScannerConfig>;
  validation: ValidationConfig;
}

/** Portfolio risk layer (phase 3). Percentages are of equity at the start of the period / of current equity. */
export interface RiskConfig {
  enabled: boolean;
  /** Kill switch: no new entries when the UTC day's loss reaches this % of the day-start equity (0 = off). */
  maxDailyLossPct: number;
  /** Kill switch: same for the ISO week (Monday 00:00 UTC). */
  maxWeeklyLossPct: number;
  /** Close every open position when a kill switch trips. */
  closeAllOnKill: boolean;
  maxPositionsTotal: number;
  maxPositionsPerSymbol: number;
  /** Cap |Σ side × notional × corr(symbol, BTCUSD)| as % of equity (0 = off). Correlation over the last `corrBars` closed bars of the entry timeframe. */
  maxBetaExposurePct: number;
  corrBars: number;
  /** After this many consecutive losing trades a scanner pauses for cooldownMinutes (0 = off). */
  cooldownAfterLosses: number;
  cooldownMinutes: number;
  /** Drawdown-scaled sizing: when the equity drawdown from its peak is ≥ ddPct, multiply leverage/risk by leverageMult (largest matching ddPct wins). */
  ddScale: Array<{ ddPct: number; leverageMult: number }>;
  perScannerMaxPositions: number;
  /** A scanner stops entering for the day when its realized loss today reaches this % of day-start equity (0 = off). */
  perScannerDailyLossPct: number;
  regime: {
    enabled: boolean;
    /** Skip entries when ATR(14) / price × 100 is below this. */
    minAtrPct: number;
    /** Skip entries on Saturday/Sunday (UTC). */
    noWeekend: boolean;
    /** Scanner ids exempt from the regime filter. */
    exempt: string[];
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  ops: { backupHourUtc: 2, backupKeepDays: 14, logMaxBytes: 10 * 1024 * 1024, logMaxFiles: 5, queueDepthAlert: 200, diskLowMb: 500, driftWarnMs: 2000, shutdownTimeoutMs: 20_000 },
  alerts: { telegram: { botToken: '', chatId: '' }, drawdownPct: 10, onTrade: false, dailySummaryHourUtc: 0, repeatMinutes: 60, maxPerHour: 30 },
  symbols: ['BTCUSD', 'ETHUSD'],
  universe: { mode: 'list', top: 20, exclude: [] },
  ml: { minProb: 0, useAsScore: false },
  incubator: {
    enabled: true, tf: '15m', universeTop: 40, minTurnoverUsd: 1_000_000, maxShadow: 100,
    screen: { bars: 4000, slices: 7, minTrades: 20, minProfitFactor: 1.2, minWindowsUp: 5, stressBps: 10 },
    gate: { minTrades: 30, minDays: 14, minPfR: 1.2, minPositiveWeeksPct: 60, minAvgR: 0.1, maxOverlapPct: 50, maxDays: 45, failPfR: 1.0 },
    promote: { maxPerWeek: 2, maxFleet: 20 },
    demote: { window: 50, minTrades: 30, maxPfR: 0.9 },
    cooldownDays: 30,
  },
  autoTune: { enabled: true, minTrades: 3, minProfitFactor: 1, intervalHours: 6, oos: { enabled: false, minTrades: 10, minProfitFactor: 1.1, minPositiveWeeks: 2 }, tuneTimeframes: false },
  timeframes: ['15m'],
  historyBars: 1000,
  paper: {
    initialEquity: 100_000,
    riskPerTradePct: 1,
    maxLeverage: 10,
    sizingMode: 'risk',
    minLeverage: 5,
    liquidation: true,
    maintenanceMarginPct: 0.5,
    minRiskFeeRatio: 4,
    maxStopLossPct: 2,
    maxSignalAgeSec: 300,
    useSpread: true,
    quoteMaxAgeMs: 10_000,
    requireQuote: false,
    feeRatePct: 0.05,
    makerFeeRatePct: 0.02,
    feeTaxPct: 18,
    scalperOffer: { enabled: false, majors: ['BTCUSD', 'ETHUSD'], majorsMinutes: 30, othersMinutes: 15, excluded: ['PAXGUSD', 'SLVONUSD', 'XAUTUSD'] },
    slippageBps: 2,
    tpSplit: [0.4, 0.3, 0.3],
    breakEvenAfterTp1: true,
    trailAfterR: 0,
    trailDistanceR: 1,
    trailGiveBackPct: 0,
    trailAtrMult: 0,
    floorAtR: 0,
    floorKeepR: 0,
    staleBars: 0,
    staleMinR: 0,
    allowReversal: true,
    reversalMinR: 0,
    fallbackAtrSl: 1.5,
    fallbackRR: [1, 2, 3],
    maxOpenPositions: 20,
    fillSource: 'candles',
    limitFill: 'through',
    depthUsdPerBp: 0,
    latencyMs: 1500,
    tapeFallbackMs: 5000,
    fundingCharges: true,
  },
  execution: { mode: 'paper', bracket: true, reconcileSec: 60, allowProduction: false },
  risk: {
    enabled: true,
    maxDailyLossPct: 15,
    maxWeeklyLossPct: 30,
    closeAllOnKill: false,
    maxPositionsTotal: 8,
    maxPositionsPerSymbol: 2,
    maxBetaExposurePct: 0,
    corrBars: 20,
    cooldownAfterLosses: 0,
    cooldownMinutes: 120,
    ddScale: [{ ddPct: 10, leverageMult: 0.5 }],
    perScannerMaxPositions: 4,
    perScannerDailyLossPct: 0,
    regime: { enabled: true, minAtrPct: 0.30, noWeekend: true, exempt: [] },
  },
  scanners: {},
  validation: {
    history: { enabled: true, days: 60, chunkBars: 4000, delayMs: 250, backtestBars: 0 },
    walkForward: { days: 60, trainDays: 10, testDays: 3, stepDays: 1, autoRun: false },
    consensus: { enabled: false, minScanners: 2, windowBars: 1 },
    shadow: { enabled: true, minProb: 0.55 },
  },
};

export const SUPPORTED_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d'] as const;
export type Timeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

export const TF_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '1d': 86400,
};

/** Delta resolution → Pine timeframe string (as scripts see `timeframe.period`). */
export const TF_TO_PINE: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '1d': 'D',
};

/** Pine timeframe string → Delta resolution. Accepts '60', '240', 'D', '1D', 'W', '1W', 'M'. */
export function pineTfToDelta(tf: string): string | null {
  const t = String(tf).trim().toUpperCase();
  if (/^\d+$/.test(t)) {
    const m = Number(t);
    for (const [delta, secs] of Object.entries(TF_SECONDS)) if (secs === m * 60) return delta;
    return null;
  }
  if (t === 'D' || t === '1D') return '1d';
  if (t === 'W' || t === '1W') return '1w';
  if (t === 'M' || t === '1M') return '1M';
  const m = t.match(/^(\d+)([SHDWM])$/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === 'H') return pineTfToDelta(String(n * 60));
    if (m[2] === 'D' && n === 1) return '1d';
    if (m[2] === 'M') return `${n}M`;
  }
  return null;
}

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    if (v === undefined) continue;
    const cur = (base as any)?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
}

export function validateConfig(c: AppConfig): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c.symbols) || (c.symbols.length === 0 && c.universe?.mode === 'list')) errs.push('symbols must be a non-empty array');
  if (!['list', 'top', 'all'].includes(c.universe?.mode)) errs.push('universe.mode must be list|top|all');
  if (!(c.universe.top >= 1 && c.universe.top <= 300)) errs.push('universe.top must be 1..300');
  if (!Array.isArray(c.timeframes) || c.timeframes.length === 0) errs.push('timeframes must be a non-empty array');
  for (const tf of c.timeframes || []) if (!(tf in TF_SECONDS)) errs.push(`unsupported timeframe ${tf}`);
  if (!(c.historyBars >= 200 && c.historyBars <= 4000)) errs.push('historyBars must be 200..4000');
  const p = c.paper;
  if (p.takeProfitBySymbol !== undefined) {
    const policies = p.takeProfitBySymbol;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) errs.push('paper.takeProfitBySymbol must be a symbol map');
    else for (const [symbol, policy] of Object.entries(policies)) {
      const key = `paper.takeProfitBySymbol.${symbol}`;
      if (!/^[A-Z0-9]+$/.test(symbol)) errs.push(`${key}: use an uppercase exchange symbol`);
      if (policy === null) continue;
      if (!policy || typeof policy !== 'object' || !['fallback', 'override'].includes(policy.mode)) { errs.push(`${key}.mode must be fallback|override`); continue; }
      if (!Array.isArray(policy.rr) || policy.rr.length !== 3 || !policy.rr.every((v, i, a) => Number.isFinite(v) && v > 0 && (i === 0 || v > a[i - 1]))) errs.push(`${key}.rr must be 3 positive, strictly increasing numbers`);
      if (!Array.isArray(policy.split) || policy.split.length !== 3 || !policy.split.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || Math.abs(policy.split.reduce((a, b) => a + b, 0) - 1) > 1e-6) errs.push(`${key}.split must be 3 fractions summing to 1`);
    }
  }
  if (!(p.initialEquity > 0)) errs.push('paper.initialEquity must be > 0');
  if (!(p.riskPerTradePct > 0 && p.riskPerTradePct <= 20)) errs.push('paper.riskPerTradePct must be 0..20');
  if (!(p.maxLeverage >= 1 && p.maxLeverage <= 200)) errs.push('paper.maxLeverage must be 1..200');
  if (!['risk', 'quality'].includes(p.sizingMode)) errs.push('paper.sizingMode must be risk|quality');
  if (!(p.minLeverage >= 1 && p.minLeverage <= p.maxLeverage)) errs.push('paper.minLeverage must be 1..maxLeverage');
  if (!(p.maintenanceMarginPct >= 0 && p.maintenanceMarginPct < 5)) errs.push('paper.maintenanceMarginPct must be 0..5');
  if (!(Number.isFinite(p.minRiskFeeRatio) && p.minRiskFeeRatio >= 0)) errs.push('paper.minRiskFeeRatio must be ≥ 0');
  if (!(Number.isFinite(p.maxStopLossPct) && p.maxStopLossPct >= 0 && p.maxStopLossPct <= 100)) errs.push('paper.maxStopLossPct must be 0..100');
  if (!(Number.isFinite(p.maxSignalAgeSec) && p.maxSignalAgeSec >= 0)) errs.push('paper.maxSignalAgeSec must be ≥ 0');
  if (typeof p.useSpread !== 'boolean') errs.push('paper.useSpread must be boolean');
  if (!(Number.isFinite(p.quoteMaxAgeMs) && p.quoteMaxAgeMs >= 0)) errs.push('paper.quoteMaxAgeMs must be ≥ 0');
  if (p.requireQuote && !p.useSpread) errs.push('paper.requireQuote needs paper.useSpread');
  if (p.requireQuote && !(p.quoteMaxAgeMs > 0)) errs.push('paper.requireQuote needs paper.quoteMaxAgeMs > 0');
  if (!(p.feeRatePct >= 0 && p.feeRatePct < 1)) errs.push('paper.feeRatePct must be 0..1');
  if (!(p.makerFeeRatePct >= 0 && p.makerFeeRatePct < 1)) errs.push('paper.makerFeeRatePct must be 0..1');
  if (p.feeTaxPct !== undefined && !(p.feeTaxPct >= 0 && p.feeTaxPct <= 100)) errs.push('paper.feeTaxPct must be 0..100');
  if (!(Number.isFinite(p.trailAfterR) && p.trailAfterR >= 0)) errs.push('paper.trailAfterR must be ≥ 0 (0 = off)');
  if (!(Number.isFinite(p.trailGiveBackPct) && p.trailGiveBackPct >= 0 && p.trailGiveBackPct < 100)) errs.push('paper.trailGiveBackPct must be in [0, 100)');
  if (!(Number.isFinite(p.trailAtrMult) && p.trailAtrMult >= 0)) errs.push('paper.trailAtrMult must be ≥ 0 (0 = off)');
  if (!Number.isFinite(p.reversalMinR)) errs.push('paper.reversalMinR must be a number (0 = reverse on every opposite signal)');
  if (!(Number.isFinite(p.floorAtR) && p.floorAtR >= 0)) errs.push('paper.floorAtR must be ≥ 0 (0 = off)');
  if (p.floorAtR > 0 && !(p.floorKeepR >= 0 && p.floorKeepR < p.floorAtR)) errs.push('paper.floorKeepR must be ≥ 0 and below floorAtR');
  if (!(Number.isFinite(p.staleBars) && p.staleBars >= 0)) errs.push('paper.staleBars must be ≥ 0 (0 = off)');
  if (p.trailAfterR > 0 && !(p.trailGiveBackPct > 0) && !(Number.isFinite(p.trailDistanceR) && p.trailDistanceR > 0)) errs.push('paper.trailDistanceR must be > 0 when trailing is on without trailGiveBackPct');
  if (!(Array.isArray(p.tpSplit) && p.tpSplit.length === 3 && p.tpSplit.every(v => Number.isFinite(v) && v >= 0 && v <= 1) && Math.abs(p.tpSplit.reduce((a, b) => a + b, 0) - 1) < 1e-6)) errs.push('paper.tpSplit must be 3 numbers summing to 1');
  if (!(Array.isArray(p.fallbackRR) && p.fallbackRR.length === 3 && p.fallbackRR.every((v, i, a) => Number.isFinite(v) && v > 0 && (i === 0 || v > a[i - 1])))) errs.push('paper.fallbackRR must be 3 numbers');
  if (!(Number.isFinite(p.slippageBps) && p.slippageBps >= 0 && p.slippageBps < 10_000)) errs.push('paper.slippageBps must be 0..10000');
  if (!(Number.isFinite(p.fallbackAtrSl) && p.fallbackAtrSl > 0)) errs.push('paper.fallbackAtrSl must be positive');
  if (!(p.maxOpenPositions >= 1)) errs.push('paper.maxOpenPositions must be >= 1');
  if (!['paper', 'dry-run', 'testnet'].includes(c.execution?.mode)) errs.push('execution.mode must be paper|dry-run|testnet');
  if (!(c.ml?.minProb >= 0 && c.ml?.minProb < 1)) errs.push('ml.minProb must be 0..1');
  if (!(c.autoTune?.minTrades >= 1 && c.autoTune?.minProfitFactor >= 0 && c.autoTune?.intervalHours >= 1)) errs.push('autoTune.minTrades ≥ 1, minProfitFactor ≥ 0, intervalHours ≥ 1');
  errs.push(...validateRealismAndRisk(c));
  errs.push(...validateExtendedConfig(c));
  errs.push(...validateOpsConfig(c));
  const inc = c.incubator;
  if (inc !== undefined) {
    if (!(inc.tf in TF_SECONDS)) errs.push('incubator.tf must be a supported timeframe');
    if (!(inc.maxShadow >= 0 && inc.maxShadow <= 1000)) errs.push('incubator.maxShadow must be 0..1000');
    if (!(inc.universeTop >= 1 && inc.universeTop <= 500)) errs.push('incubator.universeTop must be 1..500');
    if (!(inc.gate?.minTrades >= 1 && inc.gate?.minDays >= 0 && inc.gate?.maxDays > inc.gate?.minDays)) errs.push('incubator.gate needs minTrades ≥ 1 and maxDays > minDays');
    if (!(inc.gate?.failPfR < inc.gate?.minPfR)) errs.push('incubator.gate.failPfR must be below minPfR');
    if (!(inc.promote?.maxPerWeek >= 0 && inc.promote?.maxFleet >= 1)) errs.push('incubator.promote needs maxPerWeek ≥ 0 and maxFleet ≥ 1');
    if (!(inc.screen?.slices >= 1 && inc.screen?.slices <= 31)) errs.push('incubator.screen.slices must be 1..31');
  }
  return errs;
}

/** Validation for the phase 2/3/5 sections (paper realism, execution, risk). */
export function validateRealismAndRisk(c: AppConfig): string[] {
  const errs: string[] = [];
  const p = c.paper;
  if (p.takeProfitBySymbol !== undefined) {
    const policies = p.takeProfitBySymbol;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) errs.push('paper.takeProfitBySymbol must be a symbol map');
    else for (const [symbol, policy] of Object.entries(policies)) {
      const key = `paper.takeProfitBySymbol.${symbol}`;
      if (!/^[A-Z0-9]+$/.test(symbol)) errs.push(`${key}: use an uppercase exchange symbol`);
      if (policy === null) continue;
      if (!policy || typeof policy !== 'object' || !['fallback', 'override'].includes(policy.mode)) { errs.push(`${key}.mode must be fallback|override`); continue; }
      if (!Array.isArray(policy.rr) || policy.rr.length !== 3 || !policy.rr.every((v, i, a) => Number.isFinite(v) && v > 0 && (i === 0 || v > a[i - 1]))) errs.push(`${key}.rr must be 3 positive, strictly increasing numbers`);
      if (!Array.isArray(policy.split) || policy.split.length !== 3 || !policy.split.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || Math.abs(policy.split.reduce((a, b) => a + b, 0) - 1) > 1e-6) errs.push(`${key}.split must be 3 fractions summing to 1`);
    }
  }
  if (!['candles', 'tape'].includes(p.fillSource)) errs.push('paper.fillSource must be candles|tape');
  if (!['touch', 'through'].includes(p.limitFill)) errs.push('paper.limitFill must be touch|through');
  if (!(Number.isFinite(p.depthUsdPerBp) && p.depthUsdPerBp >= 0)) errs.push('paper.depthUsdPerBp must be ≥ 0');
  if (!(Number.isFinite(p.latencyMs) && p.latencyMs >= 0 && p.latencyMs <= 60_000)) errs.push('paper.latencyMs must be 0..60000');
  if (!(Number.isFinite(p.tapeFallbackMs) && p.tapeFallbackMs >= 1000 && p.tapeFallbackMs <= 300_000)) errs.push('paper.tapeFallbackMs must be 1000..300000');
  const x = c.execution;
  if (!(Number.isFinite(x.reconcileSec) && x.reconcileSec >= 0)) errs.push('execution.reconcileSec must be ≥ 0');
  const r = c.risk;
  if (!r) return errs.concat('risk section missing');
  const pct = (v: number, k: string, max = 100) => { if (!(Number.isFinite(v) && v >= 0 && v <= max)) errs.push(`risk.${k} must be 0..${max}`); };
  pct(r.maxDailyLossPct, 'maxDailyLossPct'); pct(r.maxWeeklyLossPct, 'maxWeeklyLossPct'); pct(r.perScannerDailyLossPct, 'perScannerDailyLossPct');
  pct(r.maxBetaExposurePct, 'maxBetaExposurePct', 100_000);
  if (!(r.maxPositionsTotal >= 1)) errs.push('risk.maxPositionsTotal must be ≥ 1');
  if (!(r.maxPositionsPerSymbol >= 1)) errs.push('risk.maxPositionsPerSymbol must be ≥ 1');
  if (!(r.perScannerMaxPositions >= 1)) errs.push('risk.perScannerMaxPositions must be ≥ 1');
  if (!(r.corrBars >= 5 && r.corrBars <= 500)) errs.push('risk.corrBars must be 5..500');
  if (!(r.cooldownAfterLosses >= 0 && r.cooldownMinutes >= 0)) errs.push('risk.cooldownAfterLosses and cooldownMinutes must be ≥ 0');
  if (!Array.isArray(r.ddScale) || r.ddScale.some(d => !(d.ddPct >= 0 && d.ddPct <= 100 && d.leverageMult >= 0 && d.leverageMult <= 1))) errs.push('risk.ddScale must be [{ddPct 0..100, leverageMult 0..1}]');
  if (!(r.regime && Number.isFinite(r.regime.minAtrPct) && r.regime.minAtrPct >= 0 && Array.isArray(r.regime.exempt))) errs.push('risk.regime.minAtrPct must be ≥ 0 and exempt an array');
  return errs;
}

/** Validation for the Phase 4 `ops` / `alerts` sections (appended; kept separate so the core validator stays untouched). */
export function validateOpsConfig(c: AppConfig): string[] {
  const errs: string[] = [];
  const o = c.ops, a = c.alerts;
  // sections are merged from DEFAULT_CONFIG by ConfigStore; a hand-built config without them is still valid
  if (o === undefined) return errs;
  if (typeof o !== 'object' || o === null) return ['ops must be an object'];
  if (!(Number.isInteger(o.backupHourUtc) && o.backupHourUtc >= 0 && o.backupHourUtc <= 23)) errs.push('ops.backupHourUtc must be 0..23');
  if (!(Number.isFinite(o.backupKeepDays) && o.backupKeepDays >= 1 && o.backupKeepDays <= 3650)) errs.push('ops.backupKeepDays must be 1..3650');
  if (!(Number.isFinite(o.logMaxBytes) && o.logMaxBytes >= 64 * 1024)) errs.push('ops.logMaxBytes must be ≥ 65536');
  if (!(Number.isInteger(o.logMaxFiles) && o.logMaxFiles >= 1 && o.logMaxFiles <= 100)) errs.push('ops.logMaxFiles must be 1..100');
  if (!(Number.isFinite(o.queueDepthAlert) && o.queueDepthAlert >= 1)) errs.push('ops.queueDepthAlert must be ≥ 1');
  if (!(Number.isFinite(o.diskLowMb) && o.diskLowMb >= 0)) errs.push('ops.diskLowMb must be ≥ 0');
  if (!(Number.isFinite(o.driftWarnMs) && o.driftWarnMs >= 100)) errs.push('ops.driftWarnMs must be ≥ 100');
  if (!(Number.isFinite(o.shutdownTimeoutMs) && o.shutdownTimeoutMs >= 0 && o.shutdownTimeoutMs <= 600_000)) errs.push('ops.shutdownTimeoutMs must be 0..600000');
  if (a === undefined) return errs;
  if (typeof a !== 'object' || a === null) return [...errs, 'alerts must be an object'];
  if (!a.telegram || typeof a.telegram.botToken !== 'string' || typeof a.telegram.chatId !== 'string') errs.push('alerts.telegram must be { botToken, chatId } strings');
  if (!(Number.isFinite(a.drawdownPct) && a.drawdownPct > 0 && a.drawdownPct <= 100)) errs.push('alerts.drawdownPct must be 0..100');
  if (typeof a.onTrade !== 'boolean') errs.push('alerts.onTrade must be boolean');
  if (!(a.dailySummaryHourUtc === null || (Number.isInteger(a.dailySummaryHourUtc) && a.dailySummaryHourUtc >= 0 && a.dailySummaryHourUtc <= 23))) errs.push('alerts.dailySummaryHourUtc must be 0..23 or null');
  if (!(Number.isFinite(a.repeatMinutes) && a.repeatMinutes >= 1)) errs.push('alerts.repeatMinutes must be ≥ 1');
  if (!(Number.isFinite(a.maxPerHour) && a.maxPerHour >= 1)) errs.push('alerts.maxPerHour must be ≥ 1');
  return errs;
}

/**
 * The config file and the running bot's copy of it. Every change is written back to the file, and
 * before writing, the store checks that nobody else changed the file since it was read: a stale
 * process used to overwrite hand edits wholesale the next time it saved a scanner change.
 */
export class ConfigStore {
  private cfg: AppConfig;
  private listeners: Array<(next: AppConfig, prev: AppConfig) => void> = [];
  private readonly file: string;
  /** Modification time of the file when it was last read or written by this store. */
  private seenMtimeMs = 0;

  constructor(file = CONFIG_FILE) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.cfg = this.read();
  }

  private read(): AppConfig {
    let stored: Partial<AppConfig> = {};
    if (fs.existsSync(this.file)) {
      try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { stored = {}; }
      this.seenMtimeMs = fs.statSync(this.file).mtimeMs;
    }
    const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), stored);
    if (process.env.VNEDGE_SYMBOLS) cfg.symbols = process.env.VNEDGE_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);
    if (process.env.VNEDGE_TIMEFRAMES) cfg.timeframes = process.env.VNEDGE_TIMEFRAMES.split(',').map(s => s.trim()).filter(Boolean);
    return cfg;
  }

  /** Re-read the file if something else wrote it since we last did, so a change lands on top of it. */
  private refreshIfChangedOnDisk(): void {
    if (!fs.existsSync(this.file)) return;
    const mtime = fs.statSync(this.file).mtimeMs;
    if (mtime === this.seenMtimeMs) return;
    console.warn(`[config] ${this.file} was changed outside this process; reloading it before applying the change`);
    this.cfg = this.read();
  }

  get(): AppConfig { return this.cfg; }

  update(patch: Partial<AppConfig>): AppConfig {
    this.refreshIfChangedOnDisk();
    const next = deepMerge(this.cfg, patch);
    const errs = validateConfig(next);
    if (errs.length) throw new Error('Invalid config: ' + errs.join('; '));
    const prev = this.cfg;
    this.cfg = next;
    this.save();
    for (const l of this.listeners) l(next, prev);
    return next;
  }

  setScanner(id: string, patch: Partial<ScannerConfig>): ScannerConfig {
    this.refreshIfChangedOnDisk();
    const cur = this.cfg.scanners[id] || { enabled: true, symbols: null, timeframes: null, exitMode: 'both' as ExitMode };
    const next = { ...cur, ...patch };
    if (next.symbols && next.symbols.length === 0) next.symbols = null;
    if (next.timeframes && next.timeframes.length === 0) next.timeframes = null;
    this.cfg = { ...this.cfg, scanners: { ...this.cfg.scanners, [id]: next } };
    this.save();
    return next;
  }

  onChange(l: (next: AppConfig, prev: AppConfig) => void) { this.listeners.push(l); }

  /** Write atomically (temp file + rename), so another process never reads a half-written file. */
  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
    fs.renameSync(tmp, this.file);
    this.seenMtimeMs = fs.statSync(this.file).mtimeMs;
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 1 / 6 additions (validation, shadow, consensus, generic rules, script inputs)
// ---------------------------------------------------------------------------------------------

/** Generic derivation rules selectable per scanner (`scanners.<id>.rule`). */
export type GenericRule = 'trailing' | 'oscillator';
export const GENERIC_RULES: readonly GenericRule[] = ['trailing', 'oscillator'];

export interface OosTuneConfig {
  enabled: boolean;
  minTrades: number;
  minProfitFactor: number;
  minPositiveWeeks: number;
}

export interface HistoryConfig {
  /** Use the SQLite candle cache (deep history paged from Delta REST) for validation runs. */
  enabled: boolean;
  /** Days of history kept per symbol×timeframe for walk-forward validation. */
  days: number;
  /** Bars per Delta REST request (Delta serves at most ~4000). */
  chunkBars: number;
  /** Pause between consecutive requests for the same symbol (rate-limit courtesy). */
  delayMs: number;
  /** When > historyBars, warm backtests use this many cached bars instead of the in-memory history (0 = off; live runs always use memory). */
  backtestBars: number;
}

export interface WalkForwardConfig {
  /** Total history evaluated (≤ history.days). */
  days: number;
  trainDays: number;
  testDays: number;
  stepDays: number;
  /** Re-run walk-forward validation automatically after each scheduled re-backtest. */
  autoRun: boolean;
}

export interface ConsensusConfig {
  /** Require `minScanners` distinct scanners to signal the same side on the same symbol×tf within `windowBars` bars before entering. */
  enabled: boolean;
  minScanners: number;
  windowBars: number;
}

export interface ShadowConfig {
  /** Mirror live signals into two in-memory paper variants: `ungated` and `ml-gated` (entries below `minProb` skipped). */
  enabled: boolean;
  minProb: number;
}

export interface ValidationConfig {
  history: HistoryConfig;
  walkForward: WalkForwardConfig;
  consensus: ConsensusConfig;
  shadow: ShadowConfig;
}

export function validateExtendedConfig(c: AppConfig): string[] {
  const errs: string[] = [];
  const o = c.autoTune?.oos;
  if (o && !(o.minTrades >= 1 && o.minProfitFactor >= 0 && o.minPositiveWeeks >= 0)) errs.push('autoTune.oos.minTrades ≥ 1, minProfitFactor ≥ 0, minPositiveWeeks ≥ 0');
  const v = c.validation;
  if (v) {
    const h = v.history;
    if (!(h.days >= 1 && h.days <= 400)) errs.push('validation.history.days must be 1..400');
    if (!(h.chunkBars >= 100 && h.chunkBars <= 4000)) errs.push('validation.history.chunkBars must be 100..4000');
    if (!(h.delayMs >= 0 && h.delayMs <= 10_000)) errs.push('validation.history.delayMs must be 0..10000');
    if (!(h.backtestBars >= 0 && h.backtestBars <= 50_000)) errs.push('validation.history.backtestBars must be 0..50000');
    const w = v.walkForward;
    if (!(w.days >= 2 && w.days <= 400)) errs.push('validation.walkForward.days must be 2..400');
    if (!(w.trainDays >= 1 && w.testDays >= 1 && w.stepDays >= 1 && w.trainDays + w.testDays <= w.days)) errs.push('validation.walkForward: trainDays, testDays, stepDays ≥ 1 and trainDays + testDays ≤ days');
    if (!(v.consensus.minScanners >= 1 && v.consensus.windowBars >= 0)) errs.push('validation.consensus.minScanners ≥ 1, windowBars ≥ 0');
    if (!(v.shadow.minProb >= 0 && v.shadow.minProb < 1)) errs.push('validation.shadow.minProb must be 0..1');
  }
  for (const [id, sc] of Object.entries(c.scanners ?? {})) {
    if (sc?.rule != null && !GENERIC_RULES.includes(sc.rule)) errs.push(`scanners.${id}.rule must be ${GENERIC_RULES.join('|')}`);
    if (sc?.inputs != null && (typeof sc.inputs !== 'object' || Array.isArray(sc.inputs) || Object.values(sc.inputs).some(x => !['number', 'string', 'boolean'].includes(typeof x)))) errs.push(`scanners.${id}.inputs must map names to number|string|boolean`);
  }
  return errs;
}
