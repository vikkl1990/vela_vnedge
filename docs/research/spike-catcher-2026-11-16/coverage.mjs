import fs from 'node:fs';
const E=JSON.parse(fs.readFileSync('recent-spikes.json','utf8')),P=JSON.parse(fs.readFileSync('pos80h.json','utf8'));
const f=(x,d=2)=>(+x).toFixed(d),avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
console.log(`positions ${P.length} | spikes ${E.length}`);
for(const [name,books] of [['ACCOUNT',[0]],['SHADOW',[2]]]){
  let withDir=0,against=0,none=0;
  for(const e of E){const lo=e.at-5*60e3,hi=e.at+30*60e3;
    const ps=P.filter(p=>books.includes(p.bt)&&p.s===e.s&&p.a<=hi&&p.b>=lo);
    if(!ps.length){none++;continue;}
    if(ps.some(p=>p.d===e.d))withDir++;else against++;}
  console.log(`${name}: no position in that market during the spike ${none} (${f(none/E.length*100,0)}%) | holding with the move ${withDir} | holding only against it ${against}`);
}
for(const [name,book] of [['shadow',2],['account',0]]){
  const after=[];for(const e of E)for(const p of P.filter(p=>p.bt===book&&p.s===e.s&&p.a>=e.at&&p.a<=e.at+30*60e3&&p.R!==null))after.push({...p,spike:e});
  const w=after.filter(p=>p.d===p.spike.d),ag=after.filter(p=>p.d!==p.spike.d);
  console.log(`${name} trades opened within 30 min after a spike: n=${after.length} avg R ${f(avg(after.map(p=>p.R)),3)} net $${f(after.reduce((s,p)=>s+(p.net??0),0),1)} | with the spike n=${w.length} R ${f(avg(w.map(p=>p.R)),3)} | against it n=${ag.length} R ${f(avg(ag.map(p=>p.R)),3)}`);
  console.log(`  by timeframe: ${['15m','1h','4h'].map(t=>`${t} ${after.filter(p=>p.tf===t).length}`).join(' · ')}`);
}
// the bot's trades in the markets that spiked most, whole window
const big=new Set(E.slice(0,40).map(e=>e.s));
const inBig=P.filter(p=>p.bt===0&&big.has(p.s)&&p.R!==null);
console.log(`account trades closed in the 40 biggest spikes' markets (80 h): n=${inBig.length} avg R ${f(avg(inBig.map(p=>p.R)),3)} net $${f(inBig.reduce((s,p)=>s+p.net,0),1)}`);
