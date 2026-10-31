import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ExchangeExecutor } from './testnet.ts';
import type { ExchangeOrder, OrderPayload } from './client.ts';

class Exchange {
  host='testnet' as const; hasAuth=true; dryRun=false; baseUrl='fake://';
  orders=new Map<string,ExchangeOrder>(); posts:OrderPayload[]=[];
  hidden=false; timeout=false; missing=false; price=101; fee=.4;
  async products():Promise<Map<string,any>> {return new Map(this.missing?[]:[['BTCUSD',{id:27,symbol:'BTCUSD'}]]);}
  async wallet(){return [];}
  async positions(){return [];}
  async openOrders(){return [...this.orders.values()].filter(o=>o.state==='open');}
  async setLeverage(_id:number,leverage:number){return {leverage};}
  async placeOrder(p:OrderPayload){
    this.posts.push(p);const id=this.posts.length,rest=!!p.stop_order_type||p.order_type==='limit_order';
    this.orders.set(String(id),{...p,id,state:rest?'open':'closed',unfilled_size:rest?p.size:0,average_fill_price:rest?null:this.price,paid_commission:rest?null:this.fee});
    if(this.timeout){this.timeout=false;throw Error('timeout after acceptance');}return {id,state:rest?'open':'closed'};
  }
  async order(id:number|string){return this.hidden?null:this.orders.get(String(id))??null;}
  async orderByClientId(id:string){return this.hidden?null:[...this.orders.values()].find(o=>o.client_order_id===id)??null;}
  async cancelOrder(id:number|string,_product:number){const o=this.orders.get(String(id));if(o?.state==='open')o.state='cancelled';return {};}
  async cancelAll(_p:number){return {};}
  async editOrder(o:any){const r=this.orders.get(String(o.id));if(r)Object.assign(r,o);return {id:o.id};}
}
function fixture(t:any,bracket=false){
  const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper,{slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,fillSource:'candles',latencyMs:0});
  Object.assign(cfg.execution,{mode:'testnet',bracket,reconcileSec:0,sweepSec:0});
  const clock={t:1000},paper=new PaperEngine(db,()=>cfg),fake=new Exchange();
  const executor=()=>{const ex=new ExchangeExecutor(paper,()=>cfg,fake,{now:()=>clock.t,confirmSec:0,reconcileSec:0,sweepSec:0});t.after(()=>ex.stop());return ex;};
  const open=()=>paper.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},
    {scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:60010,signalId:null,exitMode:'both'}).position!;
  return {db,cfg,clock,paper,fake,executor,open};
}

