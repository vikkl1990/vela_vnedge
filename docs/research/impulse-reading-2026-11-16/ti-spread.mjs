// For every base-id shadow trade (an event the script printed), replay BOTH sides at the same fill with the live exit.
// d = (R_long - R_short)/2 is the directional move the event captured, drift included, costs cancelled.
// The base reading goes long on "Upper Retest" and short on "Lower Retest"; the script draws the opposite.
// Spread = mean(d | base went long) - mean(d | base went short). Drift is common to both groups and cancels.
// spread > 0: the base reading picks the better side. spread < 0: the as-drawn reading does.
import fs from 'node:fs';
const T=JSON.parse(fs.readFileSync('ti-shadow.json','utf8')),H=7*86400e3;
const m1={};for(const s of new Set(T.map(t=>t.symbol)))m1[s]=JSON.parse(fs.readFileSync(`m1b/${s}.json`,'utf8'));
const lb=(a,t)=>{let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m][0]<t)l=m+1;else h=m;}return l;};
const NOW=pk=>pk>=4?pk*.94:pk>=2?pk*.92:pk>=.5?Math.max(.25,pk*.9):-1;
function run(a,i0,i1,e,dist,dir){let stop=-1,peak=0;for(let i=i0;i<i1;i++){const b=a[i],hi=dir>0?(b[2]-e)/dist:(e-b[3])/dist,lo=dir>0?(b[3]-e)/dist:(e-b[2])/dist;if(lo<=stop)return stop;if(hi>=6)return 6;if(hi>peak)peak=hi;const l=NOW(peak);if(l>stop)stop=l;}const b=a[i1-1];return (dir>0?b[4]-e:e-b[4])/dist;}
const rows=[];
for(const t of T){const a=m1[t.symbol],start=Math.floor(t.fillAt/60e3)*60e3+60e3,i0=lb(a,start),i1=lb(a,start+H);if(i1-i0<30)continue;const dist=Math.abs(t.entry-t.sl);if(!(dist>0))continue;
  const rl=run(a,i0,i1,t.entry,dist,1),rs=run(a,i0,i1,t.entry,dist,-1),dbps=dist/t.entry*1e4,fee=t.feeR;
  rows.push({at:t.fillAt,tf:t.tf,sym:t.symbol,s:t.side==='long'?1:-1,d:(rl-rs)/2,base:(t.side==='long'?rl:rs)-fee,native:(t.side==='long'?rs:rl)-fee,rec:t.R});}
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN,f=(x,d=3)=>(+x).toFixed(d);
const spread=rs=>avg(rs.filter(r=>r.s>0).map(r=>r.d))-avg(rs.filter(r=>r.s<0).map(r=>r.d));
function boot(rs,B=3000){const days=new Map();for(const r of rs){const k=Math.floor(r.at/864e5);(days.get(k)??days.set(k,[]).get(k)).push(r);}const keys=[...days.keys()];let seed=11;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;const out=[];for(let b=0;b<B;b++){const p=[];for(let k=0;k<keys.length;k++)p.push(...days.get(keys[Math.floor(rnd()*keys.length)]));const L=p.filter(r=>r.s>0),S=p.filter(r=>r.s<0);if(L.length&&S.length)out.push(avg(L.map(r=>r.d))-avg(S.map(r=>r.d)));}out.sort((a,b)=>a-b);return [out[Math.floor(out.length*.025)],out[Math.floor(out.length*.975)]];}
const show=(name,rs)=>{if(rs.length<10){console.log(name.padEnd(26),'n',rs.length,'(too few)');return;}const L=rs.filter(r=>r.s>0),S=rs.filter(r=>r.s<0),ci=boot(rs);console.log(name.padEnd(26),'n',String(rs.length).padStart(4),'(L',L.length,'S',S.length+')','| base R',f(avg(rs.map(r=>r.base))).padStart(7),'as-drawn R',f(avg(rs.map(r=>r.native))).padStart(7),'| spread',f(spread(rs)).padStart(7),'95% day-boot',f(ci[0]),'..',f(ci[1]));};
console.log('replayed',rows.length,'of',T.length,'| recorded avg R',f(avg(rows.map(r=>r.rec))));
show('ALL',rows);
for(const tf of ['15m','1h','4h'])show('tf '+tf,rows.filter(r=>r.tf===tf));
const wk=r=>new Date(r.at-((new Date(r.at).getUTCDay()+6)%7)*86400e3).toISOString().slice(5,10);
console.log('\nby week of fill');for(const w of [...new Set(rows.map(wk))].sort())show('week '+w,rows.filter(r=>wk(r)===w));
const cut=Date.parse('2026-10-20');console.log('\nregimes');show('23 Sep - 19 Oct',rows.filter(r=>r.at<cut));show('20 Oct - 16 Nov',rows.filter(r=>r.at>=cut));
console.log('\nBOTH sides taken at every event (straddle: (base + as-drawn)/2), replay, after fees');
for(const [n,sel] of [['23 Sep - 19 Oct',r=>r.at<cut],['20 Oct - 2 Nov',r=>r.at>=cut&&r.at<Date.parse('2026-11-03')],['3 Nov - 16 Nov',r=>r.at>=Date.parse('2026-11-03')]]){const x=rows.filter(sel);console.log(n.padEnd(18),'n',String(x.length).padStart(4),'straddle R',f(avg(x.map(r=>(r.base+r.native)/2))),'| recorded base R',f(avg(x.map(r=>r.rec))));}
