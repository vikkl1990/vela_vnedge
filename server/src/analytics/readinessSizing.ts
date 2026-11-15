import type {Db} from '../db.ts';
import type {TradePolicy} from '../paper/tradePolicy.ts';
import {sizeContracts,feeFor,type Fill} from '../paper/logic.ts';
import {depthFill,type EntryDepthSnapshot} from '../paper/entryExecution.ts';
import {additionalReadinessCompatibility} from './readinessCompatibility.ts';

const near=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-9,Math.abs(b)*1e-8);
const positive=(n:number)=>Number.isFinite(n)&&n>0;
export type SizingProof={ok:true;equity:number;qty:number;risk:number}|{ok:false;reason:'different-size'|'missing-sizing-proof'};

/** Replay-only exception for version 211, ordinary full-quantity depth-priced
 * market entries. No candle, missing book, partial entry, basket, estimated equity,
 * reconstructed fee or hypothetical larger fill may qualify through this path. */
export function proveSameReadinessSize(db:Db,positionId:number,previous:TradePolicy,current:TradePolicy):SizingProof {
  const missing={ok:false as const,reason:'missing-sizing-proof' as const};
  const different={ok:false as const,reason:'different-size' as const};
  try{
    if(additionalReadinessCompatibility(previous,current)!=='sizing-proof')return missing;
    const r=db.get<any>('SELECT * FROM positions WHERE id=?',positionId);
    if(!r||r.bt!==0||r.evidence_scope!=='account'||r.status!=='closed'||r.policy_id!==previous.id||r.scanner_id!==previous.scannerId||r.symbol!==previous.symbol||r.tf!==previous.tf||r.policy_adopted_at!=null||r.entry_at>r.exit_at||!positive(r.risk_amount))return missing;
    if(previous.sim!==211||current.sim!==211||previous.sizing.sizingMode!=='margin'||current.sizing.sizingMode!=='margin'||(previous.paper.depthUsdPerBp??0)!==0||(previous.sizing.depthUsdPerBp??0)!==0)return missing;
    const meta=JSON.parse(r.fills),fills=meta.fills as Fill[],entries=fills.filter(f=>f.reason==='entry');
    if(meta.basket||meta.executionPlan||entries.length!==1||!Number.isSafeInteger(r.qty)||r.qty<=0||!positive(meta.leverage)||!positive(meta.marginLeverage)||!positive(r.sl_original))return missing;
    const entry=entries[0];
    if(entry.liquidity!=='taker'||entry.qty!==r.qty||entry.at!==r.entry_at||!near(entry.price,r.entry_price)||!positive(r.contract_value))return missing;
    if(!near(fills.filter(f=>f.reason!=='entry'&&f.reason!=='funding').reduce((n,f)=>n+f.qty,0),r.qty))return missing;
    const order=db.get<any>("SELECT * FROM orders WHERE id=? AND position_id=? AND bt=0 AND reason='entry'",entry.orderId,r.id);
    const evidence=db.get<any>('SELECT * FROM entry_fill_evidence WHERE position_id=? AND book=0',r.id);
    if(!order||!evidence||order.at!==r.entry_at||evidence.at!==r.entry_at||evidence.order_id!==entry.orderId||order.qty!==r.qty||evidence.qty!==r.qty||order.price_source!=='depth'||evidence.source!=='depth'||evidence.role!=='taker'||!near(order.price,r.entry_price)||!near(evidence.price,r.entry_price)||!near(order.fee,entry.fee))return missing;
    const depth=JSON.parse(evidence.depth) as EntryDepthSnapshot;
    if(depth.source!=='l2-rest'||depth.side!==r.side||depth.requestedQty!==r.qty||!positive(depth.evaluatedAt)||depth.evaluatedAt<r.entry_at||depth.evaluatedAt-r.entry_at>1000||!positive(depth.receivedAt)||depth.receivedAt>depth.evaluatedAt||depth.evaluatedAt-depth.receivedAt>previous.paper.quoteMaxAgeMs)return missing;
    const levels=r.side==='long'?depth.asks:depth.bids;
    const priced=depthFill(levels,r.qty,r.side);
    if(priced.coverage<1||!near(priced.vwap!,depth.vwap))return missing;
    const fillQuote=r.side==='long'?order.ask:order.bid;
    if(!positive(fillQuote)||!positive(order.quote_at)||order.quote_at>r.entry_at||r.entry_at-order.quote_at>previous.paper.quoteMaxAgeMs)return missing;
    const executionPrice=r.side==='long'?Math.max(fillQuote,depth.vwap):Math.min(fillQuote,depth.vwap);
    if(!near(executionPrice,r.entry_price))return missing; // depthPlan retains the worse quote/VWAP.
    const traces=db.all<{at:number;snapshot:string}>("SELECT at,snapshot FROM decision_trace WHERE position_id=? AND book=0 AND stage='pending' AND at<=? ORDER BY at DESC",r.id,r.entry_at);
    const admissions=traces.map(t=>({...t,value:JSON.parse(t.snapshot)})).filter(t=>t.value.version===3&&t.value.policyId===previous.id&&t.value.configFp===r.config_fp&&t.value.sourceHash===previous.sourceHash);
    if(admissions.length!==1)return missing;
    const admission=admissions[0].value,market=admission.market;
    if(admission.executionPlan||admission.side!==r.side||!positive(admission.signalAt)||admission.signalAt>r.entry_at||!positive(market?.maxLeverage)||!positive(market?.tickSize)||!near(market.contractValue,r.contract_value)||!near(market.maintenanceMarginPct,meta.maintenanceMarginPct))return missing;
    // The delayed market path uses the same fixed stop at admission and fill.
    // Exclude configured resting orders and selective reclaim setups.
    if(previous.paper.limitEntry?.enabled||meta.features?.reclaim_trial||previous.reading.entryProtection==='native')return missing;
    const quote=admission.quote,price=r.side==='long'?quote?.bestAsk:quote?.bestBid;
    if(!positive(price)||!positive(quote?.quoteAt)||quote.quoteAt>admission.signalAt||admission.signalAt-quote.quoteAt>previous.paper.quoteMaxAgeMs||!previous.paper.useSpread)return missing;
    const scale=admission.sizeScale;
    if(!positive(scale)||scale>1||!near(entry.fee,feeFor(r.entry_price,r.qty,r.contract_value,previous.paper)))return missing;
    const equity=r.entry_price*r.qty*r.contract_value/meta.leverage;
    if(!positive(equity)||!positive(previous.sizing.initialEquity))return missing;
    const mults=[1,...previous.risk.ddScale.map(r=>r.leverageMult)];
    const scaled=(mult:number)=>{
      const cfg=previous.sizing,maxLeverage=Math.max(1,cfg.maxLeverage*mult);
      return {...cfg,riskPerTradePct:cfg.riskPerTradePct*mult,maxLeverage,minLeverage:Math.min(maxLeverage,Math.max(1,cfg.minLeverage*mult)),marginPerTrade:cfg.marginPerTrade!*mult};
    };
    const tiers=previous.sizing.marginLeverage;
    if(!tiers)return missing;
    const wanted=[...new Set([tiers.base,tiers.strong,tiers.weak])];
    const calculate=(p:number,e:number,cfg:TradePolicy['sizing'],lev:number)=>sizeContracts(p,r.sl_original,{equity:e,availableMargin:Infinity,contractValue:r.contract_value,tickSize:market.tickSize,maintenanceMarginPct:market.maintenanceMarginPct,maxLeverage:market.maxLeverage,cfg,wantedLeverage:lev,entryExecution:{quoted:true},sizeScale:scale});
    const same=(a:ReturnType<typeof sizeContracts>,b:ReturnType<typeof sizeContracts>)=>a.qty===b.qty&&near(a.riskAmount,b.riskAmount)&&near(a.marginLeverage,b.marginLeverage);
    // Exchange leverage must dominate both ceilings; otherwise removing scaling
    // can change the account notional budget even if the margin tier looks alike.
    if(mults.some(m=>market.maxLeverage>scaled(m).maxLeverage))return different;
    // At/below initial capital, the unchanged stop ceiling must dominate the old
    // reduced margin at both recorded prices for EVERY possible leverage tier.
    // Above initial capital, the old capital-based rule already applies factor 1.
    for(const lev of wanted){
      if(!positive(lev))return missing;
      for(const p of [price,fillQuote,r.entry_price])for(const m of mults){
        const a=calculate(p,previous.sizing.initialEquity,scaled(m),lev),b=calculate(p,previous.sizing.initialEquity,current.sizing,lev);
        if(!same(a,b))return different;
      }
    }
    // Verify the ACTUAL size and modeled stop risk, not a rescaled historical R.
    const candidates=wanted.map(lev=>calculate(r.entry_price,equity,current.sizing,lev)).filter(s=>near(s.marginLeverage,meta.marginLeverage));
    if(!candidates.length||candidates.some(s=>s.qty!==r.qty||!near(s.riskAmount,r.risk_amount)))return different;
    return {ok:true,equity,qty:r.qty,risk:r.risk_amount};
  }catch{return missing;}
}
