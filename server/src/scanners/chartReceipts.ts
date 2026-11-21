import type {Db} from '../db.ts';
import type {WorkerResult} from '../pine/worker.ts';
import type {Bar} from '../data/candleStore.ts';
import type {ScannerConfig} from '../config.ts';
import {declaredChannels,type ScanEvent} from './extractor.ts';
import type {SignalReceipt} from '../../../shared/chartVerification.ts';
import {sourceHash} from '../paper/fingerprint.ts';
import {createHash} from 'node:crypto';
import {chartHistoryText} from '../../../shared/chartVerification.ts';
const initialized=new WeakSet<Db>();
export function initChartReceipts(db:Db){if(initialized.has(db))return;db.run('CREATE TABLE IF NOT EXISTS chart_signal_receipts(scanner_id TEXT NOT NULL,symbol TEXT NOT NULL,tf TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scanner_id,symbol,tf))');initialized.add(db);}
/** One bounded latest-bar receipt per cell, from the existing run; never runs Pine or changes admission. */
export function recordChartReceipt(db:Db,id:string,symbol:string,tf:string,source:string,sc:Partial<ScannerConfig>|undefined,bars:Bar[],res:WorkerResult,events:ScanEvent[]){
 try{
  const bar=bars.at(-1);if(!bar)return;initChartReceipts(db);
  const outputs:SignalReceipt['outputs']=Object.create(null);let count=0,truncated=false;
  for(const p of [...res.shapes.map(s=>({title:s.key??s.title,kind:'shape' as const,value:s.times.includes(bar.time)?1:0})),...res.plots.map(p=>({title:p.key??p.title,kind:'plot' as const,value:p.data.findLast(v=>v.time===bar.time)?.value??null}))]){
   if(++count>80||p.title.length>160||Object.hasOwn(outputs,p.title)){truncated=true;continue;}outputs[p.title]={kind:p.kind,value:p.value};
  }
  const receipt:SignalReceipt={scannerId:id,symbol,tf,barTime:bar.time,at:Date.now(),sourceHash:sourceHash(source),inputs:sc?.inputs??{},timezone:sc?.timezone??'UTC',historyFrom:bars[0].time,bars:bars.length,historyHash:createHash('sha256').update(chartHistoryText(bars,bar.time)).digest('hex'),candle:bar,outputs,
   signals:events.filter(e=>e.barTime===bar.time&&e.kind!=='info').map(e=>({kind:e.kind,side:e.side,label:e.label,source:e.source})).slice(0,30),
   signalCoverage:sc?.sources?.length===1&&sc.sources[0]==='shape'&&!declaredChannels(source).has('alert')&&!declaredChannels(source).has('alertcondition')&&!/label\.new/.test(source)&&res.shapes.length>0&&!res.alerts.length&&!res.labels.length&&!sc?.rule&&events.every(e=>e.source==='shape')?'shape':'outputs-only',truncated};
  db.run(`INSERT INTO chart_signal_receipts VALUES(?,?,?,?,?) ON CONFLICT(scanner_id,symbol,tf) DO UPDATE SET at=excluded.at,payload=excluded.payload WHERE json_extract(excluded.payload,'$.barTime')>=json_extract(chart_signal_receipts.payload,'$.barTime')`,id,symbol,tf,receipt.at,JSON.stringify(receipt));
  // Expired cells cannot grow this diagnostic table forever; cleanup is amortized.
  if(counts++%500===0)db.run('DELETE FROM chart_signal_receipts WHERE at<?',Date.now()-7*86400000);
 }catch{/* diagnostics must not interrupt scanner decisions */}
}
let counts=0;
export function chartReceipt(db:Db,id:string,symbol:string,tf:string):SignalReceipt|null{
 initChartReceipts(db);const row=db.get<{payload:string}>('SELECT payload FROM chart_signal_receipts WHERE scanner_id=? AND symbol=? AND tf=?',id,symbol,tf);return row?JSON.parse(row.payload):null;
}

export type ChartReceiptArgs=Parameters<typeof recordChartReceipt> extends [Db,...infer Rest]?Rest:never;
