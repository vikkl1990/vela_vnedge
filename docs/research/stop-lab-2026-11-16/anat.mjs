import fs from 'node:fs';
const T=JSON.parse(fs.readFileSync('replay-trades.json','utf8')).trades;
const f=(x,d=3)=>(+x).toFixed(d), avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]};
for(const t of T){t.distBps=Math.abs(t.entry-t.sl)/t.entry*1e4;t.gross=t.R+t.feeR;t.feeBps=t.feeR*t.distBps;}
const grp=(name,sel,keys)=>{console.log('\n'+name);console.log('key'.padEnd(14),'n'.padStart(5),'net R'.padStart(7),'fee R'.padStart(7),'gross R'.padStart(8),'dist bps med'.padStart(13),'fee bps'.padStart(8),'win%'.padStart(5));for(const k of keys){const x=T.filter(t=>sel(t,k));if(!x.length)continue;console.log(String(k).padEnd(14),String(x.length).padStart(5),f(avg(x.map(t=>t.R))).padStart(7),f(avg(x.map(t=>t.feeR))).padStart(7),f(avg(x.map(t=>t.gross))).padStart(8),f(med(x.map(t=>t.distBps)),0).padStart(13),f(avg(x.map(t=>t.feeBps)),1).padStart(8),(avg(x.map(t=>t.R>0?1:0))*100).toFixed(0).padStart(5));}};
grp('by tf',(t,k)=>t.tf===k,['15m','1h','4h']);
grp('by book',(t,k)=>t.bt===k,[0,2]);
grp('by exit reason',(t,k)=>t.reason===k,[...new Set(T.map(t=>t.reason))]);
grp('by stop distance (bps)',(t,k)=>t.distBps>=k[0]&&t.distBps<k[1],[[0,60],[60,100],[100,150],[150,250],[250,400],[400,1e5]]);
grp('by fee R bucket',(t,k)=>t.feeR>=k[0]&&t.feeR<k[1],[[0,.03],[.03,.06],[.06,.1],[.1,.15],[.15,.25],[.25,9]]);
console.log('\nall: n',T.length,'net',f(avg(T.map(t=>t.R))),'fee',f(avg(T.map(t=>t.feeR))),'gross',f(avg(T.map(t=>t.gross))));
