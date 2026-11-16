// Stop-definition lab: re-stop every replayed trade under different stop/exit definitions at the same dollar risk.
// R is measured in each variant's own stop distance (size = risk$/distance), fee = recorded fee in bps / distance.
import fs from 'node:fs';
const T0=JSON.parse(fs.readFileSync('replay-trades.json','utf8')).trades, HORIZON=7*86400e3;
const TFMS={'15m':15*60e3,'1h':3600e3,'4h':4*3600e3}, TFMIN={'15m':15,'1h':60,'4h':240};
const m1={},tfb={};
for(const s of new Set(T0.map(t=>t.symbol))){const a=JSON.parse(fs.readFileSync(`m1/${s}.json`,'utf8'));m1[s]=a;tfb[s]={};
  for(const tf of Object.keys(TFMS)){const ms=TFMS[tf],bars=[];let cur=null;for(const b of a){const k=Math.floor(b[0]/ms)*ms;if(!cur||cur.t!==k){if(cur)bars.push(cur);cur={t:k,o:b[1],h:b[2],l:b[3],c:b[4],n:1};}else{if(b[2]>cur.h)cur.h=b[2];if(b[3]<cur.l)cur.l=b[3];cur.c=b[4];cur.n++;}}
    if(cur)bars.push(cur);tfb[s][tf]=bars.filter(x=>x.n>=TFMIN[tf]*0.9);}}
const lb=(a,t,key=0)=>{let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if((key?a[m].t:a[m][0])<t)l=m+1;else h=m;}return l;};
// per trade context: closed bars before fill, ATR14
const cases=[];
for(const t of T0){const bars=tfb[t.symbol][t.tf],ms=TFMS[t.tf];const i=lb(bars,t.fillAt-ms+1,1); // first bar whose start>=fill-ms+1 => bars[i-1].t+ms<=fill
  let e=i;while(e>0&&bars[e-1].t+ms>t.fillAt)e--; // bars[0..e-1] closed
  if(e<20)continue;let tr=0;for(let k=e-14;k<e;k++){const b=bars[k],p=bars[k-1];tr+=Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c));}
  const atr=tr/14;if(!(atr>0))continue;
  const a=m1[t.symbol],start=Math.floor(t.fillAt/60e3)*60e3+60e3,i0=lb(a,start),i1=lb(a,start+HORIZON);if(i1-i0<30)continue;
  const distBps0=Math.abs(t.entry-t.sl)/t.entry*1e4;
  cases.push({t,bars,e,atr,i0,i1,a,feeBps:t.feeR*distBps0,ms,sw:(n)=>{let hi=-Infinity,lo=Infinity;for(let k=e-n;k<e;k++){if(bars[k].h>hi)hi=bars[k].h;if(bars[k].l<lo)lo=bars[k].l;}return{hi,lo};}});}
// ---- stop definitions: return stop distance (price) for dir
const S={
 live:(c)=>Math.abs(c.t.entry-c.t.sl),
 atr:(k)=>(c)=>k*c.atr,
 swing:(n,buf=.25,lo=.75,hi=4)=>(c,dir)=>{const s=c.sw(n),e=c.t.entry;const d=(dir>0?e-s.lo:s.hi-e)+buf*c.atr;return Math.min(hi*c.atr,Math.max(lo*c.atr,d));},
 feefloor:(bps)=>(c)=>Math.max(Math.abs(c.t.entry-c.t.sl),c.t.entry*bps/1e4),
};
// ---- exits
const NOW=pk=>pk>=4?pk*.94:pk>=2?pk*.92:pk>=.5?Math.max(.25,pk*.9):-1;
function sim(c,dir,dist,ex){const t=c.t,e=t.entry,a=c.a,tfms=c.ms;let stop=-1,peak=0,tp=ex.tp??6,bars=[],cur=null,nb=0,entryT=a[c.i0][0],armed=false;
  const lockFn=ex.lock??NOW;let out=null;
  for(let i=c.i0;i<c.i1;i++){const b=a[i],hi=dir>0?(b[2]-e)/dist:(e-b[3])/dist,lo=dir>0?(b[3]-e)/dist:(e-b[2])/dist,cl=(dir>0?b[4]-e:e-b[4])/dist;
    if(lo<=stop){out=stop;break;}
    if(hi>=tp){out=tp;break;}
    if(hi>peak)peak=hi;
    let l=lockFn(peak,c.atr/dist);if(l>stop)stop=l;
    // timeframe bar bookkeeping
    const tt=b[0];if(!cur||cur.t!==Math.floor(tt/tfms)*tfms){cur={t:Math.floor(tt/tfms)*tfms,h:b[2],l:b[3]};}else{if(b[2]>cur.h)cur.h=b[2];if(b[3]<cur.l)cur.l=b[3];}
    if((tt+60e3)%tfms===0){nb++;bars.push(cur);cur=null;
      if(ex.time&&nb===ex.time.bars&&peak<ex.time.minPeak){out=cl;break;}
      if(ex.struct&&peak>=ex.struct.after){const n=ex.struct.n,seg=bars.slice(-n);if(seg.length===n){let sl;if(dir>0){sl=Math.min(...seg.map(x=>x.l));sl=(sl-ex.struct.buf*c.atr-e)/dist;}else{sl=Math.max(...seg.map(x=>x.h));sl=(e-sl-ex.struct.buf*c.atr)/dist;}if(sl>stop&&sl<peak)stop=sl;}}}
  }
  if(out===null){const b=a[c.i1-1];out=(dir>0?b[4]-e:e-b[4])/dist;}
  return out;}
