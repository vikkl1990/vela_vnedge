import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IntrabarFlow} from './intrabar.ts';
const T=1800000000000;
function setup(){const f=new IntrabarFlow();f.observeSymbols(['BTCUSD','PARTIUSD'],T);f.connection(true,T);return f;}
const print=(at:number,side:'buy'|'sell'='sell',id=String(at))=>({symbol:'BTCUSD',price:100,qty:2,timeMs:at,aggressor:side,id});
test('rolling flow separates quiet coverage from directional flow and requires warmup',()=>{
 const f=setup();assert.equal(f.snapshot('BTCUSD',T+59000).covered,false);
 f.onTrade(print(T+60000),T+60000);f.onTrade(print(T+61000,'buy'),T+61000);
 const s=f.snapshot('BTCUSD',T+62000);assert.equal(s.covered,true);assert.equal(s.windows.s15.trades,2);assert.equal(s.windows.s15.imbalance,0);
 assert.equal(f.snapshot('PARTIUSD',T+62000).covered,true);assert.equal(f.snapshot('PARTIUSD',T+62000).windows.s15.imbalance,null);
 assert.equal(f.snapshot('BTCUSD',T+77000).windows.s15.trades,0);
});
test('duplicates, snapshots, unknown side, late and future timestamps cannot create protection',()=>{
 for(const patch of [{timeKnown:false},{aggressor:null},{timeMs:T+50000},{timeMs:T+60001}]){
  const f=setup();f.onTrade({...print(T+60000),...patch},T+60000);assert.equal(f.snapshot('BTCUSD',T+60000).covered,false);
 }
 const f=setup();f.onTrade(print(T+60000),T+60000);f.onTrade(print(T+60000),T+61000);assert.equal(f.snapshot('BTCUSD',T+61000).windows.s60.trades,1);
});
test('disconnects and execution-loop stalls discard backlog and require a fresh minute',()=>{
 const f=setup();f.pulse(T+60000);f.onTrade(print(T+60000),T+60000);f.pulse(T+65000);
 assert.equal(f.snapshot('BTCUSD',T+65000).covered,false);assert.equal(f.snapshot('BTCUSD',T+65000).windows.s60.trades,0);
 f.connection(false,T+66000);assert.equal(f.snapshot('BTCUSD',T+130000).covered,false);f.connection(true,T+130000);assert.equal(f.snapshot('BTCUSD',T+189999).covered,false);
 assert.equal(f.snapshot('BTCUSD',T+190000).covered,true);
});
