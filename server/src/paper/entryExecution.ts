import type { Db } from '../db.ts';
import type { PaperConfig } from '../config.ts';
import type { Position } from './logic.ts';
import { commissionRatePct } from './costs.ts';
export function initEntryExecution(db: Db) {
  db.run(`CREATE TABLE IF NOT EXISTS entry_execution (
    position_id INTEGER PRIMARY KEY, book INTEGER NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    entry_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL, source TEXT, entry_price REAL, notional REAL, entry_fee REAL, expected_exit_fee REAL,
    bid REAL, ask REAL, quote_at INTEGER, quote_exchange_at INTEGER, spread_bps REAL, signal_delay_ms INTEGER,
    depth_state TEXT NOT NULL DEFAULT 'waiting', depth_at INTEGER, depth_lag_ms INTEGER, depth_vwap REAL, depth_impact_bps REAL,
    depth_coverage REAL, depth_error TEXT)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_entry_execution_at ON entry_execution(entry_at DESC)');
  db.run("UPDATE entry_execution SET depth_state='interrupted by restart' WHERE depth_state='waiting'");
}
export function recordEntryExecution(db: Db, p: Position, book: number, cfg: PaperConfig, source: string | undefined,
  q?: { bestBid: number | null; bestAsk: number | null; quoteAt?: number | null; quoteExchangeAt?: number | null }) {
  const bid=q?.bestBid ?? null, ask=q?.bestAsk ?? null;
  const spread=bid && ask && ask>=bid ? (ask-bid)/((ask+bid)/2)*10000 : null;
  const signal=p.signalId ? db.get<{ at: number }>('SELECT at FROM signals WHERE id=?',p.signalId) : undefined;
  const notional=p.entryPrice*p.qty*p.contractValue;
  db.run(`INSERT OR IGNORE INTO entry_execution(position_id,book,scanner_id,symbol,tf,entry_at,recorded_at,source,entry_price,notional,entry_fee,expected_exit_fee,bid,ask,quote_at,quote_exchange_at,spread_bps,signal_delay_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.id,book,p.scannerId,p.symbol,p.tf,p.entryAt,Date.now(),source??null,p.entryPrice,notional,p.fills[0].fee,
    notional*commissionRatePct(cfg)/100,bid,ask,q?.quoteAt??null,q?.quoteExchangeAt??null,spread,signal ? p.entryAt-signal.at : null);
}
/** Sizes are contracts. Incomplete depth reports coverage, never an invented full-size fill. */
export function depthFill(levels: Array<{price: string | number; size: string | number}>, qty: number, side: 'long' | 'short') {
  const sorted=levels.map(l=>({p:Number(l.price),q:Number(l.size)})).filter(l=>l.p>0&&Number.isFinite(l.p)&&l.q>0&&Number.isFinite(l.q)).sort((a,b)=>side==='long'?a.p-b.p:b.p-a.p);
  if (!(qty>0) || !sorted.length) return { coverage: 0, vwap: null, impactBps: null };
  let filled=0,value=0;
  for(const l of sorted){const n=Math.min(qty-filled,l.q);filled+=n;value+=n*l.p;if(filled>=qty)break;}
  const vwap=value/filled;
  return {coverage:filled/qty,vwap,impactBps:(vwap/sorted[0].p-1)*10000*(side==='long'?1:-1)};
}
