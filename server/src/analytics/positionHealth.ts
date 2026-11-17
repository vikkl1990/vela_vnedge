import type { PositionHealth, ReplayCoverage } from '../../../shared/positionHealth.ts';
import type { PaperConfig } from '../config.ts';
import { fillExit, type Position } from '../paper/logic.ts';
import { priceExit, type ExitBook } from '../paper/exitExecution.ts';

export const POSITION_DEPTH_MAX_AGE_MS = 1000;
export function positionHealth(p: Position, cfg: PaperConfig, book: ExitBook | null, at: number,
  coverage: { entry: PositionHealth['coverage']['entry']; pendingFunding: number; replay: ReplayCoverage | null }): PositionHealth {
  const quote = priceExit(book, p.side, p.qtyOpen, at, POSITION_DEPTH_MAX_AGE_MS);
  const full = !quote.error && quote.qty === p.qtyOpen && quote.price !== null;
  const copy = structuredClone(p);
  const exit = full ? fillExit(copy, quote.price!, p.qtyOpen, 'close-now-estimate', at, cfg, 'depth') : null;
  const stop = p.sl, dir = p.side === 'long' ? 1 : -1;
  const delta = stop === null ? null : (stop - p.entryPrice) * dir;
  const liquidationBeforeStop = stop !== null && p.liqPrice !== null && (stop - p.liqPrice) * dir <= 0;
  const stopCopy = structuredClone(p);
  // Future trigger time is unknown: do not promise a time-limited closing-fee discount.
  if (stop !== null && stop > 0 && !liquidationBeforeStop)
    fillExit(stopCopy, stop, p.qtyOpen, 'stop-level-estimate', at, {...cfg, scalperOffer: cfg.scalperOffer ? {...cfg.scalperOffer, enabled: false} : undefined}, 'depth');
  const age = book ? Math.max(at - book.receivedAt, at - book.exchangeAt) : null;
  return {
    id: p.id,
    identity: {symbol:p.symbol,side:p.side,entryAt:p.entryAt,entryPrice:p.entryPrice,qtyOpen:p.qtyOpen,sl:p.sl,realizedPnl:p.realizedPnl,fees:p.fees},
    at,
    closeNow: {netUsd:exit ? copy.realizedPnl-copy.fees : null,price:full ? quote.price : null,
      filledQty:quote.qty,requestedQty:p.qtyOpen,grossExitFee:exit?.feeGross??exit?.fee??null,
      cashExitFee:exit?.fee??null,feeDiscount:exit?.feeDiscount??null,
      validForMs:full && age !== null ? Math.max(0,POSITION_DEPTH_MAX_AGE_MS-age) : 0,
      depthAgeMs:age,reason:quote.error??(!full?'Insufficient depth for the remaining position':null)},
    stop: {price:stop,state:delta===null?'none':Math.abs(delta)<1e-10?'entry-price':delta>0?'profit-level':
      p.slOriginal!==null && (stop!-p.slOriginal)*dir>1e-10?'reduced-loss':'initial',
      netAtLevel:stop!==null && stop>0 && !liquidationBeforeStop ? stopCopy.realizedPnl-stopCopy.fees : null,liquidationBeforeStop},
    coverage: {...coverage, policy:p.policy?(p.policy.adoptedAt!=null?'adopted':'frozen'):'legacy'},
  };
}
