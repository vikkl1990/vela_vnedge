import fs from 'node:fs';
const D=JSON.parse(fs.readFileSync('stoplab-res.json','utf8')),M=D.meta,R0=D.rules[0];
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length,f=(x,d=3)=>(+x).toFixed(d);
const SC='trend-impulse-channels-zeiierman';
const day=i=>Math.floor(M[i].at/864e5);
// per trade: (mirror - real), minus the mean (mirror - real) of other scanners' trades on the same side and same day (controls for drift and side mix)
const key=i=>day(i)+M[i].side;
const ctl={};for(let i=0;i<M.length;i++){if(M[i].sc===SC)continue;(ctl[key(i)]??=[]).push(R0.mir[i]-R0.real[i]);}
const rows=[];for(let i=0;i<M.length;i++){if(M[i].sc!==SC)continue;const c=ctl[key(i)];if(!c||c.length<3)continue;rows.push({d:day(i),x:(R0.mir[i]-R0.real[i])-avg(c),at:M[i].at});}
const by={};for(const r of rows)(by[r.d]??=[]).push(r.x);
const dayMeans=Object.values(by).map(v=>avg(v)),n=dayMeans.length,m=avg(dayMeans),sd=Math.sqrt(dayMeans.reduce((a,x)=>a+(x-m)**2,0)/(n-1));
console.log('trades matched to same-day, same-side controls',rows.length,'over',n,'days');
console.log('scanner-specific advantage of the as-drawn reading, mean per trade',f(avg(rows.map(r=>r.x))),'| day-clustered mean',f(m),'se',f(sd/Math.sqrt(n)),'t',f(m/(sd/Math.sqrt(n)),1));
const mid=[...rows.map(r=>r.at)].sort((a,b)=>a-b)[rows.length>>1];
for(const [nm,sel] of [['first half',r=>r.at<mid],['second half',r=>r.at>=mid]]){const x=rows.filter(sel).map(r=>r.x);console.log(nm,'n',x.length,'mean',f(avg(x)));}
