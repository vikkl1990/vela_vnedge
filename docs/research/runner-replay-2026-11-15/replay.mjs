import fs from 'node:fs';
const T=JSON.parse(fs.readFileSync('replay-trades.json','utf8')).trades, H=+(process.env.HOURS||168)*3600e3;
const m1={};for(const s of new Set(T.map(t=>t.symbol)))m1[s]=JSON.parse(fs.readFileSync(`m1/${s}.json`,'utf8'));
const lb=(a,t)=>{let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m][0]<t)l=m+1;else h=m;}return l;};
const cases=[];
for(const t of T){const dir=t.side==='long'?1:-1,risk=Math.abs(t.entry-t.sl);if(!(risk>0))continue;
  const a=m1[t.symbol],start=Math.floor(t.fillAt/60e3)*60e3+60e3,i0=lb(a,start),i1=lb(a,start+H);
  if(i1-i0<30)continue;const r=x=>(x-t.entry)*dir/risk,n=i1-i0,path=new Float32Array(n*3);
  for(let i=i0,k=0;i<i1;i++,k+=3){const b=a[i];if(dir===1){path[k]=r(b[2]);path[k+1]=r(b[3]);}else{path[k]=r(b[3]);path[k+1]=r(b[2]);}path[k+2]=r(b[4]);}
  cases.push({t,path,full:n>=H/60e3-5});}
// engine: stop starts at `stop0`, lock(peak)-> new stop; stop checked before raising (conservative); cap at tp
function leg(path,{stop0=-1,lock,tp=20}){let stop=stop0,peak=0;for(let k=0;k<path.length;k+=3){const hi=path[k],lo=path[k+1];if(lo<=stop)return stop;if(hi>=tp)return tp;if(hi>peak)peak=hi;const l=lock(peak);if(l>stop)stop=l;}return path[path.length-1];}
const NOW=pk=>pk>=4?pk*.94:pk>=2?pk*.92:pk>=.5?Math.max(.25,pk*.9):-1;
const trail=(arm,keep)=>pk=>pk>=arm?pk*keep:-1;
const withBE=(be,arm,keep)=>pk=>pk>=arm?pk*keep:pk>=be?0:-1;
const L={now:p=>leg(p,{lock:NOW,tp:6})};
const rules=[
 ['NOW (arm .5R, keep 90/92/94%), TP 6R',p=>leg(p,{lock:NOW,tp:6})],
 ['NOW, no TP',p=>leg(p,{lock:NOW})],
 ['arm 1R keep 85%',p=>leg(p,{lock:trail(1,.85)})],
 ['arm 1R keep 75%',p=>leg(p,{lock:trail(1,.75)})],
 ['arm 2R keep 70%, stop -1R',p=>leg(p,{lock:trail(2,.7)})],
 ['arm 1R keep 60%',p=>leg(p,{lock:trail(1,.6)})],
 ['stop -1R only (hold 7d)',p=>leg(p,{lock:()=>-1})],
 ['70% NOW + 30% runner (arm 2R keep 70%)',p=>.7*leg(p,{lock:NOW,tp:6})+.3*leg(p,{lock:trail(2,.7)})],
 ['50% NOW + 50% runner (arm 2R keep 70%)',p=>.5*leg(p,{lock:NOW,tp:6})+.5*leg(p,{lock:trail(2,.7)})],
 ['70% NOW + 30% runner, BE at .5R',p=>.7*leg(p,{lock:NOW,tp:6})+.3*leg(p,{lock:withBE(.5,2,.7)})],
 ['50% NOW + 50% runner, BE at .5R',p=>.5*leg(p,{lock:NOW,tp:6})+.5*leg(p,{lock:withBE(.5,2,.7)})],
 ['70% NOW + 30% runner (arm 3R keep 60%), BE at .5R',p=>.7*leg(p,{lock:NOW,tp:6})+.3*leg(p,{lock:withBE(.5,3,.6)})],
 ['50% NOW + 50% runner (arm 1.5R keep 65%), BE at .5R',p=>.5*leg(p,{lock:NOW,tp:6})+.5*leg(p,{lock:withBE(.5,1.5,.65)})],
];
const f=(x,d=3)=>x.toFixed(d), sorted=cases.sort((a,b)=>a.t.fillAt-b.t.fillAt), mid=sorted[sorted.length>>1].t.fillAt;
console.log('trades replayed',cases.length,'| path covers the full 7d for',cases.filter(c=>c.full).length,'| recorded avg R',f(cases.reduce((a,c)=>a+c.t.R,0)/cases.length));
const pk=cases.map(c=>{let m=-9;for(let k=0;k<c.path.length;k+=3)if(c.path[k]>m)m=c.path[k];return m;});
console.log('peak within 7d (R): share >=1R',(pk.filter(x=>x>=1).length/pk.length*100).toFixed(0)+'%','>=2R',(pk.filter(x=>x>=2).length/pk.length*100).toFixed(0)+'%','>=4R',(pk.filter(x=>x>=4).length/pk.length*100).toFixed(0)+'%','>=8R',(pk.filter(x=>x>=8).length/pk.length*100).toFixed(1)+'%');
const rows=[];
for(const [name,run] of rules){const res=cases.map(c=>run(c.path)-c.t.feeR);
  const g=(sel)=>{const x=cases.map((c,i)=>[c,res[i]]).filter(([c])=>sel(c));return x.length?x.reduce((a,[,r])=>a+r,0)/x.length:NaN;};
  rows.push({name,avg:res.reduce((a,b)=>a+b,0)/res.length,win:res.filter(x=>x>0).length/res.length,h1:g(c=>c.t.fillAt<mid),h2:g(c=>c.t.fillAt>=mid),tf15:g(c=>c.t.tf==='15m'),tf1h:g(c=>c.t.tf==='1h'),tf4h:g(c=>c.t.tf==='4h'),bt0:g(c=>c.t.bt===0),bt2:g(c=>c.t.bt===2),long:g(c=>c.t.side==='long'),short:g(c=>c.t.side==='short'),res});}
