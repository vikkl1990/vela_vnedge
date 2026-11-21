/** Unchanged causal baseline for the offline SOL diagnostic; no network or config writes. */
import {Db} from '../../server/src/db.ts';
import {PaperEngine} from '../../server/src/paper/engine.ts';
import {DEFAULT_CONFIG} from '../../server/src/config.ts';
import {isExecutableTrade} from '../../server/src/execution/tradeFreshness.ts';
export function entryRow(row:any){
 const r=structuredClone(row),extra=JSON.parse(r.fills),fills=extra.fills.filter((f:any)=>f.reason==='entry');
 if(!fills.length||fills.some((f:any)=>f.at>r.entry_at)||Math.abs(fills.reduce((s:number,f:any)=>s+f.qty,0)-r.qty)>1e-9)throw Error('unsupported partial/basket entry chronology');
 r.status='open';r.qty_open=r.qty;r.sl=r.sl_original;r.tp_hit=JSON.stringify(JSON.parse(r.tp).map(()=>false));r.break_even=0;r.realized_pnl=0;r.fees=fills.reduce((s:number,f:any)=>s+f.fee,0);
 r.exit_at=null;r.exit_price=null;r.exit_reason=null;r.signal_id=null;r.peak_r=0;r.peak_at=null;r.worst_r=0;r.worst_at=null;
 for(const k of ['lastPriceBar','peakR','peakAt','worstR','worstAt','trailOff','trailArmedAt','trailPeakR','trailPeakAt','basket'])delete extra[k];
 extra.fills=fills;r.fills=JSON.stringify(extra);return r;
}
export function fundingDue(p:any,original:any,at:number){
 for(const f of JSON.parse(original.fills).fills.filter((f:any)=>f.reason==='funding'&&f.at<=at)){
  if(p.status!=='open'||p.fills.some((a:any)=>a.reason==='funding'&&a.at===f.at))continue;
  const n={...f,pnl:f.pnl*p.qtyOpen/original.qty};p.realizedPnl+=n.pnl;p.fills.push(n);
 }
}
export function makeTrial(row:any,policy:any,state:any,id:string,stress=false){
 if(!policy||policy.sim<211||row.policy_adopted_at)throw Error('no causal immutable policy');
 if(!state||!Number.isInteger(state.market_qty)||state.market_qty<1)throw Error('no frozen execution size');
 let now=row.entry_at;const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';cfg.execution.allowProduction=false;
 const pol=structuredClone(policy);if(id!=='current'||stress)throw Error('Only the unchanged baseline is supported');cfg.paper=pol.paper;
 const db=new Db(':memory:');db.run('INSERT INTO trade_policies(id,strategy_id,source_hash,snapshot) VALUES(?,?,?,?)',pol.id,pol.strategyId,pol.sourceHash,JSON.stringify(pol));
 const r=entryRow(row),keys=Object.keys(r);db.run(`INSERT INTO positions(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>r[k]));
 const engine=new PaperEngine(db,()=>cfg,{book:row.bt,now:()=>now});engine.causalExits=true;const p=engine.position(row.id)!;engine.exitExecution.register(p,state.market_qty);
 let globalGaps=0,depthGaps=0,lastTick=-Infinity,events=0;
 const observe=(e:any)=>{
  if(e.at<row.entry_at||e.at>row.exit_at+120000||p.status!=='open')return;
  now=e.at;if(e.kind==='globalGap'){globalGaps++;return;}if(e.symbol!==row.symbol)return;
  fundingDue(p,row,now);events++;
  if(e.kind==='depthGap'){depthGaps++;return;}
  if(e.kind==='trade'){
   const t=e.payload;if(!isExecutableTrade(t,now)||t.timeMs<lastTick)return;lastTick=t.timeMs;
   engine.onTrade(row.symbol,t.price,t.qty,t.timeMs,now,t.id);
  }else if(e.kind==='mark')engine.onMarkPrice(row.symbol,e.payload.markPrice,e.payload.timeMs);
  else if(e.kind==='paper_closed_minute'&&row.bt===0)engine.onClosedMinute(row.symbol,e.payload.bar,now,e.payload.historical);
  else if(e.kind==='paper_bar'&&e.payload.book===row.bt)engine.onBar(row.symbol,e.payload.bar,now,{historical:e.payload.historical});
  else if(e.kind==='depth'){
   const b=structuredClone(e.payload);if(stress){const mult=1+(p.side==='long'?-1:1)*.0005;for(const xs of [b.bids,b.asks])for(const l of xs)l.price*=mult;}
   engine.settleExits(row.symbol,b,now);
  }
 };
 return {observe,engine,p,db,result:()=>({id:row.id,book:row.bt,symbol:row.symbol,variant:id,stress,status:p.status,net:p.status==='closed'?p.realizedPnl-p.fees:null,r:p.status==='closed'?(p.realizedPnl-p.fees)/p.riskAmount:null,exitAt:p.exitAt,exitPrice:p.exitPrice,reason:p.exitReason,fees:p.fees,globalGaps,depthGaps,events,intents:db.all('SELECT * FROM paper_exit_intents'),reports:db.all('SELECT at,qty,market_qty,price FROM paper_exit_reports'),parityDeltaR:p.status==='closed'?((p.realizedPnl-p.fees)-(row.realized_pnl-row.fees))/p.riskAmount:null,actualNet:row.realized_pnl-row.fees,actualR:(row.realized_pnl-row.fees)/row.risk_amount,actualReason:row.exit_reason,actualExitAt:row.exit_at})};
}
