import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULT_CONFIG} from '../config.ts';
import {Db} from '../db.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {ProfileStore,observeHistoricalRun,profileSignature} from './profile.ts';
import {ContractRegistry,scannerContract} from './contracts.ts';
import {ReadinessService} from './readiness.ts';
import type {LoadedScanner} from './registry.ts';
import type {AuthorReviewCatalog} from '../library/authorReview.ts';
import {PaperEngine} from '../paper/engine.ts';
import {PlanComparisons} from '../paper/planComparisons.ts';
import {planSnapshot,planScannerId} from '../paper/executionPlans.ts';

const source='indicator("Test")\nplotshape(close > open, title="Long")',hash=createHash('sha256').update(source).digest('hex');
const scanner:LoadedScanner={id:'s',name:'Test',author:'Willy',source,patched:source,file:'s.pine',patches:[],status:'ok',reason:null,url:'https://www.tradingview.com/script/test/',pub:null,access:null,pineVersion:'6',lines:2,updated:null,overlay:true,category:'Trend',scriptType:'indicator',family:'Test',origin:'tradingview',license:null};
function catalog():AuthorReviewCatalog{return {schema:1,generatedAt:'2026-11-14',scripts:{s:{file:'s.pine',publication:'p',integrationNotes:['Old adapter gap']}},sources:{'s.pine':{sha256:hash,reviewedAt:'2026-11-14',type:'signal-tool',idea:'A confirmed signal',entries:[{marker:'Long',channel:'shape',side:'long',line:2,condition:'close > open'}],notEntries:[],stop:{has:false,how:'None'},targets:{has:false,how:'None'},exit:{has:false,how:'None'},timing:{knownAtClose:true,pivotLagBars:0,lookahead:'none',repaints:false,note:'Confirmed'},claims:[]}},publications:{p:{url:'https://www.tradingview.com/script/test/',author:'Willy',retrievedAt:'2026-11-14',updatedAt:'2026-11-14',version:1,reviewedAt:'2026-11-14',role:'Signal tool',summary:'Signal',requirements:'Bot exits',reviewVersion:1,reviewUpdatedAt:'2026-11-14'}}};}

test('registry pins author conditions to exact bytes and distinguishes review from adapter support',()=>{
 const c=catalog(),r=new ContractRegistry(c),sc={reader:2 as const};
 const good=r.get(scanner,sc);assert.equal(good.summary.sourceStatus,'matches');assert.equal(good.summary.role,'entry');assert.equal(good.author.entries.length,1);
 const changed=r.get({...scanner,source:source+'\n'},sc);assert.equal(changed.summary.sourceStatus,'changed');assert.equal(changed.summary.role,'unresolved');assert.equal(changed.author.entries.length,0);
 const alias=r.get({...scanner,id:'variant',variantOf:'s',variantReason:'Retest only'},sc);assert.equal(alias.summary.sourceStatus,'matches');assert.equal(alias.variant?.reason,'Retest only');
 assert.equal(r.get({...scanner,id:'unregistered'},sc).summary.sourceStatus,'unreviewed');
 c.publications.p.version=2;assert.equal(scannerContract(scanner,sc,undefined,c).summary.publicationStatus,'changed');
});

test('diagnostic contract versions change with reading and exit policy, not allocation; evidence identities stay unchanged',()=>{
 const c=structuredClone(DEFAULT_CONFIG),sc={enabled:true,symbols:['ETHUSD'],timeframes:['15m'],exitMode:'both' as const,reader:1 as const};
 c.scanners.s=sc;const before=JSON.stringify(c),sig=profileSignature(scanner,sc,'15m'),a=scannerContract(scanner,sc,undefined,catalog());
 assert.notEqual(a.summary.contractVersion,scannerContract(scanner,{...sc,reader:2},undefined,catalog()).summary.contractVersion);
 assert.notEqual(a.summary.contractVersion,scannerContract(scanner,{...sc,exitMode:'script'},undefined,catalog()).summary.contractVersion);
 assert.equal(a.summary.contractVersion,scannerContract(scanner,{...sc,enabled:false,symbols:['BTCUSD']},undefined,catalog()).summary.contractVersion);
 assert.equal(profileSignature(scanner,sc,'15m'),sig);assert.equal(JSON.stringify(c),before);
});

