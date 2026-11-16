import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync('guard-signals.json','utf8'));
if(input.version!==2||!Array.isArray(input.rows)||!Number.isFinite(input.asOf)||!Number.isFinite(input.from))throw Error('version 2 explicit-window export required');
const d=input.rows;
fs.mkdirSync('m1g',{recursive:true});
const syms=[...new Set(d.map(t=>t.sym))];
const a=Math.floor((input.from-5*86400e3)/60e3)*60e3,b=Math.floor(input.asOf/60e3)*60e3;
const CH=1000*60e3;
async function page(sym,s,e){for(let k=0;k<4;k++){try{const r=await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=1m&symbol=${sym}&start=${Math.floor(s/1000)}&end=${Math.floor(e/1000)}`,{headers:{'User-Agent':'research'}});if(r.status===200){const body=await r.json();if(body.success===true&&Array.isArray(body.result))return body.result;}}catch{}await new Promise(r=>setTimeout(r,800*(k+1)));}return null;}
let done=0,fail=[];const q=[...syms];
await Promise.all(Array.from({length:5},async()=>{for(;;){const s=q.shift();if(!s)return;const f=`m1g/${s}.json`;if(fs.existsSync(f)){done++;continue;}
  const rows=[];let ok=true;for(let t=a;t<b;t+=CH){const p=await page(s,t,Math.min(t+CH-60e3,b));if(p===null){ok=false;break;}rows.push(...p);}
  if(!ok){fail.push(s);continue;}
  const m=new Map();for(const c of rows)if(c.time*1000>=a&&c.time*1000<b)m.set(c.time,[c.time*1000,+c.open,+c.high,+c.low,+c.close]);
  fs.writeFileSync(f,JSON.stringify([...m.values()].sort((x,y)=>x[0]-y[0])));done++;}}));
console.log('finished',done,'of',syms.length,'failed',JSON.stringify(fail));
