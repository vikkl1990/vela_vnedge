import fs from 'node:fs';
const D=JSON.parse(fs.readFileSync('stoplab-res.json','utf8')),M=D.meta,R0=D.rules[0];
const sum=a=>a.reduce((s,x)=>s+x,0),avg=a=>a.length?sum(a)/a.length:NaN,f=(x,d=3)=>(+x).toFixed(d);
const SC='trend-impulse-channels-zeiierman';
const idx=M.map((m,i)=>i).filter(i=>M[i].sc===SC);
console.log('replayed trades of the base id',idx.length,'| real (as the account reads it)',f(avg(idx.map(i=>R0.real[i]))),'| mirrored side (as the script draws it)',f(avg(idx.map(i=>R0.mir[i]))));
// controls: every other scanner, same window, same replay
const oth=M.map((m,i)=>i).filter(i=>M[i].sc!==SC);
console.log('all other scanners: real',f(avg(oth.map(i=>R0.real[i]))),'mirror',f(avg(oth.map(i=>R0.mir[i]))),'(mirror - real = drift/side-mix effect of the book)');
for(const side of ['long','short']){const x=idx.filter(i=>M[i].side===side);console.log(' base',side,'n',x.length,'real',f(avg(x.map(i=>R0.real[i]))),'mirror',f(avg(x.map(i=>R0.mir[i]))));}
// drift-neutral comparison: for each event the mirrored trade is the as-drawn trade; compare to what the same side mix gives for other scanners
const wk=i=>new Date(M[i].at-((new Date(M[i].at).getUTCDay()+6)%7)*86400e3).toISOString().slice(5,10);
const weeks=[...new Set(idx.map(wk))].sort();
console.log('\nweek   n   real   mirror  | other scanners real  mirror');
for(const w of weeks){const x=idx.filter(i=>wk(i)===w),o=oth.filter(i=>wk(i)===w);console.log(w,String(x.length).padStart(4),f(avg(x.map(i=>R0.real[i]))).padStart(7),f(avg(x.map(i=>R0.mir[i]))).padStart(7),' |',f(avg(o.map(i=>R0.real[i]))).padStart(7),f(avg(o.map(i=>R0.mir[i]))).padStart(7));}
// excess: (mirror - real) for this scanner minus the same for others, by week => scanner-specific direction effect
let ex=[];for(const w of weeks){const x=idx.filter(i=>wk(i)===w),o=oth.filter(i=>wk(i)===w);if(x.length>=15)ex.push([w,x.length,(avg(x.map(i=>R0.mir[i]-R0.real[i]))-avg(o.map(i=>R0.mir[i]-R0.real[i])))]);}
console.log('\nscanner-specific (mirror-real) minus the others\' (mirror-real), weeks with n>=15:',ex.map(e=>e[0]+' n'+e[1]+' '+f(e[2])).join(' | '));
// day-cluster t of per-trade (mir-real) difference for this scanner vs others
const d=idx.map(i=>R0.mir[i]-R0.real[i]),m=avg(d),sd=Math.sqrt(avg(d.map(x=>(x-m)**2)));
console.log('per-trade (mirror - real) mean',f(m),'sd',f(sd),'naive t',f(m/(sd/Math.sqrt(d.length)),1),'| others mean',f(avg(oth.map(i=>R0.mir[i]-R0.real[i]))));
