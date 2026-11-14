import {candleReplayBlock} from './basket.ts';
import {plotLifecycle} from '../scanners/plotLifecycle.ts';
/**
 * Decision 191: one place that says how a scanner trades, asked by every path that trades or measures it.
 *
 * The account, the shadow book, the daily screen, the scanner backtest and walk-forward validation each assembled their
 * own copy of the strategy. They drifted: the screen admitted 1h and 4h pairs on market entries while both books waited
 * for a maker pullback; the screen left out the scanner's exit rules and trend gate; no backtest applied the protection
 * a script-exit trade gets in the books (decision 159). This module resolves the effective policy once; the books and
 * the backtests take it from here.
 */
import {withProductFees,type ProductFees} from './productFees.ts';
import type { AppConfig, PaperConfig, ScannerConfig } from '../config.ts';
import type { ExitOverride } from '../config.ts';
import { scriptModeExit, scriptModeProtection } from './logic.ts';
import {scannerEntryConfig} from './entryProtection.ts';

export type Book = 'account' | 'shadow';

/**
 * The book's paper settings. The shadow book is judged in R: it sizes against a purse no pair can exhaust and has no
 * position cap, so a shadow trade is never skipped because another one holds margin.
 */
export function bookPaperConfig(cfg: AppConfig, book: Book): PaperConfig {
  if (book === 'account') return cfg.paper;
  return { ...cfg.paper, reclaimTrials:undefined, initialEquity: 10_000_000, maxOpenPositions: 100_000, sizingMode: cfg.paper.sizingMode === 'margin' ? 'risk' : cfg.paper.sizingMode };
}

/**
 * A scanner's own exit rules as both books apply them (decisions 38, 113, 159–161): its `exit` override; under exit
 * mode `script` the bot's targets and trail are off and a wide disaster stop gives sizing a basis; from
 * `scriptExitTrailFrom` on, a script-exit trade also gets the bot's trail and floor.
 */
export function scannerExitPolicy(cfg: AppConfig, scannerId: string, now = Date.now()): ExitOverride | undefined {
  const sc = cfg.scanners[scannerId];
  if(plotLifecycle(scannerId))return {...sc?.exit,fallbackRR:[0,0,0]}; // No invented targets in these source-pinned profiles.
  const base: ExitOverride | undefined = sc?.exitMode === 'script' ? { ...(sc.exit ?? {}), ...scriptModeExit(cfg.paper) } : sc?.exit;
  const from = cfg.paper.scriptExitTrailFrom;
  return sc?.exitMode === 'script' && from !== undefined && now >= from ? { ...base, ...scriptModeProtection(cfg.paper) } : base;
}

/** The entry model a book uses on this timeframe (decision 185): a maker limit resting back from the signal, or a market entry (undefined). */
export function entryPolicy(cfg: AppConfig, tf: string, book: Book, opts: { executor?: boolean; scannerId?:string } = {}): { pullbackAtr: number; pullbackBars: number; limitWhenFlatOnly: true } | undefined {
  const le = scannerEntryConfig(cfg.paper,opts.scannerId?cfg.scanners[opts.scannerId]:undefined,tf).limitEntry;
  if (!le?.enabled || !le.tfs.includes(tf) || !le.books.includes(book)) return undefined;
  if (book === 'account' && opts.executor) return undefined;   // an exchange-mirrored account enters at market (decision 185)
  return { pullbackAtr: le.atrByTf?.[tf] ?? le.atr, pullbackBars: le.bars, limitWhenFlatOnly: true };
}

/** Everything a backtest needs to trade a scanner the way `book` trades it today. */
export function backtestPolicy(cfg: AppConfig, scannerId: string, tf: string, book: Book, opts: { executor?: boolean; now?: number; productFees?:ProductFees } = {}) {
  const blocked=candleReplayBlock(scannerId);if(blocked)throw Error(blocked);
  const sc: Partial<ScannerConfig> = cfg.scanners[scannerId] ?? {};
  return {
    // Scoped replay version: changes only native author research, preserving other
    // scanners' screening signatures and evidence identities.
    ...(sc.reader===3||plotLifecycle(scannerId)?{scriptStopAmendments:'after-close-v1' as const}:{}),
    cfg: withProductFees(scannerEntryConfig({...bookPaperConfig(cfg, book),...(opts.executor || cfg.execution.mode!=='paper' ? {reclaimTrials:undefined} : {})},sc,tf),opts.productFees,opts.productFees?.symbol??''),
    ...(opts.productFees?{productFees:opts.productFees}:{}),
    entryProtection: sc.entryProtection,
    requireAtrStop: book === 'account' && Boolean(cfg.paper.skipScriptStops) && sc.entryProtection !== 'native',
    exitMode: sc.exitMode ?? 'both',
    scannerExit: scannerExitPolicy(cfg, scannerId, opts.now),
    scannerExitResolved: true as const,
    trendGate: sc.trendGate,
    entry: entryPolicy(cfg, tf, book, {...opts,scannerId}),
    chopGate: cfg.risk.regime?.enabled && (cfg.risk.regime.minEr ?? 0) > 0 ? { minEr: cfg.risk.regime.minEr! } : undefined,
  };
}
