import { screenScore } from './gate.ts';
import type { AppConfig } from '../config.ts';
import type { PairRow } from './store.ts';

/** Backtest frequency is a planning estimate, never forward evidence or a promotion bypass. */
export function admissionEvidence(r: Pick<PairRow,'screen'|'tf'>, inc: AppConfig['incubator']) {
  const base = screenScore(r.screen);
  const train = Number(r.screen?.trades), holdout = Number(r.screen?.holdoutTrades ?? 0);
  // days spans the full history, while trades counts only its training segment.
  const trades = train + (Number.isFinite(holdout) && holdout > 0 ? holdout : 0), days = Number(r.screen?.days);
  const required = inc.gate.minTradesByTf?.[r.tf] ?? inc.gate.minTrades;
  const horizon = inc.gate.maxDaysByTf?.[r.tf] ?? inc.gate.maxDays;
  const estimatedDays = trades > 0 && days > 0 && Number.isFinite(days) && Number.isFinite(trades)
    ? required * days / trades : null;
  // Bounded discount: slow evidence can still win a slot on stronger quality.
  const factor = estimatedDays !== null && horizon > 0 ? Math.max(.25, Math.min(1, horizon / estimatedDays)) : 1;
  return {score:base*factor, qualityScore:base, estimatedDays, factor, requiredTrades:required, horizonDays:horizon};
}

/** Finish samples irrespective of whether their returns are positive or negative. */
export function evidencePriority(r: PairRow, inc: AppConfig['incubator']): number {
  if (r.stage !== 'shadow' && r.stage !== 'proposed') return 0;
  const required = inc.gate.minTradesByTf?.[r.tf] ?? inc.gate.minTrades;
  const n = Number(r.gate?.stats?.trades ?? 0);
  if (!(required > 0) || !Number.isFinite(n) || n < 0 || n >= required) return 0;
  const copySample=inc.mirror?.enabled?inc.mirror.minTrades??0:0;
  // Complete the next real decision sample, not only the eventual full promotion
  // sample. P&L is deliberately absent: losing samples get completed too.
  const target=copySample>0&&n<copySample?Math.min(copySample,required):required;
  return n / target;
}
