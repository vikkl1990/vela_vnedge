// Pump and dump study from 1-minute candles. An event is a 5-minute move of at least K standard deviations of that market's own
// 1-minute returns over the previous day AND at least MINPCT, debounced 30 minutes per market and direction.
// For each event: the forward path in the direction of the impulse (continuation) and against it (fade), after fees.
import fs from 'node:fs';
const K=+(process.env.K||5),MINPCT=+(process.env.MINPCT||1.2)/100,FEE=9.4/1e4,HZ=[1,3,5,10,15,30,60];
const syms=fs.readdirSync('m1').map(f=>f.replace('.json',''));
const ev=[];let bars=0;
for(const s of syms){const a=JSON.parse(fs.readFileSync(`m1/${s}.json`,'utf8'));bars+=a.length;
  // sd of 1m returns over the previous 1440 minutes (rolling, O(n))
  const n=a.length,r=new Float64Array(n);for(let i=1;i<n;i++)r[i]=a[i][0]-a[i-1][0]===60e3?Math.log(a[i][4]/a[i-1][4]):0;
  let sum=0,sq=0;const W=1440,sd=new Float64Array(n);
  for(let i=1;i<n;i++){sum+=r[i];sq+=r[i]*r[i];if(i>W){sum-=r[i-W];sq-=r[i-W]*r[i-W];}const m=sum/Math.min(i,W);sd[i]=Math.sqrt(Math.max(0,sq/Math.min(i,W)-m*m));}
  const last={up:-1e18,dn:-1e18};
  for(let i=1445;i<n-61;i++){if(a[i][0]-a[i-5][0]!==300e3)continue;const x=Math.log(a[i][4]/a[i-5][4]),z=x/(sd[i-5]*Math.sqrt(5)||1e9);
    if(Math.abs(x)<MINPCT||Math.abs(z)<K)continue;const dir=x>0?'up':'dn';if(a[i][0]-last[dir]<30*60e3)continue;last[dir]=a[i][0];
    if(a[i+60][0]-a[i][0]!==3600e3)continue; // a gap in the data inside the next hour
    const e=a[i+1][1],d=x>0?1:-1,fw=HZ.map(h=>((a[i+h][4]/e)-1)*d);
    let mfe=0,mae=0;for(let k=i+1;k<=i+30;k++){mfe=Math.max(mfe,((d>0?a[k][2]:a[k][3])/e-1)*d);mae=Math.min(mae,((d>0?a[k][3]:a[k][2])/e-1)*d);}
    ev.push({s,at:a[i][0],d,x:Math.abs(x),z:Math.abs(z),fw,mfe,mae,e});}}
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length,f=(x,d=2)=>(+x).toFixed(d);
const days=(Math.max(...ev.map(e=>e.at))-Math.min(...ev.map(e=>e.at)))/864e5;
console.log(`bars ${bars} | events ${ev.length} (pumps ${ev.filter(e=>e.d>0).length}, dumps ${ev.filter(e=>e.d<0).length}) | markets with events ${new Set(ev.map(e=>e.s)).size} | median size ${f(ev.map(e=>e.x).sort((a,b)=>a-b)[ev.length>>1]*100)}% | events a day ${f(ev.length/ (days||1),1)}`);
for(const [name,sel] of [['ALL',()=>true],['pumps (continue up / fade short)',e=>e.d>0],['dumps (continue down / fade long)',e=>e.d<0],['big (>=3%)',e=>e.x>=.03],['small (<2%)',e=>e.x<.02]]){const x=ev.filter(sel);if(x.length<10)continue;
  console.log(`\n${name}  n=${x.length}`);
  console.log('  horizon min        '+HZ.map(h=>String(h).padStart(7)).join(''));
  console.log('  continue, bps net  '+HZ.map((h,i)=>f(avg(x.map(e=>e.fw[i]))*1e4-FEE*1e4,1).padStart(7)).join(''));
  console.log('  fade, bps net      '+HZ.map((h,i)=>f(-avg(x.map(e=>e.fw[i]))*1e4-FEE*1e4,1).padStart(7)).join(''));
  console.log('  share continuing   '+HZ.map((h,i)=>f(x.filter(e=>e.fw[i]>0).length/x.length*100,0).padStart(7)).join(''));}
fs.writeFileSync('burst-events.json',JSON.stringify(ev));
