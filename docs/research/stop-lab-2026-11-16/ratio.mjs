import fs from 'node:fs';
// reuse stoplab context building by importing its pieces: quick re-derive ATR ratio per tf
const src=fs.readFileSync('stoplab.mjs','utf8').split("// ---- stop definitions")[0];
fs.writeFileSync('_ctx.mjs',src+"\nexport {cases};");
const {cases}=await import('./_ctx.mjs');
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))]};
console.log('tf   n   dist/ATR p10 p50 p90 | stop%: p10 p50 p90 | at cap(>=295bps) | within fee floor(<110bps)');
for(const tf of ['15m','1h','4h']){const x=cases.filter(c=>c.t.tf===tf);const r=x.map(c=>Math.abs(c.t.entry-c.t.sl)/c.atr),d=x.map(c=>Math.abs(c.t.entry-c.t.sl)/c.t.entry*1e4);
 const atrbps=x.map(c=>c.atr/c.t.entry*1e4);
 console.log(tf,x.length,'|',q(r,.1).toFixed(2),q(r,.5).toFixed(2),q(r,.9).toFixed(2),'|',q(d,.1).toFixed(0),q(d,.5).toFixed(0),q(d,.9).toFixed(0),'| ATR bps p50',q(atrbps,.5).toFixed(0),'| cap',(d.filter(v=>v>=295&&v<=305).length/d.length*100).toFixed(0)+'%','| floor',(d.filter(v=>v<110).length/d.length*100).toFixed(0)+'%','| >=1.4ATR',(r.filter(v=>v>=1.4).length/r.length*100).toFixed(0)+'%');}
