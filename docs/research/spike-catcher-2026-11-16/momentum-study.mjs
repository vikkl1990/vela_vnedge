// Fade the spike: after a pump go short, after a dump go long. Entry next minute's open (optionally after a 1m confirmation),
// stop beyond the spike's extreme, target a retrace of the 5-minute impulse, time exit. Fee 9.4 bps a round trip, stop checked
// before target inside a minute (conservative), 2 bps slippage on stop fills. Reported in bps and in R of the stop distance.
import fs from 'node:fs';
const K=+(process.env.K||5),MINPCT=+(process.env.MINPCT||1.2)/100;
const syms=fs.readdirSync('m1').map(f=>f.replace('.json',''));
const FEE=9.4,SLIP=2,ev=[];
for(const s of syms){const a=JSON.parse(fs.readFileSync(`m1/${s}.json`,'utf8')),n=a.length,r=new Float64Array(n);
  for(let i=1;i<n;i++)r[i]=a[i][0]-a[i-1][0]===60e3?Math.log(a[i][4]/a[i-1][4]):0;
  let sum=0,sq=0;const W=1440,sd=new Float64Array(n);
  for(let i=1;i<n;i++){sum+=r[i];sq+=r[i]*r[i];if(i>W){sum-=r[i-W];sq-=r[i-W]*r[i-W];}const m=sum/Math.min(i,W);sd[i]=Math.sqrt(Math.max(0,sq/Math.min(i,W)-m*m));}
  const last={up:-1e18,dn:-1e18};
  for(let i=1445;i<n-125;i++){if(a[i][0]-a[i-5][0]!==300e3)continue;const x=Math.log(a[i][4]/a[i-5][4]),z=x/(sd[i-5]*Math.sqrt(5)||1e9);
    if(Math.abs(x)<MINPCT||Math.abs(z)<K)continue;const dir=x>0?'up':'dn';if(a[i][0]-last[dir]<30*60e3)continue;last[dir]=a[i][0];
    if(a[i+120][0]-a[i][0]!==7200e3)continue;
    ev.push({s,a,i,d:x>0?1:-1,x:Math.abs(x),at:a[i][0]});}}
console.log('events',ev.length);

// MOMENTUM: go with the spike. Entry next minute's open, stop a fraction of the 5-minute impulse beyond the entry, a trail that
// arms at +0.5R and gives back a share of the peak, max hold. Fee 9.4 bps, 2 bps slippage on stop fills.
const ENTRY_SLIP=+(process.env.ENTRY_SLIP||10),STOP_SLIP=+(process.env.STOP_SLIP||15);
function sim(e,{minSize,stopFrac,give,hold}){const {a,i,d}=e;if(e.x<minSize)return null;
  const from=a[i-5][4],move=Math.abs(a[i][4]-from);if(!(move>0))return null;const side=d;
  const entry=a[i+1][1]*(1+side*ENTRY_SLIP/1e4); // market order into a moving book: worse than the open
  const risk=stopFrac*move;let stop=entry-side*risk,peak=0,exit=null,why='time';
  for(let j=i+1;j<Math.min(a.length,i+1+hold);j++){const b=a[j],hi=side>0?b[2]:b[3],lo=side>0?b[3]:b[2];
    if(side>0?lo<=stop:hi>=stop){ // a stop is a market order: if the minute opened through it, it fills at the open, and it always pays slippage
      const px=side>0?Math.min(stop,b[1]):Math.max(stop,b[1]);exit=px*(1-side*STOP_SLIP/1e4);why='stop';break;}
    const fav=(hi-entry)*side/risk;if(fav>peak){peak=fav;if(peak>=.5){const ns=entry+side*peak*risk*(1-give);if(side>0?ns>stop:ns<stop)stop=ns;}}}
  if(exit===null)exit=a[Math.min(a.length-1,i+hold)][4]*(1-side*ENTRY_SLIP/1e4);
  const gross=(exit-entry)*side/entry*1e4,net=gross-FEE;return {net,R:net/(risk/entry*1e4),why,e,riskBps:risk/entry*1e4};}
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN,f=(x,d=1)=>(+x).toFixed(d);
function boot(rs,B=2000){const days=new Map();for(const r of rs){const k=Math.floor(r.e.at/864e5);(days.get(k)??days.set(k,[]).get(k)).push(r.net);}const keys=[...days.keys()];let seed=9;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;const o=[];for(let b=0;b<B;b++){const p=[];for(let q=0;q<keys.length;q++)p.push(...days.get(keys[Math.floor(rnd()*keys.length)]));o.push(avg(p));}o.sort((x,y)=>x-y);return [o[Math.floor(B*.025)],o[Math.floor(B*.975)]];}
const mid=[...ev.map(e=>e.at)].sort((a,b)=>a-b)[ev.length>>1];
const rows=[];
for(const minSize of [.015,.02,.03,.04])for(const stopFrac of [.3,.5,1])for(const give of [.3,.5])for(const hold of [30,60,120]){const rs=ev.map(e=>sim(e,{minSize,stopFrac,give,hold})).filter(Boolean);if(rs.length>=60)rows.push({g:{minSize,stopFrac,give,hold},rs});}
rows.sort((a,b)=>avg(b.rs.map(r=>r.net))-avg(a.rs.map(r=>r.net)));
console.log('MOMENTUM catcher (with the spike)\nminSize stopFrac give hold |   n  net bps   95% CI(day)     R  win% stop% | pumps->long dumps->short | half1 half2');
for(const {g,rs} of rows.slice(0,10)){const ci=boot(rs),up=rs.filter(r=>r.e.d>0),dn=rs.filter(r=>r.e.d<0),h1=rs.filter(r=>r.e.at<mid),h2=rs.filter(r=>r.e.at>=mid);
 console.log(`${(g.minSize*100).toFixed(1)}%`.padStart(6),String(g.stopFrac).padStart(8),String(g.give).padStart(5),String(g.hold).padStart(4),'|',String(rs.length).padStart(5),f(avg(rs.map(r=>r.net))).padStart(8),` ${f(ci[0])}..${f(ci[1])}`.padEnd(15),f(avg(rs.map(r=>r.R)),2).padStart(5),f(rs.filter(r=>r.net>0).length/rs.length*100,0).padStart(5),f(rs.filter(r=>r.why==='stop').length/rs.length*100,0).padStart(5),'|',f(avg(up.map(r=>r.net))).padStart(8),f(avg(dn.map(r=>r.net))).padStart(11),'|',f(avg(h1.map(r=>r.net))).padStart(5),f(avg(h2.map(r=>r.net))).padStart(5));}
console.log('positive configurations:',rows.filter(r=>avg(r.rs.map(x=>x.net))>0).length,'of',rows.length,'| mean of all configurations',f(avg(rows.map(r=>avg(r.rs.map(x=>x.net))))));
