import fs from 'node:fs';
const D=JSON.parse(fs.readFileSync('stoplab-res3.json','utf8')),M=D.meta,R=D.rules;
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length,f=(x,d=3)=>(+x).toFixed(d);
const mid=[...M.map(m=>m.at)].sort((a,b)=>a-b)[M.length>>1];
function neutral(idx,arr){const L=idx.filter(i=>M[i].side==='long'),S=idx.filter(i=>M[i].side==='short');const m=a=>a.reduce((s,i)=>s+arr[i],0)/a.length;return (m(L)+m(S))/2;}
function tday(idx,arr,base){const L=idx.filter(i=>M[i].side==='long'),S=idx.filter(i=>M[i].side==='short'),w=new Map();for(const i of L)w.set(i,.5/L.length);for(const i of S)w.set(i,.5/S.length);const d=new Map();for(const i of idx){const k=Math.floor(M[i].at/864e5);d.set(k,(d.get(k)||0)+w.get(i)*(arr[i]-base[i]));}const v=[...d.values()],n=v.length,tot=v.reduce((a,b)=>a+b,0),sd=Math.sqrt(v.reduce((a,x)=>a+(x-tot/n)**2,0)/(n-1));return sd>0?tot/(sd*Math.sqrt(n)):0;}
const base=R.find(r=>r.name==='w0').real;
for(const tf of ['15m','1h','all']){const idx=M.map((m,i)=>i).filter(i=>tf==='all'||M[i].tf===tf);const h1=idx.filter(i=>M[i].at<mid),h2=idx.filter(i=>M[i].at>=mid);
 console.log(`\n=== ${tf} n=${idx.length}`);console.log('rule'.padEnd(22),'real'.padStart(7),'neutral'.padStart(8),'vs w0'.padStart(7),'t(day)'.padStart(7),'h1 neu'.padStart(8),'h2 neu'.padStart(8),'waived%'.padStart(8));
 for(const r of R)console.log(r.name.padEnd(22),f(avg(idx.map(i=>r.real[i]))).padStart(7),f(neutral(idx,r.real)).padStart(8),f(neutral(idx,r.real)-neutral(idx,base)).padStart(7),f(tday(idx,r.real,base),1).padStart(7),f(neutral(h1,r.real)).padStart(8),f(neutral(h2,r.real)).padStart(8),(avg(idx.map(i=>r.win[i]))*100).toFixed(0).padStart(7)+'%');}
