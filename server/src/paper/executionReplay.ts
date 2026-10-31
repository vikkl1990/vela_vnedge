/** Replays supplied signals and market observations through both real paper fill modes.
 * This compares execution assumptions; it does not regenerate scanner signals or infer queue priority.
 */
import { Db } from '../db.ts';
import { MarkStore } from '../data/marks.ts';
import type { AppConfig } from '../config.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import type { WsQuote, WsTrade } from '../delta/ws.ts';
import type { PriceBar } from './logic.ts';
import { PaperEngine, type EntryContext } from './engine.ts';

export type ExecutionObservation =
  | { kind: 'entry'; at: number; signal: ScanEvent; context: EntryContext }
  | { kind: 'quote'; at: number; quote: WsQuote }
  | { kind: 'trade'; at: number; trade: WsTrade }
  | { kind: 'candle'; at: number; symbol: string; bar: PriceBar }
  | { kind: 'disconnect'; at: number }
  | { kind: 'clock'; at: number };

export function compareExecution(config: AppConfig, observations: ExecutionObservation[]) {
  if (observations.length > 100_000) throw Error('execution comparison is limited to 100000 observations per run');
  let previous = -Infinity;
  for (const e of observations) {
    if (!Number.isFinite(e.at) || e.at < previous) throw Error('observations must be ordered by receipt time; exchange times may be out of order');
    previous = e.at;
  }
  return (['candles', 'tape'] as const).map(mode => {
    const db = new Db(':memory:');
    try {
      const cfg = structuredClone(config); cfg.execution.mode = 'paper'; cfg.paper.fillSource = mode;
      const engine = new PaperEngine(db, () => cfg), quotes = new MarkStore(); engine.quotes = quotes;
      const fills: Array<{positionId:number;reason:string;at:number;price:number;qty:number;fee:number;pnl:number}> = [];
      engine.on('order', f => { fills.push({positionId:f.positionId,reason:f.reason,at:f.at,price:f.price,qty:f.qty,fee:f.fee,pnl:f.pnl}); });
      const decisions: Array<{at:number;action:string;reason:string|null}> = [];
      for (const event of observations) {
        switch (event.kind) {
          case 'entry': {
            const d = engine.onEntry(structuredClone(event.signal), {...structuredClone(event.context), at:event.at});
            decisions.push({at:event.at,action:d.action,reason:d.reason ?? null}); break;
          }
          case 'quote': quotes.onWsQuote({...event.quote,receivedAt:event.at}); break;
          case 'trade': engine.onTrade(event.trade.symbol,event.trade.price,event.trade.qty,event.trade.timeMs,event.at); break;
          case 'candle': engine.onBar(event.symbol,event.bar,event.at); break;
          case 'disconnect': quotes.invalidateQuotes(); break;
          case 'clock': engine.housekeeping(event.at); break;
        }
      }
      return {mode,decisions,fills,open:engine.openPositions().length,pending:engine.pendingEntries().length,realizedNet:fills.reduce((sum,f)=>sum+f.pnl-f.fee,0),commission:fills.reduce((sum,f)=>sum+f.fee,0)};
    } finally { db.db.close(); }
  });
}
