// The last 72 hours: every pump or dump on the liquid markets (5-minute move of 4+ sd and 1.5%+), what price did next,
// and whether the account or the shadow book held a position in that market while it happened.
import fs from 'node:fs';
const R=await (await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures')).json();
const top=R.result.filter(t=>t.contract_type==='perpetual_futures'&&Number(t.turnover_usd)>2e5).sort((a,b)=>b.turnover_usd-a.turnover_usd).slice(0,90).map(t=>t.symbol);
const end=Math.floor(Date.now()/1000),start=end-80*3600;
fs.mkdirSync('m1r',{recursive:true});
async function get(s){const f=`m1r/${s}.json`;if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,'utf8'));
  const rows=[];for(let t=start;t<end;t+=3800*60){for(let k=0;k<4;k++){try{const r=await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=1m&symbol=${s}&start=${t}&end=${Math.min(t+3800*60-60,end)}`);if(r.status===200){rows.push(...((await r.json()).result??[]));break;}}catch{}await new Promise(r=>setTimeout(r,700));}}
  const m=new Map();for(const c of rows)m.set(c.time,[c.time*1000,+c.open,+c.high,+c.low,+c.close,+c.volume]);const a=[...m.values()].sort((x,y)=>x[0]-y[0]);fs.writeFileSync(f,JSON.stringify(a));return a;}
const q=[...top],data={};await Promise.all(Array.from({length:5},async()=>{for(;;){const s=q.shift();if(!s)return;data[s]=await get(s);}}));
const out=[];
for(const s of top){const a=data[s];if(!a||a.length<1500)continue;const n=a.length,r=new Float64Array(n);
  for(let i=1;i<n;i++)r[i]=a[i][0]-a[i-1][0]===60e3?Math.log(a[i][4]/a[i-1][4]):0;
  let sum=0,sq=0;const W=1440,sd=new Float64Array(n);for(let i=1;i<n;i++){sum+=r[i];sq+=r[i]*r[i];if(i>W){sum-=r[i-W];sq-=r[i-W]*r[i-W];}const m=sum/Math.min(i,W);sd[i]=Math.sqrt(Math.max(0,sq/Math.min(i,W)-m*m));}
  let lastAt=-1e18;
  for(let i=1445;i<n-1;i++){if(a[i][0]-a[i-5][0]!==300e3)continue;const x=Math.log(a[i][4]/a[i-5][4]),z=x/(sd[i-5]*Math.sqrt(5)||1e9);if(Math.abs(x)<.015||Math.abs(z)<4)continue;if(a[i][0]-lastAt<45*60e3)continue;lastAt=a[i][0];
    const d=x>0?1:-1;let ext=a[i][4],extI=i;for(let k=i;k<Math.min(n,i+15);k++){if(d>0?a[k][2]>ext:a[k][3]<ext){ext=d>0?a[k][2]:a[k][3];extI=k;}}
    const from=a[i-5][4],run=Math.abs(ext/from-1);let back=0,backI=extI;for(let k=extI;k<Math.min(n,extI+60);k++){const bk=(d>0?ext-a[k][3]:a[k][2]-ext)/ext;if(bk>back){back=bk;backI=k;}}
    out.push({s,at:a[i][0],d,move:Math.abs(x),run,back,retrace:back/run,minsToTop:extI-i,minsBack:backI-extI,vol:a[i-4][5]?a.slice(i-4,i+1).reduce((u,b)=>u+b[5],0)/Math.max(1,a.slice(i-1445,i-5).reduce((u,b)=>u+b[5],0)/1440*5):null});}}
out.sort((a,b)=>b.run-a.run);
fs.writeFileSync('recent-spikes.json',JSON.stringify(out));
console.log('liquid markets',top.length,'| spikes',out.length,'| pumps',out.filter(e=>e.d>0).length,'dumps',out.filter(e=>e.d<0).length);
const rev=out.filter(e=>e.retrace>=.5);console.log('spikes that gave back at least half within an hour of the extreme:',rev.length,'of',out.length,`(${(rev.length/out.length*100).toFixed(0)}%)`);
console.log('\ntop 14 by size: market, UTC time, direction, 5m move, run to extreme, give-back (share of run), minutes to extreme');
for(const e of out.slice(0,14))console.log(e.s.padEnd(12),new Date(e.at).toISOString().slice(5,16),e.d>0?'PUMP':'DUMP',(e.move*100).toFixed(1).padStart(5)+'%',(e.run*100).toFixed(1).padStart(5)+'%',(e.retrace*100).toFixed(0).padStart(4)+'%',e.minsToTop);
