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

for(const point of ['before-cash','during-cash','after-cash'])test(`SIGKILL ${point}: split-exit cash and accounting coverage recover atomically`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-cash-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'db.sqlite');
  const child=spawnSync(process.execPath,['--no-warnings=ExperimentalWarning','--input-type=module','-e',`
    import {Db} from ${JSON.stringify(new URL('../db.ts',import.meta.url).href)};
    import {DEFAULT_CONFIG} from ${JSON.stringify(new URL('../config.ts',import.meta.url).href)};
    import {PaperEngine} from ${JSON.stringify(new URL('../paper/engine.ts',import.meta.url).href)};
    import {ExchangeExecutor} from ${JSON.stringify(new URL('./testnet.ts',import.meta.url).href)};
    const [file,point]=process.argv.slice(1),kill=()=>process.kill(process.pid,'SIGKILL'),db=new Db(file),cfg=structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.paper,{feeRatePct:0,makerFeeRatePct:0,slippageBps:0,latencyMs:0,fillSource:'candles'});
    Object.assign(cfg.execution,{mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0});
    const paper=new PaperEngine(db,()=>cfg),orders=[];
    const fake={host:'testnet',hasAuth:true,dryRun:false,products:async()=>new Map([['BTCUSD',{id:27,symbol:'BTCUSD'}]]),wallet:async()=>[],openOrders:async()=>[],setLeverage:async(_id,leverage)=>({leverage}),
      placeOrder:async o=>{const entry=o.purpose==='entry';const x={...o,id:orders.length+1,state:'closed',unfilled_size:entry?0:80,average_fill_price:entry?100:99.2,paid_commission:entry?.1:.12};orders.push(x);return x;},
      order:async id=>orders.find(o=>String(o.id)===String(id))??null};
    const ex=new ExchangeExecutor(paper,()=>cfg,fake,{confirmSec:0});await ex.start();
    const p=paper.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:Date.now(),signalId:null,exitMode:'both'}).position;
    await ex.flush();paper.closeManual(p.id);await ex.flush();
    const source=paper.orders()[0].id;
    const residual=ex.ledger.intent({product_id:27,side:'sell',size:80,order_type:'market_order',purpose:'exit',client_order_id:'vnedge-residual-crash'},p.id,'BTCUSD',null,'stranded',source);
    ex.ledger.filled(residual.id,{filledSize:80,avgPrice:99,fee:.08});
    if(point==='before-cash')kill();
    if(point==='during-cash'){const run=db.run.bind(db);db.run=(sql,...args)=>{const result=run(sql,...args);if(sql.startsWith('UPDATE orders SET price='))kill();return result;};}
    ex.accounting.sync(paper,ex.ledger);
    if(point==='after-cash')kill();
  `,file,point],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.execution,{mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0});
  const paper=new PaperEngine(db,()=>cfg);let sends=0;
  const fake:any={host:'testnet',hasAuth:true,dryRun:false,products:async()=>new Map([['BTCUSD',{id:27,symbol:'BTCUSD'}]]),wallet:async()=>[],openOrders:async()=>[],placeOrder:async()=>{sends++;throw Error('cash recovery must not send orders');}};
  const ex=new ExchangeExecutor(paper,()=>cfg,fake,{confirmSec:0});t.after(()=>ex.stop());
  await ex.start();await ex.sweepNow();await ex.recover();
  const trade=paper.trades()[0];assert.equal(trade.exitPrice,99.12);assert.ok(Math.abs(trade.fees-.3)<1e-10);
  assert.ok(Math.abs(trade.pnl-(-176.3))<1e-8);assert.equal(trade.accountingPending,false);
  assert.equal(paper.orders()[0].fee,.2);assert.equal(sends,0);assert.equal(ex.status().accounting.incomplete,0);
});

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