console.log('\navg R a trade after fees (recorded per-trade fees), 7-day horizon');
console.log('rule'.padEnd(54),'avgR'.padStart(7),'win'.padStart(5),'1sthalf'.padStart(8),'2ndhalf'.padStart(8),'15m'.padStart(7),'1h'.padStart(7),'4h'.padStart(7),'long'.padStart(7),'short'.padStart(7));
for(const r of rows)console.log(r.name.padEnd(54),f(r.avg).padStart(7),(r.win*100).toFixed(0).padStart(4)+'%',f(r.h1).padStart(8),f(r.h2).padStart(8),f(r.tf15).padStart(7),f(r.tf1h).padStart(7),f(r.tf4h).padStart(7),f(r.long).padStart(7),f(r.short).padStart(7));
const base=rows[0].res;for(const r of rows.slice(1)){const d=r.res.map((x,i)=>x-base[i]),m=d.reduce((a,b)=>a+b,0)/d.length,sd=Math.sqrt(d.reduce((a,x)=>a+(x-m)**2,0)/d.length);r.t=m/(sd/Math.sqrt(d.length));}
console.log('\npaired difference vs NOW: mean R a trade (t)');for(const r of rows.slice(1))console.log(' ',r.name.padEnd(54),f(r.avg-rows[0].avg).padStart(7),'t',f(r.t,1));
// windows: 6 consecutive windows, avg R of runner50-BE minus NOW
const W=6,sz=Math.ceil(sorted.length/W);const rn=rows.find(r=>r.name.startsWith('50% NOW + 50% runner, BE'));
console.log('\n50%+50% runner (BE) minus NOW, by sixth of the period:',Array.from({length:W},(_,w)=>{let s=0,n=0;for(let i=w*sz;i<Math.min(sorted.length,(w+1)*sz);i++){s+=rn.res[i]-base[i];n++;}return f(s/n);}).join(' '));

// wider stop, same dollar risk: stop at -M R, trail arms at .5M, size 1/M, so R per unit risk = (leg - feeR)/M
const wide=M=>p=>leg(p,{stop0:-M,lock:pk=>{const q=pk/M;return q>=4?pk*.94:q>=2?pk*.92:q>=.5?Math.max(.25*M,pk*.9):-M;},tp:6*M});
const wideRows=[1.5,2,3].map(M=>({M,res:cases.map(c=>(wide(M)(c.path)-c.t.feeR)/M)}));
console.log('\nwider stop at the same dollar risk (size 1/M, trail arms at .5M): avg R per unit of risk');
for(const w of wideRows){const a=w.res.reduce((x,y)=>x+y,0)/w.res.length;const g=sel=>{const x=cases.map((c,i)=>[c,w.res[i]]).filter(([c])=>sel(c));return x.reduce((s,[,r])=>s+r,0)/x.length;};
 console.log('  stop',w.M+'R','avgR',f(a),'win',(w.res.filter(x=>x>0).length/w.res.length*100).toFixed(0)+'%','15m',f(g(c=>c.t.tf==='15m')),'1h',f(g(c=>c.t.tf==='1h')),'4h',f(g(c=>c.t.tf==='4h')),'1st/2nd half',f(g(c=>c.t.fillAt<mid)),f(g(c=>c.t.fillAt>=mid)));}
const rec=sel=>{const x=cases.filter(c=>sel(c));return x.reduce((a,c)=>a+c.t.R,0)/x.length;};
console.log('\ncalibration, recorded avg R vs replay NOW by timeframe:','15m',f(rec(c=>c.t.tf==='15m')),'vs',f(rows[0].tf15),'| 1h',f(rec(c=>c.t.tf==='1h')),'vs',f(rows[0].tf1h),'| 4h',f(rec(c=>c.t.tf==='4h')),'vs',f(rows[0].tf4h));
console.log('recorded by side: long',f(rec(c=>c.t.side==='long')),'short',f(rec(c=>c.t.side==='short')),'| replay NOW long',f(rows[0].long),'short',f(rows[0].short));
