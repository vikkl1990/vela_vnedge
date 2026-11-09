/** Read account-specific eligibility; --apply activates only a future paper fee policy. No exchange writes. */
import fs from 'node:fs';
import path from 'node:path';
import {DeltaConnection} from '../server/src/connections/delta.ts';
import {activateScalperOffer} from '../server/src/connections/scalperOffer.ts';
import {validateConfig} from '../server/src/config.ts';

const dataDir=path.resolve(process.argv.find(x=>x.startsWith('--data-dir='))?.slice(11)??'data');
const apply=process.argv.includes('--apply');
const file=path.join(dataDir,'config.json'),before=fs.readFileSync(file,'utf8'),cfg=JSON.parse(before);
if(cfg.execution?.mode!=='paper'||cfg.execution?.allowProduction!==false)throw Error('This tool only activates paper fee modeling with live execution disabled');
const connection=new DeltaConnection(dataDir),observed=await connection.scalperEligibility();
if(observed.active!==true)throw Error('Delta did not confirm active Scalper Offer enrollment; no changes made');
const next={...cfg,paper:activateScalperOffer(cfg.paper,observed)};
const errors=validateConfig(next);if(errors.length)throw Error('Configuration validation failed; no changes made');
let backup:string|undefined;
if(apply){
  if(fs.readFileSync(file,'utf8')!==before)throw Error('Config changed during verification; retry against the new config');
  if(connection.observationRevision()?.revision!==observed.connectionRevision)throw Error('Credentials changed during verification');
  backup=file+`.before-scalper-${Date.now()}`;
  fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
  const temporary=file+`.scalper-${process.pid}.tmp`;
  try{fs.writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:fs.statSync(file).mode&0o777});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
console.log(JSON.stringify({applied:apply,active:observed.active,checkedAt:observed.checkedAt,
  effectiveFrom:next.paper.scalperOffer.verification.effectiveFrom,originalJoinDateKnown:cfg.paper.scalperOffer?.joinedAt!=null,
  source:'Delta India authenticated trading preferences',backup:backup??null,
  mode:cfg.execution.mode,marginPerTrade:cfg.paper.marginPerTrade},null,2));
