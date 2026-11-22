import type {Db} from '../db.ts';
import type {FillComparison} from '../../../shared/chartVerification.ts';
import {depthBookKey} from '../paper/depthLiquidity.ts';
import {depthFill} from '../paper/entryExecution.ts';
import {priceExit,type ExitBook} from '../paper/exitExecution.ts';
import {tickDepthMaker} from '../paper/partialMaker.ts';
const parse=(s:string|null)=>{try{return s?JSON.parse(s):null;}catch{return null;}};
const delta=(actual:number,reference:number,side:string)=>((reference-actual)/actual*10000*(side==='buy'?1:-1))||0;
const levels=(v:unknown):v is Array<{price:number;size:number}>=>Array.isArray(v)&&v.every(l=>l&&Number.isFinite(Number(l.price))&&Number.isFinite(Number(l.size))&&Number(l.price)>0&&Number(l.size)>=0);
/** Verify the recorded passive model, not a hypothetical taker VWAP or queue priority. */
function makerCheck(db:Db,pos:any,o:any,mr:any,me:any,observation:any):string{
 const l=observation,t=l.trigger,arrival=l.arrivalDepth,fill=l.fillDepth;
 if(!mr||mr.book!==pos.bt||mr.qty!==o.qty||mr.at!==o.at||!(Number.isSafeInteger(mr.market_qty)&&mr.market_qty>0)||me?.ref!==o.price)
  return 'Maker report does not match the recorded order';
 if(t?.kind!=='trade'||!Number.isSafeInteger(t.qty)||t.qty<mr.market_qty||!Number.isFinite(t.price)||!(t.price>0)||
    (pos.side==='long'?t.price>o.price:t.price<o.price))
  return 'Maker print price or quantity does not support the fill';
 if([l.placedAt,l.arrivalAt,l.expiresAt,l.eventAt,l.observedAt].some(v=>!Number.isFinite(v)||v<=0)||
    l.placedAt>l.arrivalAt||l.arrivalAt>l.eventAt||l.eventAt>l.observedAt||l.observedAt!==o.at||o.at>=l.expiresAt)
  return 'Maker timing is inconsistent';
 for(const [book,at,qty] of [[arrival,l.arrivalAt,1],[fill,o.at,mr.market_qty]] as const){
  if(!book||!levels(book.bids)||!levels(book.asks)||book.evaluatedAt!==at||book.checkedQty<qty||book.receivedAt<l.placedAt)
   return 'Maker depth evidence is incomplete';
  for(const side of ['long','short'] as const){
   const check=priceExit(book,side,qty,at,1000);
   if(check.error||check.qty!==qty)return 'Maker depth is stale, invalid or insufficient';
  }
 }
 if(pos.side==='long'?o.price>=Math.min(...arrival.asks.map((v:{price:number})=>v.price)):o.price<=Math.max(...arrival.bids.map((v:{price:number})=>v.price)))
  return 'Maker order crossed the book on arrival';
 const used=db.get<{n:number}>(`SELECT coalesce(sum(m.market_qty),0) n FROM paper_maker_reports m JOIN positions p ON p.id=m.position_id WHERE m.book=? AND p.symbol=? AND m.print_key=? AND m.order_id<=? ${pos.bt===2?'AND m.position_id=?':''}`,pos.bt,pos.symbol,mr.print_key,o.id,...(pos.bt===2?[pos.id]:[]))?.n??0;
 if(used>t.qty)return 'Maker reports exceed the observed print quantity';
 return 'Tick/depth model evidence consistent; queue priority unverified';
}
/** Recorded evidence only: no market fetch, replay run, or inferred historical book. */
export function fillComparison(db:Db,id:number):FillComparison|null{
 const pos=db.get<any>('SELECT id,bt,symbol,side FROM positions WHERE id=?',id);if(!pos)return null;
 const has=(t:string)=>!!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",t);
 const entry=has('entry_fill_evidence')?db.get<any>('SELECT * FROM entry_fill_evidence WHERE position_id=?',id):null;
 const makerReports=has('paper_maker_reports')?db.all<any>('SELECT * FROM paper_maker_reports WHERE position_id=?',id):[];
 const reports=has('paper_exit_reports')?db.all<any>('SELECT r.*,i.ready_at,i.side,i.book,i.symbol,i.reason FROM paper_exit_reports r JOIN paper_exit_intents i ON i.id=r.intent_id WHERE i.position_id=? ORDER BY r.id',id):[];
 const audits=has('tape_audit')?db.all<any>("SELECT * FROM tape_audit WHERE position_id=? AND kind NOT LIKE 'limit%' ORDER BY id",id):[];
 const orders=db.all<any>("SELECT * FROM orders WHERE position_id=? AND bt=? AND qty>0 AND reason!='funding' ORDER BY at,id",id,pos.bt);
 return {positionId:id,symbol:pos.symbol,book:pos.bt,fills:orders.map(o=>{
  const depth:FillComparison['fills'][number]['depth']={status:'No exact depth retained',price:null,deltaBps:null,receivedAt:null,readyAt:null};
  let maker:string|null=null;
  const mr=makerReports.find(r=>r.order_id===o.id&&r.qty===o.qty&&r.at===o.at),me=parse(mr?.evidence??null);
  const observation=me?.limit??(entry?.order_id===o.id?parse(entry.limit_observation):null);
  if(observation){
   maker=observation.trigger?.kind==='candle'?'Candle-model fill; tick timing and queue unverified':tickDepthMaker(observation.model)?'Tick/depth quantity model; exchange queue position unverified':'Trade-through model; queue position unverified';
   if(mr&&observation.trigger?.kind==='trade')maker+=` · ${mr.market_qty} executable contracts / ${observation.trigger.qty} printed at ${observation.trigger.price}`;
   if(tickDepthMaker(observation.model)){
    depth.receivedAt=observation.fillDepth?.receivedAt??null;depth.readyAt=observation.arrivalAt??null;
    depth.status=makerCheck(db,pos,o,mr,me,observation);
   }
  }
  else if(o.price_source==='limit-candle-model')maker='Candle-model fill; no tick timing or queue proof';
  if(entry?.order_id===o.id){
   const d=parse(entry.depth);

   if(d){
    depth.receivedAt=d.receivedAt;depth.readyAt=null;
    const causal=levels(d.asks)&&levels(d.bids)&&d.side===pos.side&&entry.qty===o.qty&&entry.price===o.price&&Number.isFinite(d.consumedQty??0)&&(d.consumedQty??0)>=0&&Number.isFinite(d.requestedQty)&&d.requestedQty>0&&[d.receivedAt,d.exchangeAt].every(t=>Number.isFinite(t)&&t<=o.at&&t>0)&&Number.isFinite(d.evaluatedAt)&&d.receivedAt<=d.evaluatedAt&&d.exchangeAt<=d.evaluatedAt;
    const result=causal?depthFill(o.side==='buy'?d.asks:d.bids,d.requestedQty,pos.side,d.consumedQty??0):null;
    depth.price=result?.coverage===1?result.vwap:null;
    depth.status=!causal?'Invalid depth evidence':depth.price===null?'Incomplete depth':'Recorded entry depth';
    if(causal&&d.evaluatedAt>o.at)depth.status+=`; evaluation ${d.evaluatedAt-o.at} ms after recorded fill timestamp`;
   }
  }else{
   const matches=reports.filter(v=>v.at===o.at&&v.reason===o.reason&&v.qty===o.qty&&v.price===o.price);
   if(matches.length===1){
    const r=matches[0],book=parse(r.depth) as (ExitBook & {consumedQty?:number})|null;
    let used=db.get<{n:number}>(`SELECT coalesce(sum(p.market_qty),0) n FROM paper_exit_reports p JOIN paper_exit_intents i ON i.id=p.intent_id WHERE p.id<? AND p.book_key=? AND i.book=? AND i.symbol=? AND i.side=? ${r.book===2?'AND i.position_id=?':''}`,r.id,r.book_key,r.book,r.symbol,r.side,...(r.book===2?[id]:[]))?.n??0;
    let recordedConsumption=false;
    if(book&&Number.isFinite(book.consumedQty)&&book.consumedQty!>=0){used=book.consumedQty!;recordedConsumption=true;}
    else if(r.book===0&&has('entry_fill_evidence')){
     const prior=db.all<any>('SELECT e.depth,e.qty FROM entry_fill_evidence e JOIN positions p ON p.id=e.position_id WHERE e.book=0 AND p.symbol=? AND p.side!=? AND e.order_id<? AND e.at BETWEEN ? AND ?',r.symbol,r.side,o.id,r.at-1000,r.at);
     for(const e of prior){const d=parse(e.depth);if(d&&levels(d.bids)&&levels(d.asks)&&depthBookKey(d)===r.book_key)used+=e.qty;}
    }
    const result=book&&levels(book.bids)&&levels(book.asks)&&book.receivedAt>=r.ready_at?priceExit(book,r.side,r.market_qty,r.at,1000,used):null;
    depth.receivedAt=book?.receivedAt??null;depth.readyAt=r.ready_at;depth.price=result&&!result.error&&result.qty===r.market_qty?result.price:null;
    depth.status=depth.price!==null?(recordedConsumption?'Recorded exit depth':'Reconstructed exit depth; prior consumption inferred'):result?.error??(result?'Incomplete depth for recorded exit quantity':'Depth predates order arrival or is missing');
   }else if(matches.length>1)depth.status='Ambiguous depth reports';
  }
  if(depth.price!==null){depth.deltaBps=delta(o.price,depth.price,o.side);if(Math.abs(depth.deltaBps)>1e-6)depth.status+=' · price differs';}
  // Older audits mistook later maker partials for market entries after their first
  // fill consumed the placement tracker. Never use that taker benchmark for a maker.
  const passiveEntry=o.reason==='entry'&&o.price_source?.startsWith('limit-');
  const matches=passiveEntry?[]:audits.filter(t=>t.at===o.at&&t.side===o.side&&t.paper_price===o.price);
  const duplicateOrder=orders.filter(v=>v.at===o.at&&v.side===o.side&&v.price===o.price).length>1;
  const t=matches.length===1&&!duplicateOrder?matches[0]:null,extra=parse(t?.extra??null);
  const status=passiveEntry?'Maker fill; inspect recorded print/depth evidence':matches.length>1||(matches.length>0&&duplicateOrder)?'Ambiguous tape records':!t?'No tape benchmark retained':extra?.unobserved?'Unobserved trigger / restart':(extra?.lateSec??0)>10?'Late print; not a fill-accuracy benchmark':!(t.prints>0)?'No observed print':'Public print benchmark; not executable depth';
  const valid=t&&t.prints>0&&!extra?.unobserved&&(extra?.lateSec??0)<=10;
  return {id:o.id,at:o.at,reason:o.reason,side:o.side,qty:o.qty,price:o.price,source:o.price_source,depth,
   tape:{status,first:t?.first_print??null,vwap:t?.tape_price??null,deltaBps:valid&&t.tape_price>0?delta(o.price,t.tape_price,o.side):null},maker};
 })};
}