for(const point of ['before-paper-commit','after-paper-commit','after-leverage','before-network','accepted-before-ack','filled-before-adoption','after-handoff','exit-before-event'])test(`SIGKILL at command ${point}: committed work survives without duplicate exchange submission`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-command-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'db.sqlite'),remote=join(dir,'exchange.json');
  const child=spawnSync(process.execPath,['--no-warnings=ExperimentalWarning','--input-type=module','-e',`
    import {writeFileSync} from 'node:fs';
    import {Db} from ${JSON.stringify(new URL('../db.ts',import.meta.url).href)};
    import {DEFAULT_CONFIG} from ${JSON.stringify(new URL('../config.ts',import.meta.url).href)};
    import {PaperEngine} from ${JSON.stringify(new URL('../paper/engine.ts',import.meta.url).href)};
    import {ExchangeExecutor} from ${JSON.stringify(new URL('./testnet.ts',import.meta.url).href)};
    const [file,remote,point]=process.argv.slice(1),kill=()=>process.kill(process.pid,'SIGKILL');
    const db=new Db(file),cfg=structuredClone(DEFAULT_CONFIG),orders=[];
    Object.assign(cfg.paper,{feeRatePct:0,makerFeeRatePct:0,slippageBps:0,latencyMs:0,fillSource:'candles'});
    Object.assign(cfg.execution,{mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0});
    const paper=new PaperEngine(db,()=>cfg),fake={host:'testnet',hasAuth:true,dryRun:false,
      products:async()=>new Map([['BTCUSD',{id:27,symbol:'BTCUSD'}]]),wallet:async()=>[],openOrders:async()=>[],
      setLeverage:async(_id,leverage)=>{if(point==='after-leverage')kill();return{leverage};},
      placeOrder:async o=>{const x={...o,id:orders.length+1,unfilled_size:0,state:'closed',average_fill_price:101,paid_commission:.7};orders.push(x);writeFileSync(remote,JSON.stringify(orders));if(point==='accepted-before-ack')kill();return x;},
      order:async id=>orders.find(o=>String(o.id)===String(id))??null,
      orderByClientId:async id=>orders.find(o=>o.client_order_id===id)??null};
    const ex=new ExchangeExecutor(paper,()=>cfg,fake,{confirmSec:0});await ex.start();
    if(point==='before-paper-commit'){const record=ex.outbox.record.bind(ex.outbox);ex.outbox.record=(...a)=>{record(...a);kill();};}
    if(point==='after-paper-commit'){const emit=paper.emit.bind(paper);paper.emit=(event,...a)=>{if(event==='order')db.afterCommit(kill);return emit(event,...a);};}
    if(point==='before-network'){const intent=ex.ledger.intent.bind(ex.ledger);ex.ledger.intent=(...a)=>{const r=intent(...a);kill();return r;};}
    if(point==='filled-before-adoption'){const filled=ex.ledger.filled.bind(ex.ledger);ex.ledger.filled=(...a)=>{filled(...a);kill();};}
    if(point==='after-handoff'){const set=ex.outbox.set.bind(ex.outbox);ex.outbox.set=(...a)=>{set(...a);if(a[1]==='delivered')kill();};}
    const p=paper.commitDecision(()=>paper.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:Date.now(),signalId:null,exitMode:'both'}).position);
    await ex.flush();
    if(point==='exit-before-event'){const emit=paper.emit.bind(paper);paper.emit=(event,...a)=>{if(event==='order')kill();return emit(event,...a);};paper.closeManual(p.id);}
    throw Error('crash injection was not reached');
  `,file,remote,point],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.execution,{mode:'testnet',bracket:false,reconcileSec:0,sweepSec:0});
  const orders:any[]=existsSync(remote)?JSON.parse(readFileSync(remote,'utf8')):[];
  const initial=orders.length,paper=new PaperEngine(db,()=>cfg);
  const fake:any={host:'testnet',hasAuth:true,dryRun:false,products:async()=>new Map([['BTCUSD',{id:27,symbol:'BTCUSD'}]]),wallet:async()=>[],openOrders:async()=>[],
    setLeverage:async(_id:number,leverage:number)=>({leverage}),
    order:async(id:number|string)=>orders.find(o=>String(o.id)===String(id))??null,
    orderByClientId:async(id:string)=>orders.find(o=>o.client_order_id===id)??null,
    placeOrder:async(o:any)=>{const r={...o,id:orders.length+1,state:'closed',unfilled_size:0,average_fill_price:101,paid_commission:.7};orders.push(r);return r;}};
  const ex=new ExchangeExecutor(paper,()=>cfg,fake,{confirmSec:0});t.after(()=>ex.stop());
  await ex.start();await ex.sweepNow();await ex.flush();await ex.recover();await ex.sweepNow();
  const expectedNew=['after-paper-commit','after-leverage','exit-before-event'].includes(point)?1:0;
  assert.equal(orders.length,initial+expectedNew);
  assert.equal(new Set(orders.map(o=>o.client_order_id)).size,orders.length);
  assert.equal(ex.outbox.status().pending,0);
  if(point==='before-paper-commit'){
    assert.equal(paper.openPositions().length,0);assert.equal(db.get<any>('SELECT count(*) n FROM orders').n,0);
    assert.equal(ex.outbox.status().recent.length,0);
  }else if(point==='exit-before-event'){
    assert.equal(paper.openPositions().length,0);assert.equal(orders.filter(o=>o.purpose==='exit').length,1);assert.equal(ex.hasExposure(),false);
  }else if(point==='before-network'){
    assert.equal(ex.ledger.recent()[0].state,'unknown');assert.equal(orders.length,0);
  }else{
    assert.equal(paper.openPositions()[0].entryPrice,101);assert.equal(paper.openPositions()[0].fees,.7);
    assert.equal(orders.filter(o=>o.purpose==='entry').length,1);
  }
});