const chand=(arm,k)=>(pk,atrR)=>pk>=arm?Math.max(pk-k*atrR,pk>=1?0:-1):-1;
const keep=(arm,k)=>pk=>pk>=arm?Math.max(pk*k,pk>=.5?.25*(arm<.5?0:1):0,-1):-1;
const EX={now:{}};
const rules=[];const add=(sn,sf,en)=>rules.push({name:`${sn} | ${en}`,sf,en});
add('live',S.live,'now');
for(const tp of [.3,.4,.5,.75,1,1.5,2,3]){EX['tp'+tp]={tp,lock:()=>-1};add('live',S.live,'tp'+tp);}
for(const arm of [.2,.3,.5,.75])for(const k of [.8,.9,.95]){EX[`a${arm}k${k}`]={lock:keep(arm,k),tp:6};add('live',S.live,`a${arm}k${k}`);}
for(const arm of [.3,.5])for(const k of [.9]){EX[`be${arm}`]={lock:pk=>pk>=arm?Math.max(pk*k,0):-1,tp:6};add('live',S.live,`be${arm}`);}
const f=(x,d=3)=>(+x).toFixed(d),avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
const sorted=[...cases].sort((a,b)=>a.t.fillAt-b.t.fillAt),mid=sorted[sorted.length>>1].t.fillAt;
console.log('cases',cases.length,'of',T0.length);
const res=[];
for(const r of rules){const real=[],mir=[],dist=[];for(const c of cases){const dir=c.t.side==='long'?1:-1;
  const d=r.sf(c,dir);const dm=r.sf(c,-dir);
  real.push(sim(c,dir,d,EX[r.en])-c.feeBps/(d/c.t.entry*1e4));
  mir.push(sim(c,-dir,dm,EX[r.en])-c.feeBps/(dm/c.t.entry*1e4));dist.push(d/c.t.entry*1e4);}
  res.push({...r,real,mir,dist});}
fs.writeFileSync('stoplab-res2.json',JSON.stringify({meta:cases.map(c=>({tf:c.t.tf,side:c.t.side,at:c.t.fillAt,sym:c.t.symbol,sc:c.t.scanner_id,rec:c.t.R,bt:c.t.bt,reason:c.t.reason,id:c.t.id})),rules:res.map(r=>({name:r.name,real:r.real.map(x=>+x.toFixed(4)),mir:r.mir.map(x=>+x.toFixed(4))}))}));
const base=res[0].real;
const g=(arr,sel)=>{const x=[];cases.forEach((c,i)=>{if(sel(c))x.push(arr[i]);});return x.length?avg(x):NaN;};
console.log('\n'+'rule'.padEnd(26),'real'.padStart(7),'mirror'.padStart(7),'skill'.padStart(7),'neutral'.padStart(8),'long'.padStart(7),'short'.padStart(7),'15m'.padStart(7),'1h'.padStart(7),'4h'.padStart(7),'h1'.padStart(7),'h2'.padStart(7),'distbps'.padStart(8),'t vs live');
for(const r of res){const d=r.real.map((x,i)=>x-base[i]),m=avg(d),sd=Math.sqrt(avg(d.map(x=>(x-m)**2)));const t=sd>0?m/(sd/Math.sqrt(d.length)):0;
 const L=g(r.real,c=>c.t.side==='long'),Sh=g(r.real,c=>c.t.side==='short'),A=avg(r.real),M=avg(r.mir);
 console.log(r.name.padEnd(26),f(A).padStart(7),f(M).padStart(7),f((A-M)/2).padStart(7),f((L+Sh)/2).padStart(8),f(L).padStart(7),f(Sh).padStart(7),f(g(r.real,c=>c.t.tf==='15m')).padStart(7),f(g(r.real,c=>c.t.tf==='1h')).padStart(7),f(g(r.real,c=>c.t.tf==='4h')).padStart(7),f(g(r.real,c=>c.t.fillAt<mid)).padStart(7),f(g(r.real,c=>c.t.fillAt>=mid)).padStart(7),f(avg(r.dist),0).padStart(8),f(t,1));}
