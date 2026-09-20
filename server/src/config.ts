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

export interface PaperConfig {
  initialEquity: number;
  riskPerTradePct: number;
  maxLeverage: number;
  /** `risk`: size so the stop loses riskPerTradePct of equity. `quality`: notional = equity × leverage, leverage scaled from minLeverage (no/low score) to maxLeverage (score 100). */
  sizingMode: 'risk' | 'quality';
  minLeverage: number;
  /** Model exchange liquidation: position closes when the loss reaches its margin (notional / leverage) less maintenance. */
  liquidation: boolean;
  maintenanceMarginPct: number;
  feeRatePct: number;
  /** Fee for take-profit limit fills (maker). */
  makerFeeRatePct: number;
  slippageBps: number;
  tpSplit: [number, number, number];
  breakEvenAfterTp1: boolean;
  allowReversal: boolean;
  fallbackAtrSl: number;
  fallbackRR: [number, number, number];
  maxOpenPositions: number;
}

export interface ScannerConfig {
  enabled: boolean;
  /** Removed from the dashboard list (kept disabled); restorable. */
  hidden?: boolean;
  symbols: string[] | null;
  timeframes: string[] | null;
  exitMode: ExitMode;
}

export interface ExecutionConfig {
  /** `paper` runs the internal simulator. `testnet` additionally mirrors paper fills to Delta's demo account (needs API keys). */
  mode: 'paper' | 'testnet';
}

export interface AppConfig {
  symbols: string[];
  timeframes: string[];
  historyBars: number;
  paper: PaperConfig;
  execution: ExecutionConfig;
  scanners: Record<string, ScannerConfig>;
}

export const DEFAULT_CONFIG: AppConfig = {
  symbols: ['BTCUSD', 'ETHUSD'],
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
    feeRatePct: 0.05,
    makerFeeRatePct: 0.02,
    slippageBps: 2,
    tpSplit: [0.4, 0.3, 0.3],
    breakEvenAfterTp1: true,
    allowReversal: true,
    fallbackAtrSl: 1.5,
    fallbackRR: [1, 2, 3],
    maxOpenPositions: 20,
  },
  execution: { mode: 'paper' },
  scanners: {},
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
  if (!Array.isArray(c.symbols) || c.symbols.length === 0) errs.push('symbols must be a non-empty array');
  if (!Array.isArray(c.timeframes) || c.timeframes.length === 0) errs.push('timeframes must be a non-empty array');
  for (const tf of c.timeframes || []) if (!(tf in TF_SECONDS)) errs.push(`unsupported timeframe ${tf}`);
  if (!(c.historyBars >= 200 && c.historyBars <= 4000)) errs.push('historyBars must be 200..4000');
  const p = c.paper;
  if (!(p.initialEquity > 0)) errs.push('paper.initialEquity must be > 0');
  if (!(p.riskPerTradePct > 0 && p.riskPerTradePct <= 20)) errs.push('paper.riskPerTradePct must be 0..20');
  if (!(p.maxLeverage >= 1 && p.maxLeverage <= 200)) errs.push('paper.maxLeverage must be 1..200');
  if (!['risk', 'quality'].includes(p.sizingMode)) errs.push('paper.sizingMode must be risk|quality');
  if (!(p.minLeverage >= 1 && p.minLeverage <= p.maxLeverage)) errs.push('paper.minLeverage must be 1..maxLeverage');
  if (!(p.maintenanceMarginPct >= 0 && p.maintenanceMarginPct < 5)) errs.push('paper.maintenanceMarginPct must be 0..5');
  if (!(p.feeRatePct >= 0 && p.feeRatePct < 1)) errs.push('paper.feeRatePct must be 0..1');
  if (!(p.makerFeeRatePct >= 0 && p.makerFeeRatePct < 1)) errs.push('paper.makerFeeRatePct must be 0..1');
  if (!(Array.isArray(p.tpSplit) && p.tpSplit.length === 3 && Math.abs(p.tpSplit.reduce((a, b) => a + b, 0) - 1) < 1e-6)) errs.push('paper.tpSplit must be 3 numbers summing to 1');
  if (!(Array.isArray(p.fallbackRR) && p.fallbackRR.length === 3)) errs.push('paper.fallbackRR must be 3 numbers');
  if (!(p.maxOpenPositions >= 1)) errs.push('paper.maxOpenPositions must be >= 1');
  if (!['paper', 'testnet'].includes(c.execution?.mode)) errs.push('execution.mode must be paper|testnet');
  return errs;
}

export class ConfigStore {
  private cfg: AppConfig;
  private listeners: Array<(next: AppConfig, prev: AppConfig) => void> = [];

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let stored: Partial<AppConfig> = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { stored = {}; }
    }
    this.cfg = deepMerge(structuredClone(DEFAULT_CONFIG), stored);
    if (process.env.VNEDGE_SYMBOLS) this.cfg.symbols = process.env.VNEDGE_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);
    if (process.env.VNEDGE_TIMEFRAMES) this.cfg.timeframes = process.env.VNEDGE_TIMEFRAMES.split(',').map(s => s.trim()).filter(Boolean);
  }

  get(): AppConfig { return this.cfg; }

  update(patch: Partial<AppConfig>): AppConfig {
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
    const cur = this.cfg.scanners[id] || { enabled: true, symbols: null, timeframes: null, exitMode: 'both' as ExitMode };
    const next = { ...cur, ...patch };
    if (next.symbols && next.symbols.length === 0) next.symbols = null;
    if (next.timeframes && next.timeframes.length === 0) next.timeframes = null;
    this.cfg = { ...this.cfg, scanners: { ...this.cfg.scanners, [id]: next } };
    this.save();
    return next;
  }

  onChange(l: (next: AppConfig, prev: AppConfig) => void) { this.listeners.push(l); }

  private save() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.cfg, null, 2));
  }
}
