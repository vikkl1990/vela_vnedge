import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/opt/vnedge/data/vnedge.db',{readOnly:true});
const now=Date.now(),q=(s,...p)=>db.prepare(s).all(...p);
const rows=q("select id,at,bar_time,scanner_id,symbol,tf,side,price,action from signals where kind='entry' and at>? and side is not null and (action like 'rejected:risk burst%' or action like 'rejected:risk re-entry cooldown%' or action like 'rejected:re-entry cooldown%' or action like 'rejected:risk regime%' or action='opened') order by at",now-14*86400e3);
const kind=a=>a==='opened'?'opened':a.includes('burst')?'burst':a.includes('re-entry cooldown')?'cooldown':a.includes('regime')?'regime':'other';
console.log(JSON.stringify(rows.map(r=>({id:r.id,at:r.at,bar:r.bar_time,sc:r.scanner_id,sym:r.symbol,tf:r.tf,side:r.side,price:r.price,k:kind(r.action)}))));
