import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { MarketInfo } from '../paper/engine.ts';
import { SIM_VERSION } from '../paper/fingerprint.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { backtestPolicy } from '../paper/policy.ts';
import { policyReading, stablePolicy } from '../paper/tradePolicy.ts';

const digest = (x: unknown) => createHash('sha256').update(stablePolicy(x)).digest('hex');
const runtime = {
  node: process.versions.node,
  pine: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).dependencies.pinets,
};
export interface ResearchProvenance {
  version: 1;
  identity: string;
  key: string;
  market: MarketInfo;
  window: { from: number; to: number; bars: number; digest: string };
  options: unknown;
  terms: ReturnType<typeof researchTerms>;
}
export function researchTerms(
  cfg: AppConfig,
  source: string,
  id: string,
  symbol: string,
  tf: string,
  market: MarketInfo,
  executor = false,
  options: unknown = null,
) {
  return {
    runtime,
    simulation: SIMULATION_VERSION,
    execution: SIM_VERSION,
    source: createHash('sha256').update(source).digest('hex'),
    id,
    symbol,
    tf,
    reading: policyReading(cfg.scanners[id]),
    historyBars: cfg.historyBars,
    history: cfg.validation.history,
    policy: backtestPolicy(cfg, id, tf, 'account', { executor, productFees: market.productFees }),
    risk: cfg.risk,
    market,
    options,
  };
}
export function researchIdentity(...args: Parameters<typeof researchTerms>) {
  return digest(researchTerms(...args));
}
export function walkForwardOptions(cfg: AppConfig, requestedDays?: number) {
  const wf = cfg.validation.walkForward;
  return {
    ...wf,
    days: Math.max(
      wf.trainDays + wf.testDays,
      Math.min(cfg.validation.history.days, requestedDays ?? wf.days),
    ),
    minTrades: cfg.autoTune.minTrades,
    minProfitFactor: cfg.autoTune.minProfitFactor,
  };
}
export function researchProvenance(
  cfg: AppConfig,
  source: string,
  id: string,
  symbol: string,
  tf: string,
  market: MarketInfo,
  bars: Bar[],
  executor = false,
  options: unknown = null,
  subBars?: Bar[],
): ResearchProvenance {
  const identity = researchIdentity(cfg, source, id, symbol, tf, market, executor, options);
  const window = {
    from: bars[0]?.time ?? 0,
    to: bars.at(-1)?.time ?? 0,
    bars: bars.length,
    digest: digest({ bars, subBars }),
  };
  return {
    version: 1,
    terms: structuredClone(researchTerms(cfg, source, id, symbol, tf, market, executor, options)),
    identity,
    key: digest({ identity, window }),
    market: structuredClone(market),
    window,
    options,
  };
}
export function currentResearch(
  p: ResearchProvenance | undefined,
  cfg: AppConfig,
  source: string | undefined,
  id: string,
  symbol: string,
  tf: string,
  market: MarketInfo | undefined,
  executor = false,
  options: unknown = null,
) {
  if (!p || p.version !== 1 || !source || !market) return false;
  try {
    return (
      digest(p.terms) === p.identity &&
      p.identity === researchIdentity(cfg, source, id, symbol, tf, market, executor, options) &&
      p.key === digest({ identity: p.identity, window: p.window })
    );
  } catch {
    return false;
  }
}
