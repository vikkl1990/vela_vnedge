import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/opt/vnedge/data/vnedge.db',{readOnly:true});
const r=db.prepare("select id,bt,tf,side,symbol,scanner_id,entry_price entry,entry_at fillAt,coalesce(sl_original,sl) sl,exit_reason reason,(realized_pnl-fees)/risk_amount R,fees/risk_amount feeR from positions where status!='open' and exit_at is not null and risk_amount>0 and bt=2 and scanner_id='trend-impulse-channels-zeiierman'").all();
console.log(JSON.stringify(r));
