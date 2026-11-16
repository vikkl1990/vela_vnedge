import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('stops-sample.json','utf8')), S=d.sample, out=[];
const get=async(sym,a,b)=>{for(let k=0;k<3;k++){try{const r=await fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=1m&symbol=${sym}&start=${Math.floor(a/1000)}&end=${Math.floor(b/1000)}`,{headers:{'User-Agent':'research'}});const j=await r.json();if(j.result)return j.result.map(c=>({t:c.time*1000,o:+c.open,h:+c.high,l:+c.low,c:+c.close})).sort((x,y)=>x.t-y.t);}catch{}await new Promise(r=>setTimeout(r,500));}return null;};
let i=0;
await Promise.all(Array.from({length:4},async()=>{for(;;){const t=S[i++];if(!t)return;
  const c=await get(t.symbol,t.exit_at,t.exit_at+24*3600e3); if(!c||c.length<60){continue;}
  const long=t.side==='long',R=Math.abs(t.entry_price-t.sl0); if(!(R>0))continue;
  const fav=p=>(long?p-t.entry_price:t.entry_price-p)/R; // in R from entry; stop is at -1
  const win=(ms)=>c.filter(x=>x.t<=t.exit_at+ms);
  const res={tf:t.tf,bt:t.bt};
  for(const [k,ms] of [['1h',3600e3],['4h',4*3600e3],['24h',24*3600e3]]){const w=win(ms);
    const best=Math.max(...w.map(x=>fav(long?x.h:x.l))), worst=Math.min(...w.map(x=>fav(long?x.l:x.h)));
    res['best'+k]=best; res['worst'+k]=worst; }
  // order of events in 24h: back to entry (0R) before another -1R beyond the stop (-2R)?
  let first=null; for(const x of c){const hi=fav(long?x.h:x.l), lo=fav(long?x.l:x.h); if(hi>=0&&lo<=-2){first='both';break;} if(hi>=0){first='back';break;} if(lo<=-2){first='further';break;}} res.first=first;
  out.push(res);}}));
const n=out.length,pct=(f)=>(out.filter(f).length/n*100).toFixed(0)+'%';
console.log('stopped trades analysed',n,'of',S.length,'(of',d.total,'stops in 14 days)');
console.log('after the stop, within 4h: price back to the ENTRY price',pct(r=>r.best4h>=0),'| reached +1R from entry',pct(r=>r.best4h>=1),'| went a further -1R beyond the stop',pct(r=>r.worst4h<=-2));
console.log('within 24h:                back to entry',pct(r=>r.best24h>=0),'| +1R',pct(r=>r.best24h>=1),'| further -1R',pct(r=>r.worst24h<=-2));
console.log('which first (24h): back to entry before -2R',pct(r=>r.first==='back'),'| -2R before entry',pct(r=>r.first==='further'),'| neither',pct(r=>r.first===null));
for(const tf of ['15m','1h','4h']){const o=out.filter(r=>r.tf===tf);if(!o.length)continue;const p=(f)=>(o.filter(f).length/o.length*100).toFixed(0)+'%';console.log(tf,'n',o.length,'back to entry 4h',p(r=>r.best4h>=0),'24h',p(r=>r.best24h>=0),'| +1R 24h',p(r=>r.best24h>=1),'| further -1R 24h',p(r=>r.worst24h<=-2));}
