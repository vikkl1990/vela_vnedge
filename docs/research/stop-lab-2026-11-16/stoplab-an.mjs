import fs from 'node:fs';
const D=JSON.parse(fs.readFileSync('stoplab-res.json','utf8')),M=D.meta,R=D.rules;
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length,f=(x,d=3)=>(+x).toFixed(d);
const day=i=>Math.floor(M[i].at/86400e3);
// drift-neutral weight: each trade weight so that long and short groups count equally within the subset
function stat(arr,idx,base){ // returns neutral mean, and day-clustered t of paired neutral diff vs base
  const L=idx.filter(i=>M[i].side==='long'),S=idx.filter(i=>M[i].side==='short');
  const w=new Map();for(const i of L)w.set(i,.5/L.length);for(const i of S)w.set(i,.5/S.length);
  let neu=0;for(const i of idx)neu+=w.get(i)*arr[i];
  let bn=0;for(const i of idx)bn+=w.get(i)*base[i];
  // cluster by day on weighted diffs
  const byDay=new Map();for(const i of idx){const d=day(i);byDay.set(d,(byDay.get(d)||0)+w.get(i)*(arr[i]-base[i]));}
  const v=[...byDay.values()],n=v.length,m=v.reduce((a,b)=>a+b,0)/n; // sum over days of weighted diffs = total diff; per-day contributions
  const tot=v.reduce((a,b)=>a+b,0),sd=Math.sqrt(v.reduce((a,x)=>a+(x-tot/n)**2,0)/(n-1));
  const t=sd>0?tot/(sd*Math.sqrt(n)):0; // t of total diff using day contributions
  return {neu,diff:neu-bn,t,nL:L.length,nS:S.length};
}
const base=R[0].real;
const mid=[...M.map(m=>m.at)].sort((a,b)=>a-b)[M.length>>1];
for(const tf of ['15m','1h','4h','all']){
  const idx=M.map((m,i)=>i).filter(i=>tf==='all'||M[i].tf===tf);
  const h1=idx.filter(i=>M[i].at<mid),h2=idx.filter(i=>M[i].at>=mid);
  console.log(`\n=== ${tf}  n=${idx.length} (long ${idx.filter(i=>M[i].side==='long').length}, short ${idx.filter(i=>M[i].side==='short').length})`);
  console.log('rule'.padEnd(24),'neutral'.padStart(8),'vs live'.padStart(8),'t(day)'.padStart(7),'h1 neu'.padStart(8),'h2 neu'.padStart(8),'long'.padStart(7),'short'.padStart(7),'real'.padStart(7));
  for(const r of R){const s=stat(r.real,idx,base),a=stat(r.real,h1,base),b=stat(r.real,h2,base);
    const L=avg(idx.filter(i=>M[i].side==='long').map(i=>r.real[i])),S=avg(idx.filter(i=>M[i].side==='short').map(i=>r.real[i]));
    console.log(r.name.padEnd(24),f(s.neu).padStart(8),f(s.diff).padStart(8),f(s.t,1).padStart(7),f(a.neu).padStart(8),f(b.neu).padStart(8),f(L).padStart(7),f(S).padStart(7),f(avg(idx.map(i=>r.real[i]))).padStart(7));}
}
