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
function sim(e,{minSize,retrace,stopX,hold,confirm}){const {a,i,d}=e;if(e.x<minSize)return null;
  const from=a[i-5][4],top=d>0?Math.max(...a.slice(i-5,i+1).map(b=>b[2])):Math.min(...a.slice(i-5,i+1).map(b=>b[3]));
  let k=i+1;if(confirm){ // wait for the first 1m candle that closes against the spike, up to 5 minutes
    let ok=false;for(let j=i+1;j<=i+5;j++){const b=a[j];if(d>0?b[4]<b[1]:b[4]>b[1]){k=j+1;ok=true;break;}}if(!ok)return null;}
  const entry=a[k][1],side=-d; // fade
  const move=Math.abs(a[i][4]-from);if(!(move>0))return null;
  const stop=d>0?top+stopX*move:top-stopX*move,tgt=entry+side*retrace*move; // target = retrace of the impulse from the entry
  const risk=Math.abs(entry-stop);if(!(risk>0)||(side>0?stop>=entry:stop<=entry))return null;
  let exit=null,why='time';
  for(let j=k;j<Math.min(a.length,k+hold);j++){const b=a[j],hi=b[2],lo=b[3];
    if(side>0?lo<=stop:hi>=stop){exit=stop-side*entry*SLIP/1e4;why='stop';break;}
    if(side>0?hi>=tgt:lo<=tgt){exit=tgt;why='target';break;}}
  if(exit===null)exit=a[Math.min(a.length-1,k+hold-1)][4];
  const gross=(exit-entry)*side/entry*1e4,net=gross-FEE,R=net/(risk/entry*1e4);
  return {net,R,why,riskBps:risk/entry*1e4,e};}
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN,f=(x,d=1)=>(+x).toFixed(d);
function boot(rs,B=2000){const days=new Map();for(const r of rs){const k=Math.floor(r.e.at/864e5);(days.get(k)??days.set(k,[]).get(k)).push(r.net);}const keys=[...days.keys()];let seed=9;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;const o=[];for(let b=0;b<B;b++){const p=[];for(let q=0;q<keys.length;q++)p.push(...days.get(keys[Math.floor(rnd()*keys.length)]));o.push(avg(p));}o.sort((x,y)=>x-y);return [o[Math.floor(B*.025)],o[Math.floor(B*.975)]];}
const mid=[...ev.map(e=>e.at)].sort((a,b)=>a-b)[ev.length>>1];
console.log('\nminSize retrace stopX hold confirm |   n   net bps  95% CI(day)      R   win% stop% | pumps->short  dumps->long | half1  half2');
const grid=[];
for(const minSize of [.02,.03,.04])for(const retrace of [.3,.5])for(const stopX of [.25,.5])for(const hold of [15,30,60])for(const confirm of [false,true])grid.push({minSize,retrace,stopX,hold,confirm});
const rows=[];
for(const g of grid){const rs=ev.map(e=>sim(e,g)).filter(Boolean);if(rs.length<60)continue;rows.push({g,rs});}
rows.sort((a,b)=>avg(b.rs.map(r=>r.net))-avg(a.rs.map(r=>r.net)));
for(const {g,rs} of rows.slice(0,14)){const ci=boot(rs),up=rs.filter(r=>r.e.d>0),dn=rs.filter(r=>r.e.d<0),h1=rs.filter(r=>r.e.at<mid),h2=rs.filter(r=>r.e.at>=mid);
  console.log(`${(g.minSize*100).toFixed(0)}%`.padStart(6),String(g.retrace).padStart(6),String(g.stopX).padStart(6),String(g.hold).padStart(4),String(g.confirm).padStart(7),'|',String(rs.length).padStart(4),f(avg(rs.map(r=>r.net))).padStart(8),` ${f(ci[0])}..${f(ci[1])}`.padEnd(15),f(avg(rs.map(r=>r.R)),2).padStart(6),f(rs.filter(r=>r.net>0).length/rs.length*100,0).padStart(5),f(rs.filter(r=>r.why==='stop').length/rs.length*100,0).padStart(5),'|',f(avg(up.map(r=>r.net))).padStart(8),f(avg(dn.map(r=>r.net))).padStart(11),'|',f(avg(h1.map(r=>r.net))).padStart(6),f(avg(h2.map(r=>r.net))).padStart(6));}
console.log('\nworst of the grid (to see the spread):');for(const {g,rs} of rows.slice(-3))console.log(JSON.stringify(g),f(avg(rs.map(r=>r.net))),'n',rs.length);
console.log('positive configurations:',rows.filter(r=>avg(r.rs.map(x=>x.net))>0).length,'of',rows.length);
