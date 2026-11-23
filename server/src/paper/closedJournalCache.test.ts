import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';

function fixture(t:{after:(fn:()=>void)=>void},book:number){
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:0,fundingCharges:true,maxOpenPositions:0});
 const now=600_000,engine=new PaperEngine(db,()=>cfg,{book,now:()=>now});
 let n=0,reads=0;const all=db.all.bind(db);
 db.all=((sql:string,...args:any[])=>{if(sql.includes('SELECT * FROM positions')&&sql.includes("status='closed'"))reads++;return all(sql,...args);}) as typeof db.all;
 const open=()=>{
  const id=`scanner-${++n}`;
  const d=engine.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:id,scannerName:id,symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:60010,signalId:null,exitMode:'both'});
  assert.equal(d.action,'opened');return d.position!;
 };
 const verify=()=>{
  const fresh=new PaperEngine(db,()=>cfg,{book,now:()=>now});
  const mark=engine.mark('BTCUSD');if(mark!==undefined)fresh.setMark('BTCUSD',mark);
  assert.deepEqual(engine.closedPositions(),fresh.closedPositions());
  assert.deepEqual(engine.stats(),fresh.stats());
 };
 return {db,engine,open,verify,reads:()=>reads};
}

for(const book of [0,2])test(`book ${book}: a close burst updates the warm journal without reloading history`,t=>{
 const x=fixture(t,book),a=x.open(),b=x.open(),c=x.open();
 x.engine.stats();const before=x.reads();
 // Same timestamp closes arrive in reverse id order, and a delayed report sorts earlier.
 for(const [p,at]of [[b,60100],[a,60100],[c,60090]] as const)
  x.engine.adoptExitFill(p.id,{price:99,qty:p.qtyOpen,fee:.02,reason:'sl',at});
 assert.equal(x.reads(),before,'never deserialize the full closed history per close');
 assert.deepEqual(x.engine.closedPositions().map(p=>p.id),[c.id,a.id,b.id]);
 x.verify();
});

test('partial exits, late funding and restated fees preserve warm/cold accounting parity',t=>{
 const x=fixture(t,2),p=x.open();x.engine.stats();const before=x.reads();
 x.engine.adoptExitFill(p.id,{price:106,qty:p.qty/2,fee:.03,reason:'tp1',at:60100});
 assert.equal(x.engine.closedPositions().length,0);
 x.engine.adoptExitFill(p.id,{price:99,qty:p.qtyOpen,fee:.04,reason:'sl',at:60200});
 assert.equal(x.engine.closedPositions().length,1);
 const last=x.engine.closedPositions()[0].fills.find(f=>f.reason==='sl')!;
 x.engine.restateOrderFill(last.orderId!,{price:98.75,fee:.05});
 assert.equal(x.engine.reconcileFunding('BTCUSD',.01,100,60150),1);
 assert.equal(x.reads(),before);
 assert.equal(x.engine.closedPositions()[0].exitPrice,98.75);
 assert.equal(x.engine.closedPositions()[0].fills.filter(f=>f.reason==='funding').length,1);
 x.verify();
});

test('rolled back close is removed from cached history and emits no close event',t=>{
 const x=fixture(t,2),p=x.open();x.engine.stats();let closes=0;
 x.engine.on('trade',()=>closes++);
 assert.throws(()=>x.engine.commitDecision(()=>{
  x.engine.adoptExitFill(p.id,{price:99,qty:p.qtyOpen,fee:.02,reason:'sl',at:60100});
  assert.equal(x.engine.closedPositions().length,1);
  throw new Error('abort after close');
 }),/abort after close/);
 assert.equal(closes,0);assert.equal(p.status,'open');
 assert.equal(x.engine.closedPositions().length,0);
 x.verify();
 x.engine.adoptExitFill(p.id,{price:98,qty:p.qtyOpen,fee:.02,reason:'sl',at:60200});
 assert.equal(closes,1);assert.equal(x.engine.closedPositions().length,1);x.verify();
});
