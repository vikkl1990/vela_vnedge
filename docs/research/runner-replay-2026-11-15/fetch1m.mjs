import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('replay-trades.json','utf8')).trades;
const H=7*86400e3, syms=[...new Set(d.map(t=>t.symbol))];
const span=s=>{const e=d.filter(t=>t.symbol===s);return [Math.min(...e.map(t=>t.fillAt))-60e3,Math.max(...e.map(t=>t.fillAt))+H];};
const CH=4000*60e3;
async function page(sym,a,b){for(let k=0;k<4;k++){try{const r=await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=1m&symbol=${sym}&start=${Math.floor(a/1000)}&end=${Math.floor(b/1000)}`,{headers:{'User-Agent':'research'}});if(r.status===429){await new Promise(r=>setTimeout(r,2000));continue;}const j=await r.json();return j.result||[];}catch{await new Promise(r=>setTimeout(r,800));}}return null;}
let done=0,fail=[];const q=[...syms];
await Promise.all(Array.from({length:5},async()=>{for(;;){const s=q.shift();if(!s)return;
  const f=`m1/${s}.json`; if(fs.existsSync(f)){done++;continue;}
  const [a,b]=span(s),rows=[];let ok=true;
  for(let t=a;t<Math.min(b,Date.now());t+=CH){const p=await page(s,t,Math.min(t+CH-60e3,b,Date.now()));if(p===null){ok=false;break;}rows.push(...p);}
  if(!ok){fail.push(s);continue;}
  const m=new Map();for(const c of rows)m.set(c.time,[c.time*1000,+c.open,+c.high,+c.low,+c.close]);
  fs.writeFileSync(f,JSON.stringify([...m.values()].sort((x,y)=>x[0]-y[0])));done++;if(done%10===0)console.log('symbols done',done,'of',syms.length);}}));
console.log('finished',done,'failed',JSON.stringify(fail));
