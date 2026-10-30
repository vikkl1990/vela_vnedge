import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';
import type { Position } from './logic.ts';
import { commissionRatePct } from './costs.ts';

/** An immutable fill-time budget, not a prediction of trade profitability. */
export function fillBudget(p: Position, cfg: PaperConfig) {
  const units = p.qty * p.contractValue;
  const notional = units * p.entryPrice;
  const entryFee = p.fills[0].fee;
  const exitRate = commissionRatePct(cfg) / 100;
  const direction = p.side === 'long' ? 1 : -1;
  return { version: 1, phase: 'filled', configFp: p.configFp ?? null,
    qty: p.qty, contractValue: p.contractValue, entry: p.entryPrice, stop: p.slOriginal,
    notional, margin: (p.marginLeverage ?? 0) > 0 ? notional / p.marginLeverage! : null,
    risk: p.riskAmount, entryFee, standardExitFeeAtEntry: notional * exitRate,
    exitFeeBasis: 'standard taker plus configured tax; no promotional waiver assumed',
    funding: 'not estimated', exitImpact: 'not estimated',
    targetScenario: 'full original quantity at each target independently; not a partial-exit forecast',
    targets: p.tp.map(price => ({ price, netBeforeFundingAndExitImpact:
      direction * (price - p.entryPrice) * units - entryFee - price * units * exitRate })),
    offerConfigured: !!cfg.scalperOffer?.enabled, offerEligibility: 'unverified' };
}
export function recordFillBudget(db: Db, p: Position, book: number, cfg: PaperConfig) {
  db.run('INSERT INTO decision_trace(at,book,signal_id,position_id,scanner_id,symbol,tf,stage,reason,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)',
    Date.now(),book,p.signalId,p.id,p.scannerId,p.symbol,p.tf,'filled',null,JSON.stringify(fillBudget(p,cfg)));
}
