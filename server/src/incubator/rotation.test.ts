import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {shadowCapacity} from './capacity.ts';
import {admitOnly, candidateBlockers, evaluate} from './cycle.ts';
const DAY=86400_000, now=Date.UTC(2026,9,31,10);
function world(){
 const db=new Db(':memory:'), store=new IncubatorStore(db), cfg=structuredClone(DEFAULT_CONFIG);
 cfg.incubator.maxShadow=1;cfg.incubator.admit.reserve=[];cfg.incubator.gate.pool='pair';cfg.incubator.admit.maxPerScannerTf={'15m':5,'4h':5};
 cfg.incubator.admit.rotation={enabled:true,maxPerDay:1,idleDaysByTf:{'15m':7,'4h':28},cooldownDays:3};
 const pair=(id:string,tf='15m',stage:'shadow'|'candidate'='shadow',age=8)=>{
  const p=store.move({scannerId:id,symbol:'ETHUSD',tf},stage,'test',null,null,now-age*DAY);
  db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({pass:true,at:now,trades:40,profitFactor:2,avgR:.2,days:20,fill:'close'}),p.id);
  const marks=store.liveMarks()??{}; marks[`${id}:ETHUSD:${tf}`]=now-900_000;store.setLiveMarks(marks);
  return store.get(p.id)!;
 };
 const pos=(p:ReturnType<typeof pair>,status='closed')=>db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt) VALUES (?,?,?,?,?,'long',1,?,1,100,?,?,0,1,10,2)",status,p.scannerId,p.scannerId,p.symbol,p.tf,status==='open'?1:0,now-DAY,now-1000);
 return {db,store,cfg,pair,pos};
}
test('capacity counts overlapping reserves once and reports genuine general overflow',()=>{
 const {cfg}=world();cfg.incubator.maxShadow=2;cfg.incubator.admit.reserve=[{tfs:['4h'],markets:['ETHUSD'],slots:1},{tfs:['4h'],slots:2}];
 const c=shadowCapacity([{id:1,symbol:'ETHUSD',tf:'4h'},{id:2,symbol:'ETHUSD',tf:'4h'},{id:3,symbol:'SOLUSD',tf:'4h'},...['15m','15m','15m'].map((tf,i)=>({id:i+4,symbol:'ETHUSD',tf}))],cfg.incubator);
 assert.equal(c.total,5);assert.equal(c.used,6);assert.equal(c.overflow,1);assert.equal(c.free,0);assert.deepEqual(c.reserves.map(r=>r.used),[1,2]);
});
test('rotation replaces an idle cell atomically, audits it, respects cooldown and UTC daily budget',()=>{
 const {store,cfg,pair}=world();const old=pair('old'),next=pair('next','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),['next ETHUSD 15m']);
 assert.equal(store.get(old.id)!.stage,'candidate');assert.equal(store.get(old.id)!.since,old.since);
 assert.equal(store.get(next.id)!.stage,'shadow');assert.equal(store.get(next.id)!.since,now);
 assert.equal(store.rotationState().used,1);assert.equal(candidateBlockers(store,cfg,now).counts.cooldown,1);
 pair('wait','15m','candidate',10);assert.deepEqual(admitOnly(store,cfg,now+1000),[]);
 assert.equal(store.list(['shadow']).length,1);assert.ok(store.events(10).some(e=>e.actor==='rotation'));
});
for(const status of ['open','pending','closed']) test(`rotation protects ${status} positions, including losing forward evidence`,()=>{
 const {store,cfg,pair,pos}=world();const old=pair('old');pos(old,status);pair('wait','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(store.get(old.id)!.stage,'shadow');
});
test('rotation needs recent successful execution and an eligible replacement',()=>{
 const {store,cfg,pair,db}=world();const old=pair('old'),next=pair('next','15m','candidate',10);
 store.setLiveMarks({});assert.deepEqual(admitOnly(store,cfg,now),[]);
 store.setLiveMarks({'old:ETHUSD:15m':now-900_000});
 db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({...next.screen,expiredAt:now}),next.id);
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(candidateBlockers(store,cfg,now).counts.expired,1);
 assert.equal(store.get(old.id)!.stage,'shadow');
});
test('4h reservations cannot be stolen by a waiting 15m cell',()=>{
 const {store,cfg,pair}=world();cfg.incubator.maxShadow=0;cfg.incubator.admit.reserve=[{tfs:['4h'],slots:1}];
 const old=pair('old','4h','shadow',29);pair('fast','15m','candidate',30);
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(store.get(old.id)!.stage,'shadow');
 const next=pair('swing','4h','candidate',30);assert.deepEqual(admitOnly(store,cfg,now),['swing ETHUSD 4h']);assert.equal(store.get(next.id)!.stage,'shadow');
});
test('unavailable and capped replacement scanners cannot trigger rotation',()=>{
 const {store,cfg,pair}=world();pair('old');pair('wait','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now,{unavailable:id=>id==='wait'?'quarantined':null}),[]);
 cfg.incubator.admit.maxPerScannerTf!['15m']=0;assert.deepEqual(admitOnly(store,cfg,now),[]);
});
test('a failing swap rolls back both allocations and its budget',()=>{
 const {store,cfg,pair,db}=world();const old=pair('old'),next=pair('next','15m','candidate',10);
 db.db.exec("CREATE TRIGGER reject_rotation BEFORE UPDATE OF stage ON incubator_pairs WHEN NEW.scanner_id='next' AND NEW.stage='shadow' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
 assert.throws(()=>admitOnly(store,cfg,now),/test rollback/);
 assert.equal(store.get(old.id)!.stage,'shadow');assert.equal(store.get(next.id)!.stage,'candidate');assert.equal(store.rotationState().used,0);
});
for(const status of ['open','pending']) test(`automatic retirement defers for a ${status} shadow position`,()=>{
 const {store,cfg,pair,pos}=world();const old=pair('old','15m','shadow',100);pos(old,status);
 cfg.incubator.admit.rotation!.enabled=false;
 const r=evaluate(store,cfg,now,{unavailable:()=> 'quarantined'});
 assert.equal(store.get(old.id)!.stage,'shadow');assert.ok(!r.retired.includes('old ETHUSD 15m'));
});
test('blocker explanation and actual admission both give reservations precedence over scanner caps',()=>{
 const {db,store,cfg,pair}=world();cfg.incubator.admit.rotation!.enabled=false;cfg.incubator.admit.maxPerScannerTf!['4h']=1;cfg.incubator.maxShadow=1;
 cfg.incubator.admit.reserve=[{tfs:['4h'],markets:['ETHUSD'],slots:1}];
 const reserved=pair('same','4h','candidate',1);
 const alt=store.move({scannerId:'same',symbol:'SOLUSD',tf:'4h'},'candidate','test',null,null,now-DAY);
 db.run('UPDATE incubator_pairs SET screen=? WHERE id=?',JSON.stringify({...reserved.screen,profitFactor:10}),alt.id);
 const before=candidateBlockers(store,cfg,now);assert.equal(before.counts.admissible,1);
 assert.deepEqual(admitOnly(store,cfg,now),['same ETHUSD 4h']);assert.equal(store.get(alt.id)!.stage,'candidate');
});
test('a runtime quarantine blocks admission without treating existing forward evidence as failure',()=>{
 const {store,cfg,pair,db}=world();pair('old');const next=pair('wait','15m','candidate',10);
 db.run('INSERT INTO script_health(scanner_id,last_at,quarantined,reason) VALUES (?,?,1,?)','wait',now,'runtime fault');
 assert.equal(candidateBlockers(store,cfg,now).counts.unavailable,1);
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(store.get(next.id)!.stage,'candidate');
});

test('an old fill no longer occupies an idle research slot forever; its history is unchanged',()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20);pos(old);
 db.run('UPDATE positions SET entry_at=?,exit_at=?,realized_pnl=?',now-10*DAY,now-9*DAY,7);
 const history=db.all('SELECT * FROM positions');const next=pair('next','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),['next ETHUSD 15m']);
 assert.equal(store.get(old.id)!.stage,'candidate');assert.equal(store.get(old.id)!.since,old.since);
 assert.equal(store.get(next.id)!.stage,'shadow');assert.deepEqual(db.all('SELECT * FROM positions'),history);
 const event=store.events(10).find(e=>e.actor==='rotation')!;
 assert.equal(event.evidence.idleSince,now-7*DAY);assert.equal(event.evidence.lastEntryAt,now-10*DAY);
});

test('a fill exactly at the idle cutoff is still active',()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20);pos(old);
 db.run('UPDATE positions SET entry_at=?',now-7*DAY);pair('next','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),[]);
});

test('a recent close keeps an old swing entry active',()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20);pos(old);
 db.run('UPDATE positions SET entry_at=?,exit_at=?',now-10*DAY,now-DAY);pair('next','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),[]);
});

