import type {TradePolicy} from '../paper/tradePolicy.ts';
import {tradePolicyIdFor,stablePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';

export function validReadinessPolicy(p:TradePolicy):boolean {
  try{return p.version===1&&!!p.sourceHash&&p.adoptedAt==null&&tradePolicyIdFor(p)===p.id&&strategyIdFor(p)===p.strategyId;}catch{return false;}
}

/** Global maker allocation lists in the sizing copy do not apply to other cells.
 * Keep the resolved execution policy and this cell's own maker rule exact. */
export function additionalReadinessCompatibility(previous:TradePolicy,current:TradePolicy):'scope'|'sizing-proof'|null {
  try{
    if(!validReadinessPolicy(previous)||!validReadinessPolicy(current))return null;
    const a=structuredClone(previous),b=structuredClone(current);
    for(const [oldCap,newCap] of [[a.paper.maxOpenPositions,b.paper.maxOpenPositions],[a.sizing.maxOpenPositions,b.sizing.maxOpenPositions],[a.risk.maxPositionsTotal,b.risk.maxPositionsTotal],[a.risk.maxPositionsPerSymbol,b.risk.maxPositionsPerSymbol]]){
      if(!Number.isSafeInteger(oldCap)||!Number.isSafeInteger(newCap)||oldCap<0||newCap<0||(newCap||Infinity)<(oldCap||Infinity))return null;
    }
    const terms=(p:TradePolicy)=>{
      const {id,strategyId,adoptedAt,...body}=p;
      body.paper.maxOpenPositions=0;body.sizing.maxOpenPositions=0;body.risk.maxPositionsTotal=0;body.risk.maxPositionsPerSymbol=0;
      const own=body.sizing.makerQuoteCells?.filter(r=>r.scannerId===p.scannerId&&r.symbol===p.symbol&&r.tf===p.tf);
      if(own?.length)body.sizing.makerQuoteCells=own;else delete body.sizing.makerQuoteCells;
      return body;
    };
    const old=terms(a),now=terms(b);
    if(stablePolicy(old)===stablePolicy(now))return 'scope';
    // Only removal of the capital-drawdown schedule is replayable here. This is
    // not permission to ignore changed risk settings or to reweight old profits.
    if(current.sim!==previous.sim||![211,212].includes(current.sim)||!a.risk.enabled||a.risk.ddFrom==='peak'||!a.risk.ddScale.length||b.risk.ddScale.length)return null;
    if(a.risk.ddScale.some(r=>!Number.isFinite(r.ddPct)||r.ddPct<0||r.ddPct>100||!Number.isFinite(r.leverageMult)||r.leverageMult<=0||r.leverageMult>1))return null;
    old.risk.ddScale=[];
    return stablePolicy(old)===stablePolicy(now)?'sizing-proof':null;
  }catch{return null;}
}

/** Readiness-only compatibility for an expansion of account or market slot capacity.
 * These controls admit additional trades; they do not change a recorded trade's
 * fills, costs, size or exits. Never infer extra trades, reprice history, or reuse
 * this exception for promotion/leverage. Tightening needs a separate replay. */
export function capacityExpansionCompatible(previous:TradePolicy,current:TradePolicy):boolean {
  try {
    for(const p of [previous,current]) {
      if(p.version!==1||!p.sourceHash||p.adoptedAt!=null||tradePolicyIdFor(p)!==p.id||strategyIdFor(p)!==p.strategyId)return false;
    }
    const oldCaps=[previous.paper.maxOpenPositions,previous.sizing.maxOpenPositions,previous.risk.maxPositionsTotal,previous.risk.maxPositionsPerSymbol];
    const newCaps=[current.paper.maxOpenPositions,current.sizing.maxOpenPositions,current.risk.maxPositionsTotal,current.risk.maxPositionsPerSymbol];
    const ceiling=(n:number)=>n===0?Infinity:n;
    if([...oldCaps,...newCaps].some(n=>!Number.isSafeInteger(n)||n<0))return false;
    if(oldCaps.some((n,i)=>ceiling(newCaps[i])<ceiling(n)))return false;
    if(oldCaps.every((n,i)=>n===newCaps[i]))return false;
    const terms=(p:TradePolicy)=>{
      const {id,strategyId,adoptedAt,...body}=structuredClone(p);
      // Only account-wide and per-market count ceilings may expand.
      body.paper.maxOpenPositions=0;
      body.sizing.maxOpenPositions=0;
      body.risk.maxPositionsTotal=0;
      body.risk.maxPositionsPerSymbol=0;
      return stablePolicy(body);
    };
    return terms(previous)===terms(current);
  }catch{return false;} // Missing/corrupt provenance is never compatibility evidence.
}