test('native capabilities are profile-specific; context does not become an entry adapter and basket is not missing',()=>{
 const c=structuredClone(DEFAULT_CONFIG);c.paper.marginPerTrade=150;c.paper.sizingMode='margin';c.paper.maxStopLossPct=3;
 const id='reactive-trail-system-author-native';c.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both',reader:3};
 const p={id:'native',revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000};
 const snap=planSnapshot(c,p,'hash'),d=scannerContract({...scanner,id},c.scanners[id],snap,catalog());
 assert.ok(d.summary.capabilities.includes('Durable partial exits'));assert.ok(d.summary.capabilities.includes('Causal close-then-open reversal'));
 assert.match(scannerContract({...scanner,id:'bitcoin-almanac'},{reader:3},undefined,catalog()).summary.adapter,/Context/);
 assert.match(scannerContract({...scanner,id:'unknown'},{reader:3},undefined,catalog()).summary.adapter,/Unsupported/);
 const basket=scannerContract(scanner,{reader:2},{...snap,basket:'rsi-volume-ladder-v1'},catalog());assert.equal(basket.summary.adapter,'RSI basket adapter');
 assert.ok(!basket.summary.gaps.some(x=>x.includes('lifecycle parity')));
 const ml=scannerContract({...scanner,id:'machine-learning-rsi-ai-classification-ranking-zeiierman'},{reader:2},undefined,catalog());assert.ok(ml.summary.gaps.some(x=>x.includes('flip markers')));
});

test('context, manual and external-data reviews cannot silently advertise complete trading support',()=>{
 const c=catalog();c.sources['s.pine'].type='context-only';
 const ctx=scannerContract(scanner,{},undefined,c);assert.equal(ctx.summary.role,'context');assert.ok(ctx.summary.gaps.some(g=>g.includes('autonomous entries')));
 assert.ok(!scannerContract(scanner,{sources:[]},undefined,c).summary.gaps.some(g=>g.includes('autonomous entries')));
 c.publications.p.role='Manual / restricted';assert.equal(scannerContract(scanner,{},undefined,c).summary.role,'manual');
 const external=scannerContract({...scanner,patched:source+'\nx=request.security("BTCUSD", "1h", close)'},{},undefined,c);
 assert.ok(external.dependencies.length);assert.ok(external.summary.gaps.some(g=>g.includes('data-availability')));
});

