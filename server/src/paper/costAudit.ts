import type {Db} from '../db.ts';
import type {AppConfig} from '../config.ts';
import type {Fill} from './logic.ts';
import {offerStatus} from './costs.ts';

/** Only observed costs are called realized; price impact without a reference is unknown. */
export function costAudit(db:Db,cfg:AppConfig) {
  const rows=db.all<any>(`SELECT p.*,d.snapshot FROM positions p LEFT JOIN decision_trace d ON d.id=(
    SELECT MAX(t.id) FROM decision_trace t WHERE t.position_id=p.id AND t.stage='filled')
    WHERE p.bt=0 AND p.status IN ('open','closed') ORDER BY p.entry_at DESC LIMIT 30`);
  return {offer:offerStatus(cfg.paper),joinedAt:cfg.paper.scalperOffer?.joinedAt??null,
    rows:rows.map(p=>{
      const fills:Fill[]=JSON.parse(p.fills)?.fills??[];
      const budget=p.snapshot?JSON.parse(p.snapshot):null;
      const orders=db.all<any>("SELECT side,qty,price,ref_price FROM orders WHERE position_id=? AND reason!='funding'",p.id);
      const referenced=orders.filter(o=>Number.isFinite(o.ref_price)&&o.ref_price>0);
      return {id:p.id,scannerId:p.scanner_id,symbol:p.symbol,tf:p.tf,status:p.status,entryAt:p.entry_at,
        notional:p.qty*p.contract_value*p.entry_price,net:p.realized_pnl-p.fees,
        entryLiquidity:fills[0]?.liquidity??'unknown',entryFee:fills.find(f=>f.reason==='entry')?.fee??null,
        estimatedExitFee:budget?.standardExitFeeAtEntry??null,
        exitFees:fills.filter(f=>f.reason!=='entry'&&f.reason!=='funding').reduce((n,f)=>n+f.fee,0),
        fundingCost:-fills.filter(f=>f.reason==='funding').reduce((n,f)=>n+f.pnl,0),
        waivedCloses:fills.filter(f=>f.reason!=='entry'&&f.feeWaived===true).length,
        breakEvenPrice:budget?.breakEvenPrice??null,
        priceShortfall:referenced.length?referenced.reduce((n,o)=>n+(o.price-o.ref_price)*(o.side==='buy'?1:-1)*o.qty*p.contract_value,0):null,
        priceCoverage:orders.length?referenced.length/orders.length:0};
    })};
}
