import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {extractEvents} from './extractor.ts';
import {readWillyHtfAlert,WILLY_HTF_MARKET} from './willyHtf.ts';
import {readingOf} from './reading.ts';
import {applyPatches} from '../pine/patches.ts';
import {loadSpecs,SCRIPTS_DIR} from '../config.ts';
import {Db} from '../db.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {saveTracker} from '../incubator/tracker.ts';

const time=1794366000000;
const payload={schema_version:1,event:'order',event_id:`BTCUSD-1-order-${time}`,trade_id:'BTCUSD-1',order_id:'BTCUSD-1',side:'long',ticker:'DELTA:BTCUSD',tf:'15',bar_time:time,type:'market',price:100,entry:100,sl:95,tp1:105,tp2:110,tp3:115,score:75};
const alert=(p:unknown)=>({barIndex:100,time,type:'alert' as const,message:typeof p==='string'?p:JSON.stringify(p)});

test('Willy reader accepts only identified market intents with valid native levels',()=>{
 for(const side of ['long','short']){
  const p={...payload,side,...(side==='short'?{sl:105,tp1:95,tp2:90,tp3:85}:{})};
  const [e]=readWillyHtfAlert(alert(p));assert.equal(e.kind,'entry');assert.equal(e.side,side);
  assert.equal(e.price,p.entry);assert.equal(e.sl,p.sl);assert.deepEqual(e.tp,[p.tp1,p.tp2,p.tp3]);
 }
});
test('Willy simulator lifecycle, pending limits and unstructured text never become trades',()=>{
 for(const event of ['fill','cancel','be','tp1','tp2','tp3','sl','reversal_close','bias','sweep','unknown'])
  assert.equal(readWillyHtfAlert(alert({...payload,event}))[0].kind,'info',event);
 for(const p of [{...payload,type:'limit'},'🟢 LONG ENTRY (limit filled) | Price: 100 | SL: 95','LONG LIMIT PLACED','SHORT ORDER CANCELLED'])
  assert.equal(readWillyHtfAlert(alert(p))[0].kind,'info');
});
test('Willy malformed, stale or inconsistent order payloads fail closed',()=>{
 const changes=[{schema_version:2},{bar_time:time-900000},{event_id:'wrong'},{trade_id:'BTCUSD-2'},{order_id:''},{side:'buy'},
  {entry:101},{sl:100},{sl:null},{tp1:99},{tp2:104},{tp3:110},{score:null},{score:101},{price:'100'}];
 for(const change of changes)assert.equal(readWillyHtfAlert(alert({...payload,...change}))[0].kind,'info',JSON.stringify(change));
 for(const bad of [null,[],1,'invalid JSON'])assert.equal(readWillyHtfAlert(alert(bad))[0].kind,'info');
});
test('configured Willy reading cannot fall back to shapes or duplicate lifecycle messages',()=>{
 const sc=loadSpecs()[WILLY_HTF_MARKET],opts=readingOf(sc,WILLY_HTF_MARKET,900000).extract;
 const a=alert(payload),events=extractEvents([a,a,alert({...payload,event:'fill'}),alert({...payload,event:'sl'})],
  [{title:'Buy',times:[time,time+900000]}],opts);
 assert.equal(events.filter(e=>e.kind==='entry').length,1);assert.equal(events.filter(e=>e.kind==='exit').length,0);
 assert.equal(extractEvents([alert('LONG | Price: 100 | SL: 95')],[],{scannerId:'existing-scanner'})[0].kind,'entry');
});
test('reviewed source bytes remain pinned and new scanners stay disabled for account allocation',()=>{
 const audit=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/family-update-2026-11-11.json`,'utf8'));
 const manifest=JSON.parse(fs.readFileSync(`${SCRIPTS_DIR}/manifest.json`,'utf8')),specs=loadSpecs();
 for(const item of audit){const meta=manifest.find((m:any)=>m.id===item.id);assert(meta);const raw=fs.readFileSync(`${SCRIPTS_DIR}/pine/${meta.file}`);
  assert.equal(createHash('sha256').update(raw).digest('hex'),item.sha256);assert.equal(specs[item.id].enabled,false);assert.equal(specs[item.id].exitMode,'levels');
 }
});
test('BigBeluga adapter emits directions in the existing confirmed trigger and is idempotent',()=>{
 const file='0gfYLkX9-Smart-Money-Bull-Bear-Trap-Detector-Bigbeluga.pine',src=fs.readFileSync(`${SCRIPTS_DIR}/pine/${file}`,'utf8');
 const p=applyPatches(src,file);assert(p.applied.includes('bigbeluga-trap-confirmed-signals'));
 assert.match(p.source,/if barstate\.isconfirmed and array\.size\(activeL\) > 0/);
 assert.match(p.source,/lvl\.trig := true\s+vnedgeTrapLong := vnedgeTrapLong or not lvl\.isHigh\s+vnedgeTrapShort := vnedgeTrapShort or lvl\.isHigh/);
 assert.equal(p.source.match(/alertcondition\(vnedgeTrapLong/g)?.length,1);
 assert.equal(applyPatches(p.source,file).source,p.source);
 assert.throws(()=>applyPatches(src.replace('lvl.trig := true','lvl.trig := false'),file),/review its signal adapter/);
 const sc=loadSpecs()['smart-money-trap-detector'];const opts=readingOf(sc,'smart-money-trap-detector',900000,p.source).extract;
 const evs=extractEvents([{...alert('Confirmed resistance sweep and rejection'),type:'alertcondition',title:'VN EDGE Trap Short'}],[],opts);
 assert.equal(evs[0].side,'short');assert.equal(evs[0].barTime,time);
});
test('new family watch list creates twelve research cells without paper or promotion allocation',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db);
 const def={id:'families-20261111',name:'New families · November 11',scanners:['smart-money-trap-detector',WILLY_HTF_MARKET],symbols:['BTCUSD','ETHUSD','SOLUSD'],tfs:['15m','1h']};
 assert.equal(saveTracker(db,store,def,time).added,12);assert.equal(saveTracker(db,store,def,time+1000).added,0);
 assert.equal(store.list(['tracked']).length,12);assert.equal(store.list(['live','proposed','shadow']).length,0);
 assert.equal(db.get<{n:number}>('SELECT COUNT(*) n FROM positions')!.n,0);
});
