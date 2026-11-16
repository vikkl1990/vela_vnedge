// Replay every entry signal of the last 14 days (taken and refused) under the account's exit recipe, from 1-minute candles.
// Entry = open of the next minute after the signal; stop = max(1.5 ATR14 of the signal timeframe, fee floor), capped at 3%;
// exit = live trail (arm .5R, keep 90/92/94%, TP 6R), 7-day horizon, fee 9.4 bps a round trip.
import fs from 'node:fs';
const S=JSON.parse(fs.readFileSync('guard-signals.json','utf8')),TFMS={'15m':900e3,'1h':3600e3,'4h':14400e3},FEE=9.4,H=7*86400e3;
const m1={};for(const s of new Set(S.map(x=>x.sym)))m1[s]=JSON.parse(fs.readFileSync(`m1g/${s}.json`,'utf8'));
const lb=(a,t)=>{let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m][0]<t)l=m+1;else h=m;}return l;};
const NOW=pk=>pk>=4?pk*.94:pk>=2?pk*.92:pk>=.5?Math.max(.25,pk*.9):-1;
const tfBars={};const bars=(s,tf)=>{const k=s+tf;if(tfBars[k])return tfBars[k];const ms=TFMS[tf],out=[];let cur=null;for(const b of m1[s]){const t=Math.floor(b[0]/ms)*ms;if(!cur||cur.t!==t){if(cur)out.push(cur);cur={t,o:b[1],h:b[2],l:b[3],c:b[4],n:1};}else{if(b[2]>cur.h)cur.h=b[2];if(b[3]<cur.l)cur.l=b[3];cur.c=b[4];cur.n++;}}if(cur)out.push(cur);return tfBars[k]=out.filter(x=>x.n>=ms/60e3*.9);};
const rows=[];let skipped=0;
for(const x of S){const a=m1[x.sym],ms=TFMS[x.tf];if(!a||!ms){skipped++;continue;}
  const i0=lb(a,Math.floor(x.at/60e3)*60e3+60e3);if(i0>=a.length-30){skipped++;continue;}
  const entry=a[i0][1],tb=bars(x.sym,x.tf);let e=lb(tb.map?tb.map(z=>z.t):[],0);
  // closed bars before the signal
  let hi=tb.length;while(hi>0&&tb[hi-1].t+ms>x.at)hi--;if(hi<16){skipped++;continue;}
  let tr=0;for(let k=hi-14;k<hi;k++){const b=tb[k],p=tb[k-1];tr+=Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c));}
  const atr=tr/14;let dist=Math.max(1.5*atr,entry*0.0071);dist=Math.min(dist,entry*0.03);
  const dir=x.side==='long'?1:-1;let stop=-1,peak=0,out=null;const i1=Math.min(a.length,lb(a,a[i0][0]+H));
  for(let i=i0;i<i1;i++){const b=a[i],h=dir>0?(b[2]-entry)/dist:(entry-b[3])/dist,l=dir>0?(b[3]-entry)/dist:(entry-b[2])/dist;if(l<=stop){out=stop;break;}if(h>=6){out=6;break;}if(h>peak)peak=h;const lk=NOW(peak);if(lk>stop)stop=lk;}
  if(out===null){const b=a[i1-1];out=(dir>0?b[4]-entry:entry-b[4])/dist;}
  rows.push({...x,R:out-FEE/(dist/entry*1e4),dist:dist/entry*1e4,partial:i1-i0<H/60e3-5,day:Math.floor(x.at/864e5)});}
console.log('replayed',rows.length,'skipped',skipped);
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN,f=(v,d=3)=>(+v).toFixed(d);
function boot(rs,B=3000){const days=new Map();for(const r of rs){(days.get(r.day)??days.set(r.day,[]).get(r.day)).push(r);}const keys=[...days.keys()];let seed=5;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;const o=[];for(let b=0;b<B;b++){const p=[];for(let k=0;k<keys.length;k++)p.push(...days.get(keys[Math.floor(rnd()*keys.length)]));if(p.length)o.push(avg(p.map(r=>r.R)));}o.sort((x,y)=>x-y);return [o[Math.floor(B*.025)],o[Math.floor(B*.975)]];}
const neutral=rs=>{const L=rs.filter(r=>r.side==='long'),Sh=rs.filter(r=>r.side==='short');return L.length&&Sh.length?(avg(L.map(r=>r.R))+avg(Sh.map(r=>r.R)))/2:NaN;};
console.log('\nkind        n   avg R   95% CI (by day)    long   short   neutral');
for(const k of ['opened','burst','cooldown','regime']){const rs=rows.filter(r=>r.k===k);if(!rs.length)continue;const ci=boot(rs);const L=rs.filter(r=>r.side==='long'),Sh=rs.filter(r=>r.side==='short');
  console.log(k.padEnd(9),String(rs.length).padStart(5),f(avg(rs.map(r=>r.R))).padStart(7),`  ${f(ci[0])}..${f(ci[1])}`.padEnd(20),f(avg(L.map(r=>r.R))).padStart(7),f(avg(Sh.map(r=>r.R))).padStart(7),f(neutral(rs)).padStart(8));}
// the refused entries together, against the taken ones
const refused=rows.filter(r=>r.k!=='opened'),taken=rows.filter(r=>r.k==='opened');
console.log('\nall refused by the three guards: n',refused.length,'avg R',f(avg(refused.map(r=>r.R))),'| taken:',taken.length,f(avg(taken.map(r=>r.R))));
// correlation: refused burst entries grouped into same-side 2-minute clusters across markets
const bur=rows.filter(r=>r.k==='burst'||r.k==='opened').sort((a,b)=>a.at-b.at);const clusters=[];
for(const r of bur){const c=clusters.find(c=>c.side===r.side&&r.at-c.last<=120e3);if(c){c.items.push(r);c.last=r.at;}else clusters.push({side:r.side,last:r.at,items:[r]});}
const multi=clusters.filter(c=>c.items.length>1);
console.log('same-side entries within 120 s of each other (taken + burst-refused): clusters',clusters.length,'| with 2+ entries',multi.length,'| entries in them',multi.reduce((n,c)=>n+c.items.length,0),'| largest',Math.max(...clusters.map(c=>c.items.length)));
const sums=multi.map(c=>c.items.reduce((s,r)=>s+r.R,0)).sort((a,b)=>a-b);
console.log('cluster sum of R: mean',f(avg(sums)),'worst',f(sums[0]),'5th pct',f(sums[Math.floor(sums.length*.05)]),'best',f(sums.at(-1)));
const taking=multi.map(c=>c.items.filter(r=>r.k==='opened').reduce((s,r)=>s+r.R,0)).sort((a,b)=>a-b);
console.log('same clusters, only the entries the account actually took: worst',f(taking[0]),'5th pct',f(taking[Math.floor(taking.length*.05)]),'mean',f(avg(taking)));
// by symbol concentration of refused
const bySym={};for(const r of refused)(bySym[r.sym]??=[]).push(r.R);
console.log('\nrefused by symbol (n>=8):',Object.entries(bySym).filter(([,v])=>v.length>=8).map(([k,v])=>`${k.replace('USD','')} n${v.length} ${f(avg(v),2)}`).join(' | '));
