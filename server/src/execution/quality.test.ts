import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {FundingJournal} from './fundingJournal.ts';
import {DepthRecorder,crc32} from './depthRecorder.ts';
import {AccountAudit} from './accountAudit.ts';
import {DeltaRest} from '../delta/rest.ts';
import {wirePayload,assertProductionSafe} from './client.ts';
import {applyFundingSettlement} from '../paper/logic.ts';
const T=1_800_000_000_000;
function db(t:any){const d=new Db(':memory:');t.after(()=>d.db.close());return d;}
const f=(nextAt=T,timeMs=T-1000)=>({symbol:'BTCUSD',ratePct:.01,predictedRatePct:null,intervalSec:3600,nextAt,timeMs});
test('funding survives restart, ignores late rates, applies once with boundary mark',t=>{
 const d=db(t),j=new FundingJournal(d);j.observe(f());j.mark({symbol:'BTCUSD',markPrice:100,timeMs:T,bestBid:null,bestAsk:null});
 j.observe({...f(T+3600000,T+1000),ratePct:99});
 const resumed=new FundingJournal(d);const calls:any[]=[];resumed.settle(T+11000,(...x)=>calls.push(x));resumed.settle(T+12000,(...x)=>calls.push(x));
 assert.deepEqual(calls,[['BTCUSD',.01,100,T]]);
});
test('missing intervals remain unresolved and do not borrow current rates',t=>{
 const d=db(t),j=new FundingJournal(d);j.observe(f());j.observe(f(T+7200000,T+3601000));j.settle(T+3611000,()=>assert.fail('unverified payment'));
 assert.equal(d.get<any>("SELECT count(*) n FROM funding_settlements WHERE status='unresolved'")!.n,2);
 j.verify('BTCUSD',T,.02,100,'verified settlement statement');let n=0;j.settle(T+3611000,()=>n++);assert.equal(n,1);
 assert.throws(()=>j.verify('BTCUSD',T,.02,100,'verified settlement statement'),/already applied/);
});
test('failed funding callback retries without falsely marking applied',t=>{
 const j=new FundingJournal(db(t));j.verify('BTCUSD',T,0,100,'zero rate statement');assert.throws(()=>j.settle(T+11000,()=>{throw Error('disk');}));let n=0;j.settle(T+12000,()=>n++);assert.equal(n,1);
});
test('late funding reconstructs earlier quantity even after full close',()=>{
 const p:any={entryAt:T-100,exitAt:T+100,qty:10,qtyOpen:0,contractValue:1,side:'long',realizedPnl:10,fills:[{at:T-10,qty:3,reason:'tp1'},{at:T+100,qty:7,reason:'sl'}]};
 assert.ok(Math.abs(applyFundingSettlement(p,1,100,T)!.pnl+7)<1e-9);assert.ok(Math.abs(p.realizedPnl-3)<1e-9);assert.equal(applyFundingSettlement(p,1,100,T),null);assert.equal(applyFundingSettlement(p,1,100,T+100),null);
});
test('depth verifies checksum, sequence, deletion and rejects stale data',t=>{
 const d=db(t),retry:string[]=[];const r=new DepthRecorder(d,['BTCUSD'],s=>retry.push(s));assert.equal(crc32('123456789'),3421780262);
 const snap={sy:'BTCUSD',action:'snapshot',seq:1,ts:T*1000,a:[['101.00','3']],b:[['99.00','2']],cs:crc32('101.00:3|99.00:2')};
 r.onDepth(snap,T);assert.deepEqual(r.summary().validBooks,['BTCUSD']);
 r.onDepth({...snap,action:'update',seq:2,a:[['101.00','0'],['102.00','1']],b:[],cs:crc32('102.00:1|99.00:2')},T);
 assert.deepEqual(r.summary().validBooks,['BTCUSD']);r.onDepth({...snap,action:'update',seq:4},T);assert.equal(r.summary().validBooks.length,0);assert.equal(retry.length,1);
 r.onDepth(snap,T+20000);assert.equal(r.summary().validBooks.length,0);r.flush(T+20000);assert.equal(d.get<any>("SELECT count(*) n FROM depth_tape WHERE kind='gap'")!.n,2);
 r.flush(T+86430000);assert.equal(r.summary().stored!.n,0);
});
test('account history deduplicates pages, uses microseconds and rejects looping cursors',async()=>{
 const rest=new DeltaRest();const calls:any[]=[];let n=0;(rest as any).request=async(...args:any[])=>{calls.push(args);return n++===0?{result:[{id:'a'}],meta:{after:'next'}}:{result:[{id:'a'},{id:'b'}],meta:{}};};
 assert.equal((await rest.accountHistory('fills',T,T+1000)).length,2);assert.equal(calls[0][2].query.start_time,T*1000);assert.equal(calls[1][2].query.after,'next');
 (rest as any).request=async()=>({result:[],meta:{after:'loop'}});await assert.rejects(rest.accountHistory('wallet',T,T+1000),/repeated/);
});
test('audit commits both histories atomically, deduplicates and omits private metadata',async t=>{
 const d=db(t),a=new AccountAudit(d);let fail=true;
 const transport:any={hasAuth:true,dryRun:false,host:'testnet',accountHistory:async(kind:string)=>{if(kind==='wallet'&&fail)throw Error('timeout');return [{id:kind,order_id:1,size:2,price:100,commission:'.2',settling_asset_symbol:'USD',created_at:T*1000,meta_data:{ip:'private'}}];}};
 await assert.rejects(a.sync(transport,T+1000));assert.equal(d.get<any>('SELECT count(*) n FROM exchange_history')!.n,0);fail=false;await a.sync(transport,T+1000);await a.sync(transport,T+2000);
 assert.equal(d.get<any>('SELECT count(*) n FROM exchange_history')!.n,2);assert.ok(!JSON.stringify(a.summary()).includes('private'));
});
test('post-only serializes only valid limits and preserves production restriction',()=>{
 const o:any={product_id:1,size:1,side:'buy',order_type:'limit_order',limit_price:'100',post_only:true,time_in_force:'gtc',purpose:'entry'};
 assert.equal(wirePayload(o).post_only,true);assert.equal(wirePayload(o).purpose,undefined);
 for(const patch of [{order_type:'market_order'},{time_in_force:'ioc'},{limit_price:'Infinity'},{limit_price:'0'}])assert.throws(()=>wirePayload({...o,...patch}),/post-only/);
 assert.throws(()=>assertProductionSafe(o));
});

test('verified funding evidence cannot be overwritten by live estimates',t=>{
 const d=db(t),j=new FundingJournal(d);j.verify('BTCUSD',T,.02,123,'verified settlement statement');
 j.observe(f());j.mark({symbol:'BTCUSD',markPrice:99,timeMs:T,bestBid:null,bestAsk:null});
 let actual:any;j.settle(T+11000,(...x)=>actual=x);assert.deepEqual(actual,['BTCUSD',.02,123,T]);
});