test('fill and command roll back together; observers cannot send a rolled-back entry',async t=>{
  const {db,paper,fake,executor,open}=fixture(t);const ex=executor();await ex.start();
  assert.throws(()=>paper.commitDecision(()=>{open();assert.equal(ex.outbox.status().pending,1);throw Error('decision interrupted');}));
  await ex.flush();assert.equal(db.get<any>('SELECT count(*) n FROM orders').n,0);
  assert.equal(ex.outbox.status().pending,0);assert.equal(paper.openPositions().length,0);assert.equal(fake.posts.length,0);
});
test('a failed durable write rolls back the paper fill instead of silently losing execution',async t=>{
  const {db,paper,fake,executor,open}=fixture(t);const ex=executor();await ex.start();
  db.db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON execution_commands BEGIN SELECT RAISE(ABORT,'disk write failed'); END");
  assert.throws(()=>paper.commitDecision(()=>open()),/disk write failed/);await ex.flush();
  assert.equal(db.get<any>('SELECT count(*) n FROM orders').n,0);assert.equal(paper.openPositions().length,0);assert.equal(fake.posts.length,0);
});
test('a committed fill before start is dispatched once, and repeated startup never replays it',async t=>{
  const {fake,executor,open}=fixture(t);const ex=executor();const p=open();
  assert.equal(ex.outbox.status().pending,1);assert.equal(fake.posts.length,0);
  await ex.start();await ex.start();await ex.sweepNow();await ex.flush();
  assert.equal(fake.posts.length,1);assert.equal(p.entryPrice,101);assert.equal(ex.outbox.status().delivered,1);
  ex.stop();const restarted=executor();await restarted.start();assert.equal(fake.posts.length,1);
});
test('a missed order event is recovered from the command table on sweep',async t=>{
  const {paper,fake,executor,open}=fixture(t);const ex=executor();await ex.start();
  paper.removeAllListeners('order');open();assert.equal(fake.posts.length,0);
  await ex.sweepNow();await ex.flush();assert.equal(fake.posts.length,1);assert.equal(ex.outbox.status().pending,0);
});
test('an unsent entry expires while exits remain recoverable',async t=>{
  const {paper,fake,executor,open,clock}=fixture(t);const ex=executor();open();clock.t+=61000;
  await ex.start();assert.equal(fake.posts.length,0);assert.equal(paper.openPositions().length,0);assert.equal(ex.outbox.status().cancelled,1);
});
test('entry and exit completed on paper before dispatch do not create transient exchange exposure',async t=>{
  const {paper,fake,executor,open}=fixture(t);const ex=executor();const p=open();paper.closeManual(p.id);
  await ex.start();assert.equal(fake.posts.length,0);assert.equal(ex.outbox.status().pending,0);
});
test('plain paper history is never imported when an executor is attached',async t=>{
  const {db,fake,executor,open}=fixture(t);open();assert.equal(db.get<any>('SELECT count(*) n FROM execution_commands').n,0);
  const ex=executor();await ex.start();assert.equal(fake.posts.length,0);assert.equal(ex.lastRecovery?.unmirrored.length,1);
});
test('an unavailable catalog retains a command and retries once metadata returns',async t=>{
  const {fake,executor,open}=fixture(t);fake.missing=true;const ex=executor();open();await ex.start();
  assert.equal(ex.outbox.status().pending,1);assert.equal(fake.posts.length,0);
  fake.missing=false;await ex.sweepNow();await ex.flush();assert.equal(fake.posts.length,1);assert.equal(ex.outbox.status().pending,0);
});
test('accepted timeout and a later exit reconcile before closing; entry is never posted twice',async t=>{
  const {paper,fake,executor,open}=fixture(t);const ex=executor();await ex.start();fake.hidden=true;fake.timeout=true;
  const p=open();await ex.flush();assert.equal(fake.posts.length,1);assert.equal(ex.status().unconfirmed.length,1);
  paper.closeManual(p.id);await ex.flush();assert.equal(fake.posts.length,1);assert.equal(ex.outbox.status().pending,1);
  fake.hidden=false;await ex.sweepNow();await ex.flush();await ex.sweepNow();
  assert.equal(fake.posts.filter(o=>o.purpose==='entry').length,1);assert.equal(fake.posts.filter(o=>o.purpose==='exit').length,1);
  assert.equal(ex.outbox.status().pending,0);assert.equal(ex.status().exposure[p.id]??0,0);
});
test('dry-run commands and ledgers are not adopted by a real writer on the same host',async t=>{
  const {fake,executor,open}=fixture(t);fake.dryRun=true;const dry=executor();open();await dry.start();dry.stop();
  assert.equal(dry.ledger.recent().length,1);fake.dryRun=false;const real=executor();await real.start();
  assert.equal(real.ledger.recent().length,0);assert.equal(real.outbox.status().delivered,0);assert.equal(fake.posts.length,1);
});
test('exchange-adopted fills and funding do not produce commands to echo back',async t=>{
  const {paper,executor,open}=fixture(t);const ex=executor();await ex.start();const p=open();await ex.flush();
  (ex as any).adopt(p.id,()=>paper.adoptExitFill(p.id,{qty:10,price:103,fee:0,reason:'tp1',at:61000}));
  await ex.flush();assert.equal(ex.outbox.status().recent.length,1);
});
test('a paper TP committed before restart is reconciled to its resting fill without subtracting quantity twice',async t=>{
  const {paper,fake,executor,open}=fixture(t,true);const ex=executor();await ex.start();const p=open();await ex.flush();
  ex.stop();const tp=[...fake.orders.values()].find(o=>o.order_type==='limit_order')!;
  tp.state='closed';tp.unfilled_size=0;tp.average_fill_price=105.25;tp.paid_commission=.2;
  paper.onBar('BTCUSD',{time:120000,high:106,low:100,close:105.5},120010);
  const remaining=p.qtyOpen;assert.equal(ex.outbox.status().pending,1);
  const restarted=executor();await restarted.start();await restarted.flush();
  assert.equal(p.qtyOpen,remaining);assert.equal(fake.posts.filter(o=>o.purpose==='exit').length,0);
  assert.equal(p.fills.filter(f=>f.reason==='tp1').length,1);assert.equal(p.fills.find(f=>f.reason==='tp1')?.price,105.25);
  assert.equal(restarted.outbox.status().pending,0);
});

test('closing a paper trade while leverage is loading cannot send its stale entry',async t=>{
  const {paper,fake,executor,open}=fixture(t);const ex=executor();await ex.start();
  let release!:()=>void, entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  fake.setLeverage=async(_id,leverage)=>{entered();await new Promise<void>(r=>release=r);return{leverage};};
  const p=open();await waiting;paper.closeManual(p.id);release();await ex.flush();
  assert.equal(fake.posts.length,0);assert.equal(ex.outbox.status().pending,0);
});
test('flatten cancels unsent entries so catalog recovery cannot reopen the account',async t=>{
  const {fake,executor,open}=fixture(t);fake.missing=true;const ex=executor();await ex.start();open();await ex.flush();
  assert.equal(ex.outbox.status().pending,1);await ex.closeAll({confirm:true});fake.missing=false;
  await ex.sweepNow();await ex.flush();assert.equal(fake.posts.length,0);assert.equal(ex.outbox.status().cancelled,1);
});
