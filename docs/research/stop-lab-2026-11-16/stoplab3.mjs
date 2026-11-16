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

const NOW=pk=>pk>=4?pk*.94:pk>=2?pk*.92:pk>=.5?Math.max(.25,pk*.9):-1;
const CLOSE_BPS=5.9, SLIP=2;
// returns [R before fees, holdMinutes, viaWindowMarketExit]
function sim(c,dir,dist,ex){const t=c.t,e=t.entry,a=c.a,fillAt=t.fillAt;let stop=-1,peak=0,out=null,hold=0,win=false,done=false;
  const W=ex.win?((t.symbol==='BTCUSD'||t.symbol==='ETHUSD')?ex.win.btc:ex.win.min):0;
  for(let i=c.i0;i<c.i1;i++){const b=a[i],hi=dir>0?(b[2]-e)/dist:(e-b[3])/dist,lo=dir>0?(b[3]-e)/dist:(e-b[2])/dist,cl=(dir>0?b[4]-e:e-b[4])/dist,end=(b[0]+60e3-fillAt)/60e3;
    if(lo<=stop){out=stop;hold=end;break;}
    if(hi>=6){out=6;hold=end;break;}
    if(hi>peak)peak=hi;
    const l=NOW(peak);if(l>stop)stop=l;
    if(W&&!done&&end>=W-ex.win.margin&&end<W){ // decision minute inside the window
      const slipR=SLIP/(dist/e*1e4);
      if(cl>=ex.win.minR&&peak>=ex.win.minPeak){out=cl-slipR;hold=end;win=true;break;}
      if(ex.win.all){out=cl-slipR;hold=end;win=true;break;}
    }
    if(W&&end>=W)done=true;
  }
  if(out===null){const b=a[c.i1-1];out=(dir>0?b[4]-e:e-b[4])/dist;hold=(c.i1-c.i0);}
  return [out,hold];}
const F=(m)=>({win:{min:15,btc:30,margin:m}});
const EX={now:{},
 w0:{win:{min:15,btc:30,margin:1,minR:9,minPeak:9}}, // window known, never acts: natural waived exits only
};
for(const [nm,minR,minPeak] of [['w_p0',0,0],['w_p10',.1,0],['w_p25',.25,0],['w_pk3_p0',0,.3],['w_pk3_p10',.1,.3],['w_pk5_p0',0,.5],['w_pk5_p10',.1,.5]])EX[nm]={win:{min:15,btc:30,margin:1,minR,minPeak}};
EX['w_all']={win:{min:15,btc:30,margin:1,minR:-9,minPeak:-9,all:true}};
const rules=[{name:'no offer (full fees)',en:'now',offer:false},...Object.keys(EX).filter(k=>k!=='now').map(k=>({name:k,en:k,offer:true}))];
const sorted=[...cases].sort((a,b)=>a.t.fillAt-b.t.fillAt),mid=sorted[sorted.length>>1].t.fillAt;
const res=[];
for(const r of rules){const real=[],win=[];for(const c of cases){const dir=c.t.side==='long'?1:-1,dist=Math.abs(c.t.entry-c.t.sl),dbps=dist/c.t.entry*1e4;
  const [x,hold]=sim(c,dir,dist,EX[r.en]);const close=Math.min(CLOSE_BPS,c.feeBps*.6),open=c.feeBps-close;
  const lim=(c.t.symbol==='BTCUSD'||c.t.symbol==='ETHUSD')?30:15;const waived=r.offer&&hold<=lim;
  real.push(x-(open+(waived?0:close))/dbps);win.push(waived?1:0);}
  res.push({...r,real,win});}
fs.writeFileSync('stoplab-res3.json',JSON.stringify({meta:cases.map(c=>({tf:c.t.tf,side:c.t.side,at:c.t.fillAt,sym:c.t.symbol})),rules:res.map(r=>({name:r.name,real:r.real.map(x=>+x.toFixed(4)),win:r.win}))}));
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length,f=(x,d=3)=>(+x).toFixed(d);
console.log('cases',cases.length);
