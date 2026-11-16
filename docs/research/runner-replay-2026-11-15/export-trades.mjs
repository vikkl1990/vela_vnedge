import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/vnedge/data/vnedge.db', { readOnly: true });
const now=Date.now();
const r=db.prepare("select id,bt,tf,side,symbol,scanner_id,entry_price entry,entry_at fillAt,coalesce(sl_original,sl) sl,exit_reason reason,(realized_pnl-fees)/risk_amount R,fees/risk_amount feeR from positions where status!='open' and exit_at is not null and entry_at>? and entry_at<? and risk_amount>0 and bt in (0,2)").all(now-33*86400e3,now-8*86400e3);
const out=[]; for(const tf of ['15m','1h','4h']){ const t=r.filter(x=>x.tf===tf); const k=Math.max(1,Math.floor(t.length/(tf==='4h'?1500:tf==='1h'?1400:1700))); out.push(...t.filter((x,i)=>i%k===0)); }
console.log(JSON.stringify({universe:r.length,trades:out}));