for(const book of [0,2]) for(const status of ['open','pending']) test(`rotation protects old ${status} positions in book ${book}`,()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20);pos(old,status);
 db.run('UPDATE positions SET entry_at=?,bt=?',now-10*DAY,book);pair('next','15m','candidate',10);
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(store.get(old.id)!.stage,'shadow');
});

test('a new evaluation window gets its full observation time despite old fills',()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20);pos(old);
 db.run('UPDATE positions SET entry_at=?',now-10*DAY);pair('next','15m','candidate',10);
 store.evaluationSince=()=>now-2*DAY;
 assert.deepEqual(admitOnly(store,cfg,now),[]);
});

test('paper-qualified quiet sources are protected without changing their qualification rules',()=>{
 const {store,cfg,pair}=world();const old=pair('old','15m','shadow',20);pair('next','15m','candidate',10);
 cfg.incubator.mirror!.enabled=true;store.policyFor=()=>{throw Error('unused test policy');};
 store.evaluationSince=cell=>cell.since;
 let calls=0;
 store.copyRefusal=(_cell,mirror,_turnover,at,opts)=>{calls++;assert.equal(mirror,cfg.incubator.mirror);assert.equal(at,now);assert.equal(opts?.readOnly,true);return null;};
 assert.deepEqual(admitOnly(store,cfg,now),[]);assert.equal(calls,1);assert.equal(store.get(old.id)!.stage,'shadow');
});

test('the transaction rejects a fill that arrives after the idle selection',()=>{
 const {store,cfg,pair,pos,db}=world();const old=pair('old','15m','shadow',20),next=pair('next','15m','candidate',10);
 const rotate=store.rotate.bind(store);
 store.rotate=(...args)=>{pos(old);return rotate(...args);};
 assert.throws(()=>admitOnly(store,cfg,now),/rotation state changed/);
 assert.equal(store.get(old.id)!.stage,'shadow');assert.equal(store.get(next.id)!.stage,'candidate');assert.equal(store.rotationState().used,0);
 assert.equal(db.get<{n:number}>('SELECT count(*) n FROM positions')!.n,1);
});
