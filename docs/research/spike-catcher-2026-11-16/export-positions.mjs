import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/opt/vnedge/data/vnedge.db',{readOnly:true});
const now=Date.now();
const r=db.prepare("select bt,symbol,tf,side,scanner_id sc,entry_at,exit_at,(realized_pnl-fees)/risk_amount R,realized_pnl-fees net,status from positions where bt in (0,2) and risk_amount>0 and (exit_at is null or exit_at>?) and entry_at<? and scanner_id not like 'plan:%'").all(now-82*3600e3,now);
console.log(JSON.stringify(r.map(x=>({bt:x.bt,s:x.symbol,tf:x.tf,d:x.side==='long'?1:-1,sc:x.sc,a:x.entry_at,b:x.exit_at??now,R:x.status==='closed'?x.R:null,net:x.status==='closed'?x.net:null}))));