test('readiness separates quiet scans, cell failures and exact plan evidence without writing settings or database',async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.marginPerTrade=150;cfg.incubator.enabled=true;
 cfg.scanners={s:{enabled:true,symbols:['ETHUSD'],timeframes:['15m'],exitMode:'both',reader:1},empty:{enabled:true,symbols:null,timeframes:null,exitMode:'both'}};
 cfg.executionPlans=[{id:'compare',revision:1,enabled:true,scannerId:'s',symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1,reader:2}}];
 const emptyScanner={...scanner,id:'empty'},registry={get:(id:string)=>[scanner,emptyScanner].find(s=>s.id===id),all:()=>[scanner,emptyScanner]};
 const profiles=new ProfileStore(db),store=new IncubatorStore(db),paper=new PaperEngine(db,()=>cfg,{book:2});new PlanComparisons(db,()=>cfg,paper,()=>hash);
 const now=1_800_000_000_000;
 store.move({scannerId:'s',symbol:'SOLUSD',tf:'15m'},'shadow','test');store.move({scannerId:'s',symbol:'BTCUSD',tf:'1h'},'tracked','test');
 store.noteShadowScan({scannerId:'s',symbol:'SOLUSD',tf:'15m'},now-900000,'failed','missing depth',0,now-1000);
 db.run('INSERT INTO scanner_runs(scanner_id,symbol,tf,at,ms) VALUES(?,?,?,?,1)','s','ETHUSD','15m',now-1000);
 const prof=observeHistoricalRun(scanner,cfg.scanners.s,'ETHUSD','15m',[],{id:1,ok:true,ms:1,bars:1,lastBarTime:0,warnings:0,alerts:[],shapes:[],labels:[],plots:[]},'test',now-1000).profile;profiles.save(prof);
 const current=planSnapshot(cfg,cfg.executionPlans[0],hash),currentId=planScannerId(current);
 db.run("INSERT INTO execution_plan_scans VALUES('old-cohort',?,?,9,0,'[]')",now-900000,now-1000);
 db.run("INSERT INTO execution_plan_events(at,plan_id,scanner_id,source_event,action,reason) VALUES(?,?,?,?,?,?)",now-1000,'compare','old-cohort','old','rejected','old refusal');
 const deps={db,registry,config:{get:()=>cfg},profiles,incubatorStore:store,scanners:{},shadow:{},sourceHashFor:()=>hash};
 const svc=new ReadinessService(deps as any,new ContractRegistry(catalog()));
 const before=JSON.stringify(cfg),changes=db.get<{n:number}>('SELECT total_changes() n')!.n,view=await svc.view(now);
 assert.equal(view.summary.scanners,2);assert.equal(view.summary.plans,1);
 const base=view.rows.find(r=>r.key==='s')!,plan=view.rows.find(r=>r.planId==='compare')!;
 assert.equal(base.runtime,'collecting');assert.equal(base.activity.signals,0);assert.equal(base.cells.find(c=>c.symbol==='SOLUSD')!.state,'failed');
 assert.equal(base.profiles.matching,1);assert.equal(plan.profiles.matching,0);assert.equal(plan.runtime,'waiting');assert.equal(plan.activity.signals,0);assert.match(plan.policy.promotion,/excluded/);
 assert.equal(view.rows.find(r=>r.key==='empty')!.runtime,'unallocated');
 assert.equal(svc.detail('s','unknown'),null);assert.equal(svc.detail('empty','compare'),null);assert.equal(svc.detail('s','compare')!.summary.reader,2);
 assert.equal(db.get<{n:number}>('SELECT total_changes() n')!.n,changes);assert.equal(JSON.stringify(cfg),before);
 db.run("INSERT INTO execution_plan_scans VALUES(?,?,?,1,0,'[]')",currentId,now-900000,now-1000);
 db.run("INSERT INTO execution_plan_events(at,plan_id,scanner_id,source_event,action,reason) VALUES(?,?,?,?,?,?)",now-1000,'compare',currentId,'new','rejected','fee cost');
 const fresh=await svc.view(now+61000),p=fresh.rows.find(r=>r.planId==='compare')!;assert.equal(p.runtime,'collecting');assert.equal(p.activity.signals,1);assert.deepEqual(p.activity.reasons,{'fee cost':1});
 store.noteShadowScan({scannerId:'s',symbol:'ETHUSD',tf:'15m'},now,'running',null,0,now+62000);
 assert.equal(await svc.view(now+63000),fresh,'automatic requests retain the bounded cache');
 const [running,joined]=await Promise.all([svc.view(now+63000,true),svc.view(now+63001,true)]);
 assert.equal(running,joined,'concurrent refreshes share one build');
 const inFlight=running.rows.find(r=>r.planId==='compare')!;
 assert.equal(inFlight.runtime,'scanning');assert.equal(inFlight.cells[0].state,'running');
 assert.equal(inFlight.cells[0].lastAt,now-1000,'running source does not invent a completed plan receipt');
 assert.equal(inFlight.activity.signals,1);assert.equal(inFlight.activity.fills,0);
 cfg.incubator.enabled=false;const held=await svc.view(now+122000,true);assert.equal(held.rows.find(r=>r.planId==='compare')!.runtime,'held');
});

test('contract registry defers research IO and invalidates cached details after catalogue recovery',()=>{
 let calls=0,current:AuthorReviewCatalog={schema:1,generatedAt:'',scripts:{},sources:{},publications:{},unavailableReason:'Catalogue unavailable'};
 const registry=new ContractRegistry(undefined,()=>{calls++;return current;});
 assert.equal(calls,0,'constructing API services does not read the catalogue');
 const unavailable=registry.get(scanner,{});
 assert.equal(unavailable.summary.role,'unresolved');assert.ok(unavailable.summary.gaps.includes('Catalogue unavailable'));
 current=catalog();
 const recovered=registry.get(scanner,{});
 assert.equal(recovered.summary.role,'entry');assert.equal(recovered.author.entries.length,1);
 assert.ok(!recovered.summary.gaps.includes('Catalogue unavailable'));
 assert.equal(registry.get(scanner,{}),recovered,'unchanged versions retain the cache');
});
