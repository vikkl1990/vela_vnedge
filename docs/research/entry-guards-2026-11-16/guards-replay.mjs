// Diagnostic only. Uses bound policy and production sizing/fee/price-sample logic.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {replayGuardSample,guardKind} from '../../../server/src/research/guardReplay.ts';
const dir=process.env.DATA_DIR??'.',input=fs.readFileSync(path.join(dir,'guard-signals.json'),'utf8'),data=JSON.parse(input);
if(data.version!==2||!Array.isArray(data.rows)||!Number.isFinite(data.asOf))throw Error('Regenerate the explicit-window version 2 signal export; legacy rows lack policy and refusal reasons');
const referenceEquity=Number(process.env.REFERENCE_EQUITY??1000),cache=new Map();
const hashes={signals:createHash('sha256').update(input).digest('hex'),candles:{}};
const rows=data.rows.map(x=>{if(!cache.has(x.sym)){const f=path.join(dir,'m1g',`${x.sym}.json`),raw=fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;cache.set(x.sym,raw?JSON.parse(raw):[]);hashes.candles[x.sym]=raw?createHash('sha256').update(raw).digest('hex'):null;}
 return replayGuardSample(x,cache.get(x.sym),data.asOf,referenceEquity);});
const groups={};
for(const x of data.rows){const g=guardKind(x.action);groups[g]??={signals:0,statuses:{},reasons:{},sampledClosed:0,sampledNet:0,sampledMeanR:null};groups[g].signals++;}
for(const r of rows){const g=groups[r.group];g.statuses[r.status]=(g.statuses[r.status]??0)+1;g.reasons[r.reason]=(g.reasons[r.reason]??0)+1;if(r.status==='sampled-closed'){g.sampledClosed++;g.sampledNet+=r.net;}}
for(const [k,g] of Object.entries(groups)){const closed=rows.filter(r=>r.group===k&&r.status==='sampled-closed');g.sampledMeanR=closed.length?closed.reduce((s,r)=>s+r.r,0)/closed.length:null;}
const result={version:2,from:data.from,asOf:data.asOf,referenceEquity,hashes,policyChangeEligible:false,promotionEligible:false,
 limitations:['Minute opens miss intraminute stops and targets; they are not tape or executable quotes.','No shared-wallet replay, competing positions, historical sizing record, funding or future author exits.','Only observed bound policies are used; missing history and resting/reclaim orders are unverified.','Sampled cash fees use the archived policy. Voucher benefits are not trading profit.','Sampled results are not a current-versus-relaxed-cooldown profit comparison.'],groups,rows};
if(!process.env.OUT)throw Error('OUT is required');
fs.writeFileSync(process.env.OUT,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({groups,policyChangeEligible:false,out:process.env.OUT},null,2));
