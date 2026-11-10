import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import type { EvidenceCell } from './trades.ts';

export type GateStage = 'copy'|'admission'|'execution'|'recovery'|'pending';
export interface GatedSignal extends EvidenceCell {
  book:number; at:number; event:ScanEvent; stage:GateStage; reason:string;
  signalId?:number|null; policyId?:string|null; sourceHash?:string|null;
  snapshot:Record<string,unknown>;
}

/** Diagnostic observations have their own table and no position/P&L. A later replay
 * must remain a separate experiment; these records can never count for promotion. */
export function recordGatedSignal(db:Db,g:GatedSignal):void {
  if(g.event.kind!=='entry'||!g.event.side||![0,2].includes(g.book)||g.scannerId.startsWith('plan:'))return;
  const key=createHash('sha256').update(JSON.stringify([g.book,g.scannerId,g.symbol,g.tf,
    g.event.barTime,g.event.kind,g.event.side,g.event.label,g.sourceHash??null,g.stage])).digest('hex');
  db.run(`INSERT OR IGNORE INTO gated_signals(event_key,at,book,scanner_id,symbol,tf,bar_time,side,stage,reason,signal_id,policy_id,source_hash,snapshot)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,g.at,g.book,g.scannerId,g.symbol,g.tf,g.event.barTime,g.event.side,g.stage,g.reason,g.signalId??null,g.policyId??null,g.sourceHash??null,
    JSON.stringify({version:1,...g.snapshot,event:g.event,outcome:'not-executed',promotionEligible:false}));
}

/** Bounded, read-only journal. Counts are observations, not wins/losses or trades. */
export function gatedSignalPage(db:Db,params:URLSearchParams) {
  const numeric=(key:string,fallback:number)=>{const raw=params.get(key),n=raw===null?fallback:Number(raw);return Number.isFinite(n)?n:fallback;};
  const book=params.get('book')==='paper'?0:params.get('book')==='shadow'?2:null;
  const limit=Math.min(500,Math.max(1,Math.floor(numeric('limit',100))));
  const before=Math.max(0,numeric('before',Number.MAX_SAFE_INTEGER));
  const since=Math.max(0,numeric('since',Date.now()-7*86400_000));
  const where=['at>=?','id<?'],args:any[]=[since,before];
  if(book!==null){where.push('book=?');args.push(book);}
  for(const [query,column] of [['scannerId','scanner_id'],['symbol','symbol'],['tf','tf'],['stage','stage']] as const){
    const value=params.get(query);if(value){where.push(`${column}=?`);args.push(value);}
  }
  const rows=db.all<any>(`SELECT * FROM gated_signals WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,...args,limit);
  return {scope:'diagnostic-only',promotionEligible:false,rows:rows.map(r=>({...r,snapshot:JSON.parse(r.snapshot)})),nextBefore:rows.length===limit?rows.at(-1).id:null};
}
