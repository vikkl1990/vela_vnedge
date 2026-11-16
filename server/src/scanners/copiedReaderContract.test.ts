import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigStore,DEFAULT_CONFIG,PINE_DIR,loadSpecs} from '../config.ts';
import {extractEvents} from './extractor.ts';
import {readingOf} from './reading.ts';
import {Db} from '../db.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {bookPaperConfig} from '../paper/policy.ts';

const id='band-walk';
const titles=['Bullish Band Walk Started','Bearish Band Walk Started','Bullish Midline Pullback','Bearish Midline Pullback','Bullish Band Walk Ended','Bearish Band Walk Ended'];
const events=titles.map((title,i)=>({type:'alertcondition' as const,title,message:title,time:1700000000000+i*3600000,barIndex:i}));
const brief=(xs:ReturnType<typeof extractEvents>)=>xs.map(e=>[e.kind,e.side,e.label]);

test('Band Walk contract excludes lifecycle endings while retaining every original Started and Pullback entry',()=>{
 const source=fs.readFileSync(path.join(PINE_DIR,'LIB94757-Band-Walk-LuxAlgo.pine'),'utf8');
 assert.equal(createHash('sha256').update(source).digest('hex'),'bc8f860f398b9163fc36009a51bb8121a416a7cfb77458ac0bdfc58a4210e98c','review the source contract before accepting an upstream change');
 for(const title of titles)assert.ok(source.includes('"'+title+'"'));
 const old=extractEvents(events,[],readingOf({},id,3600000,source).extract);
 const current=extractEvents(events,[],readingOf(loadSpecs()[id],id,3600000,source).extract);
 assert.equal(old.length,6,'reproduce BTC trade 18809 legacy ending-as-entry defect');
 assert.deepEqual(brief(current),brief(old.slice(0,4)));
 assert.equal(current.some(e=>e.label.includes('Ended')),false);
 assert.deepEqual(extractEvents([], [{title:'Bearish Band Walk Ended',times:[1700000000000],shape:'triangledown',location:'abovebar'}],readingOf(loadSpecs()[id],id,3600000).extract),[]);
});

test('copied-only Band Walk inherits its contract without enabling account allocation or changing risk',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'band-reader-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw={paper:{marginPerTrade:150,maxStopLossPct:3},scanners:{}};
 fs.writeFileSync(file,JSON.stringify(raw));const before=fs.readFileSync(file,'utf8');
 const cfg=new ConfigStore(file).get();
 assert.equal(cfg.scanners[id].enabled,false);
 assert.equal(cfg.scanners[id].reader,2);
 assert.equal(cfg.paper.marginPerTrade,150);
 assert.equal(cfg.paper.maxStopLossPct,3);
 assert.deepEqual(cfg.risk,DEFAULT_CONFIG.risk);
 assert.deepEqual(cfg.incubator,DEFAULT_CONFIG.incubator);
 assert.equal(fs.readFileSync(file,'utf8'),before,'loading defaults cannot rewrite persisted configuration');
});

test('the corrected copy starts distinct evidence while unrelated scanners and the stored old record stay unchanged',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:id,symbol:'BTCUSD',tf:'1h'};
 const legacy=resolveTradePolicy({...cfg,paper:bookPaperConfig(cfg,'shadow')},cell,'same-source',2);
 saveTradePolicy(db,legacy);
 const unrelated=resolveTradePolicy(cfg,{...cell,scannerId:'other'},'other-source');
 const at=Date.now(),store=new IncubatorStore(db);
 db.run("INSERT INTO incubator_pairs(scanner_id,symbol,tf,stage,since,updated) VALUES(?,?,?,'shadow',?,?)",id,cell.symbol,cell.tf,at-86400000,at);
 for(let n=0;n<5;n++)db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt,policy_id,evidence_scope) VALUES('closed',?,?,?,?,'short',1,0,1,100,?,?,1,0,1,2,?,'shadow')",id,id,cell.symbol,cell.tf,at-20000+n*100,at-19000+n*100,legacy.id);
 const mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:0},pair=store.find(id,cell.symbol,cell.tf)!;
 store.policyFor=()=>resolveTradePolicy(cfg,cell,'same-source');
 assert.equal(store.copyRefusal(pair,mirror,10000000,at,{readOnly:true}),null);
 cfg.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both',...loadSpecs()[id]};
 const corrected=resolveTradePolicy(cfg,cell,'same-source');
 assert.notEqual(corrected.strategyId,legacy.strategyId);
 assert.match(store.copyRefusal(pair,mirror,10000000,at,{readOnly:true})!,/0\/5/);
 assert.equal(resolveTradePolicy(cfg,{...cell,scannerId:'other'},'other-source').id,unrelated.id);
 assert.equal(db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',legacy.id)!.snapshot,JSON.stringify(legacy));
 assert.equal(db.get<{n:number}>('SELECT count(*) n FROM evidence_restorations')!.n,0);
});
