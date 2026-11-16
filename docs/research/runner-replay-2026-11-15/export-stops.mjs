import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/vnedge/data/vnedge.db', { readOnly: true });
const since=Date.now()-14*86400e3;
const r=db.prepare("select id,bt,tf,side,symbol,entry_price,entry_at,exit_at,exit_reason,coalesce(sl_original,sl) sl0 from positions where status!='open' and exit_reason='sl' and entry_at>? and exit_at<?").all(since,Date.now()-26*3600e3);
// deterministic sample of 450
const pick=r.filter((x,i)=>i%Math.max(1,Math.floor(r.length/450))===0).slice(0,450);
console.log(JSON.stringify({total:r.length,sample:pick}));
