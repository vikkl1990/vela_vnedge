import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ExchangeExecutor } from './testnet.ts';

for(const point of ['intent','accepted-before-ack','acknowledged'])test(`SIGKILL at exchange ${point}: durable recovery never resubmits the entry`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-exchange-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'db.sqlite'),remote=join(dir,'exchange.json');
  const child=spawnSync(process.execPath,['--no-warnings=ExperimentalWarning','--input-type=module','-e',`
    import {writeFileSync} from 'node:fs';
    import {Db} from ${JSON.stringify(new URL('../db.ts',import.meta.url).href)};
    import {DEFAULT_CONFIG} from ${JSON.stringify(new URL('../config.ts',import.meta.url).href)};
    import {PaperEngine} from ${JSON.stringify(new URL('../paper/engine.ts',import.meta.url).href)};
    import {ExchangeExecutor} from ${JSON.stringify(new URL('./testnet.ts',import.meta.url).href)};
    const [file,remote,point]=process.argv.slice(1),kill=()=>process.kill(process.pid,'SIGKILL');
    const db=new Db(file),cfg=structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.paper,{feeRatePct:0,makerFeeRatePct:0,slippageBps:0,latencyMs:0,fillSource:'candles'});
    cfg.execution={...cfg.execution,mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0};
    const paper=new PaperEngine(db,()=>cfg);
    const p=paper.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:60010,signalId:null,exitMode:'both'}).position;
    if(!p)throw Error('fixture entry missing');
    const ex=new ExchangeExecutor(paper,()=>cfg,{host:'testnet',placeOrder:async o=>{writeFileSync(remote,JSON.stringify({...o,id:123,unfilled_size:0,state:'closed',average_fill_price:101,paid_commission:0}));if(point==='accepted-before-ack')kill();return{id:123,state:'closed'};}});
    const intent=ex.ledger.intent.bind(ex.ledger),submitted=ex.ledger.submitted.bind(ex.ledger);
    if(point==='intent')ex.ledger.intent=(...args)=>{const r=intent(...args);kill();return r;};
    if(point==='acknowledged')ex.ledger.submitted=(...args)=>{submitted(...args);kill();};
    await ex.send({product_id:27,size:p.qty,side:'buy',order_type:'market_order',purpose:'entry',client_order_id:'vnedge-crash-fixture'},p.id,'BTCUSD');
  `,file,remote,point],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.execution,{mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0});
  const paper=new PaperEngine(db,()=>cfg),lookup=async()=>existsSync(remote)?JSON.parse(readFileSync(remote,'utf8')):null;
  let sent=0;
  const fake:any={host:'testnet',hasAuth:true,dryRun:false,products:async()=>new Map([['BTCUSD',{id:27,symbol:'BTCUSD'}]]),wallet:async()=>[],openOrders:async()=>[],order:lookup,orderByClientId:lookup,placeOrder:async()=>{sent++;throw Error('recovery must not resend entry');}};
  const ex=new ExchangeExecutor(paper,()=>cfg,fake);t.after(()=>ex.stop());
  await ex.start();await ex.recover();await ex.sweepNow();await ex.flush();
  const rows=ex.ledger.recent();assert.equal(rows.length,1);assert.equal(sent,0);
  assert.equal(paper.openPositions().length,1);assert.equal(db.get<any>('SELECT COUNT(*) n FROM orders').n,1);
  assert.equal(rows[0].state,point==='intent'?'unknown':'filled');
  if(point!=='intent'){assert.equal(paper.openPositions()[0].entryPrice,101);assert.ok(ex.hasExposure());}
});
