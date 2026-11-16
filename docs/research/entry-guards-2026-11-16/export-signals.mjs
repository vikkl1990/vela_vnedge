// Read-only, explicit window. Never substitute today's policy for a historical refusal.
import { DatabaseSync } from 'node:sqlite';
const from=Date.parse(process.env.FROM??''),asOf=Date.parse(process.env.AS_OF??'');
if(!Number.isFinite(from)||!Number.isFinite(asOf)||asOf<=from)throw Error('FROM and AS_OF must be explicit ISO timestamps');
const db=new DatabaseSync(process.env.DB??'/opt/vnedge/data/vnedge.db',{readOnly:true});
db.exec('BEGIN');
try {
 const signals=db.prepare(`select id,at,bar_time,scanner_id,symbol,tf,side,price,action from signals
 where kind='entry' and at>=? and at<=? and side is not null and
 (action like 'rejected:risk burst%' or action like 'rejected:risk re-entry cooldown%' or action like 'rejected:re-entry cooldown%' or action like 'rejected:risk regime%' or action='opened') order by at,id`).all(from,asOf);
 const gated=db.prepare('select snapshot,policy_id from gated_signals where signal_id=? and book=0 and at<=? order by id desc limit 1');
 const policy=db.prepare('select snapshot from trade_policies where id=?');
 const rows=signals.map(r=>{const g=gated.get(r.id,asOf);const p=g?.policy_id?policy.get(g.policy_id):null;
  return {id:r.id,at:r.at,bar:r.bar_time,sc:r.scanner_id,sym:r.symbol,tf:r.tf,side:r.side,price:r.price,action:r.action,
   snapshot:g?JSON.parse(g.snapshot):null,policy:p?JSON.parse(p.snapshot):null};});
 console.log(JSON.stringify({version:2,from,asOf,rows}));
}finally {db.exec('ROLLBACK');db.close();}
