import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';
import type { Position } from './logic.ts';
import { commissionRatePct, offerStatus } from './costs.ts';

/** An immutable fill-time budget, not a prediction of trade profitability. */
export function fillBudget(p: Position, cfg: PaperConfig) {
  const units = p.qty * p.contractValue;
  const notional = units * p.entryPrice;
  const entryFee = p.basket?p.fills.filter(f=>f.reason==='entry').reduce((n,f)=>n+f.fee,0):p.fills[0].fee;
  const exitRate = commissionRatePct(cfg) / 100;
  const direction = p.side === 'long' ? 1 : -1;
  const breakEvenPrice = (p.entryPrice + direction * entryFee / units) / (1 - direction * exitRate);
  return { version: 2, phase: 'filled', configFp: p.configFp ?? null,
    ...(p.basket?{basketEntries:p.basket.entries,basketAccountingVersion:p.executionPlan?.basketAccountingVersion??1,riskBasis:p.executionPlan?.basketAccountingVersion===2?'latest confirmed basket: paid entry fees and funding debits plus one modeled stop fill and closing fee':'legacy basket price-distance risk'}:{}),
    executionPlan:p.executionPlan ? {id:p.executionPlan.id,revision:p.executionPlan.revision,signature:p.executionPlan.signature} : null,
    entryLiquidity:p.fills[0].liquidity??'unknown',breakEvenPrice,
    breakEvenBasis:'full quantity, entry fee plus standard taker exit fee; excludes future funding and exit impact',
    qty: p.qty, contractValue: p.contractValue, entry: p.entryPrice, stop: p.slOriginal,
    notional, margin: (p.marginLeverage ?? 0) > 0 ? notional / p.marginLeverage! : null,
    risk: p.riskAmount, entryFee, standardExitFeeAtEntry: notional * exitRate,
    exitFeeBasis: 'standard taker plus configured tax; no promotional waiver assumed',
    funding: 'not estimated', exitImpact: 'not estimated',
    targetScenario: 'full original quantity at each target independently; not a partial-exit forecast',
    targets: p.tp.map(price => ({ price, netBeforeFundingAndExitImpact:
      direction * (price - p.entryPrice) * units - entryFee - price * units * exitRate })),
    offerConfigured: !!cfg.scalperOffer?.enabled, offerEligibility: offerStatus(cfg) };
}
export function recordFillBudget(db: Db, p: Position, book: number, cfg: PaperConfig,stage='filled') {
  db.run('INSERT INTO decision_trace(at,book,signal_id,position_id,scanner_id,symbol,tf,stage,reason,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)',
    stage==='basket-add'?p.fills.at(-1)!.at:Date.now(),book,p.signalId,p.id,p.scannerId,p.symbol,p.tf,stage,null,JSON.stringify(fillBudget(p,cfg)));
}
