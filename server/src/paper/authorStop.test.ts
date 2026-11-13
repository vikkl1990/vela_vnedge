import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {PaperExitExecution} from './exitExecution.ts';

test('author amendment is durable, cannot loosen risk, does not fill, and survives restart until acknowledgement',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:50,slippageBps:0,liquidation:false});
 const e=new PaperEngine(db,()=>cfg);
 e.onEntry({kind:'entry',side:'long',price:100,sl:99,tp:[102,103,104],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},
  {scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:60010,signalId:null,exitMode:'both'});
 e.onTrade('BTCUSD',100,1e6,60060,60060);const p=e.openPositions()[0];
 assert.ok(p);const ledger=new PaperExitExecution(db,0);ledger.register(p,p.qty);cfg.paper.latencyMs=50;
 const qty=p.qtyOpen,fees=p.fees;
 e.onScriptExit('s','BTCUSD','15m','stop_update',100,60100,'both','short');assert.equal(ledger.state(p.id)?.desired_stop,null);
 e.onScriptExit('s','BTCUSD','15m','stop_update',100,60100,'both','long');assert.equal(p.sl,99);assert.equal(ledger.state(p.id)?.desired_stop,100);
 const restarted=new PaperEngine(db,()=>cfg),held=restarted.openPositions()[0];
 assert.equal(ledger.acknowledge(held,60149),false);assert.equal(ledger.acknowledge(held,60150),true);assert.equal(held.sl,100);
 restarted.onScriptExit('s','BTCUSD','15m','stop_update',98,60200,'both','long');assert.equal(ledger.state(p.id)?.desired_stop,null);
 assert.equal(held.status,'open');assert.equal(held.qtyOpen,qty);assert.equal(held.fees,fees);assert.equal(held.fills.length,1);
});

test('native stop amendments use the old stop until acknowledgement and then close at later executable depth in both books',t=>{
 for(const book of [0,2]){
  const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper,{fillSource:'tape',latencyMs:50,slippageBps:0,liquidation:false,trailAfterR:0,floorAtR:0,breakEvenAfterTp1:false});
  const e=new PaperEngine(db,()=>cfg,{book});e.causalExits=true;
  e.onEntry({kind:'entry',side:'long',price:100,sl:99,tp:[102,103,104],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},
   {scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:60010,signalId:null,exitMode:'both'});
  e.onTrade('BTCUSD',100,1e6,60060,60060);const p=e.openPositions()[0];assert.ok(p);
  for(const [price,at] of [[NaN,60100],[-1,60100],[100,NaN],[100,60000]])e.onScriptExit('s','BTCUSD','15m','stop_update',price,at,'both');
  assert.equal(e.view(p).execution?.desiredStop,null);
  e.onScriptExit('s','BTCUSD','15m','stop_update',100,60100,'both');
  e.onTrade('BTCUSD',99.5,1e6,60120,60120);assert.equal(p.sl,99);assert.equal(e.pendingExits().length,0);
  e.onTrade('BTCUSD',99.5,1e6,60150,60150);assert.equal(p.sl,100);assert.equal(p.status,'open');assert.equal(e.pendingExits()[0]?.ready_at,60200);
  const depth={receivedAt:60200,exchangeAt:60200,bids:[{price:99.4,size:1e6}],asks:[{price:99.6,size:1e6}]};
  assert.equal(e.settleExits('BTCUSD',{...depth,receivedAt:60199,exchangeAt:60199},60200),0);
  assert.equal(e.settleExits('BTCUSD',depth,60200),1);assert.equal(p.exitPrice,99.4);assert.equal(p.exitAt,60200);
  assert.equal(e.settleExits('BTCUSD',depth,60201),0);assert.equal(p.fills.length,2);
 }
});
