import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import type {App} from '../app.ts';
import {TF_SECONDS, type AppConfig} from '../config.ts';
import {ContractRegistry} from './contracts.ts';
import {profileSignature} from './profile.ts';
import {scannerPairs} from './allocation.ts';
import {planSnapshot, planScannerId, type ExecutionPlanSnapshot} from '../paper/executionPlans.ts';
import type {ReadinessCell, ReadinessRow, ScannerReadiness} from '../../../shared/scannerContracts.ts';

type Dependencies=Pick<App,'db'|'registry'|'config'|'profiles'|'incubatorStore'|'scanners'|'shadow'|'sourceHashFor'>;
type Activity=ReadinessRow['activity'];
const empty=(scope:string):Activity=>({signals:0,fills:0,pending:0,reasons:{},scope});
const key=(s:string,m:string,t:string)=>JSON.stringify([s,m,t]);
const DAY=86_400_000;

/** Observational matrix only: no gate writes, synthetic fills, or policy changes. */
export class ReadinessService {
  private a:Dependencies;
  private contracts:ContractRegistry;
  private cache:{at:number;value:ScannerReadiness}|null=null;
  private pending:Promise<ScannerReadiness>|null=null;
  constructor(a:Dependencies,contracts=new ContractRegistry()){this.a=a;this.contracts=contracts;}
  async view(now=Date.now()){
    if(this.cache&&now-this.cache.at<60_000)return this.cache.value;
    if(this.pending)return this.pending;
    this.pending=this.build(now);
    try{const value=await this.pending;this.cache={at:now,value};return value;}finally{this.pending=null;}
  }
  private snapshot(cfg:AppConfig,id:string){
    const p=cfg.executionPlans?.find(x=>x.id===id);
    return p?planSnapshot(cfg,p,this.a.sourceHashFor(p.scannerId),this.a.shadow.marketFeesFor?.(p.symbol)):undefined;
  }
  detail(id:string,planId?:string){
    const s=this.a.registry.get(id);if(!s)return null;
    const cfg=this.a.config.get(),p=planId?this.snapshot(cfg,planId):undefined;
    if(planId&&(!p||p.sourceScannerId!==id))return null;
    return this.contracts.get(s,p?.reading??cfg.scanners[id]??{},p);
  }
  private async build(now:number):Promise<ScannerReadiness>{
    const a=this.a,cfg=a.config.get(),from=now-DAY,rows:ReadinessRow[]=[];
    const cells=new Map<string,ReadinessCell[]>();
    const add=(id:string,c:ReadinessCell)=>{const list=cells.get(id)??[];if(!list.some(x=>x.symbol===c.symbol&&x.tf===c.tf&&x.book===c.book))list.push(c);cells.set(id,list);};
    const runs=new Map(a.db.all<{scanner_id:string;symbol:string;tf:string;at:number;error:string|null}>('SELECT scanner_id,symbol,tf,at,error FROM scanner_runs').map(r=>[key(r.scanner_id,r.symbol,r.tf),r]));
    const scans=new Map(a.db.all<{scanner_id:string;symbol:string;tf:string;at:number;status:string;reason:string|null}>('SELECT scanner_id,symbol,tf,at,status,reason FROM shadow_scan_activity').map(r=>[key(r.scanner_id,r.symbol,r.tf),r]));
    const health=new Map(a.db.all<{scanner_id:string;reason:string}>('SELECT scanner_id,reason FROM script_health WHERE quarantined=1').map(r=>[r.scanner_id,r.reason]));
    const cell=(id:string,symbol:string,tf:string,book:ReadinessCell['book']):ReadinessCell=>{
      const r=book==='paper'?runs.get(key(id,symbol,tf)):scans.get(key(id,symbol,tf));
      const state=!r?'unobserved':'status' in r?r.status:r.error?'failed':'scanned';
      return {symbol,tf,book,state:lastFresh(r?.at??null,tf,now)?state:r?'stale':state,lastAt:r?.at??null,reason:r?('reason' in r?r.reason:r.error):null};
    };
    for(const [id,sc] of Object.entries(cfg.scanners))if(sc.enabled){cells.set(id,[]);for(const p of scannerPairs(sc,cfg.timeframes))add(id,cell(id,p.symbol,p.tf,'paper'));}
    for(const p of a.incubatorStore.list())if(['shadow','proposed','live','demote_proposed','tracked'].includes(p.stage))add(p.scannerId,cell(p.scannerId,p.symbol,p.tf,p.stage==='tracked'?'tracked':'shadow'));
    const activities=new Map<string,Activity>();
    const activity=(id:string)=>{let v=activities.get(id);if(!v){v=empty('Paper decisions plus retained shadow decisions; fills from both books, last 24h. Activity is not qualified evidence.');activities.set(id,v);}return v;};
    for(const r of a.db.all<{scanner_id:string;action:string;n:number}>("SELECT scanner_id,action,count(*) n FROM signals WHERE kind='entry' AND at>=? AND at<? GROUP BY scanner_id,action",from,now)){
      const v=activity(r.scanner_id);v.signals+=r.n;if(r.action!=='opened'&&r.action!=='reversed')v.reasons[r.action]=(v.reasons[r.action]??0)+r.n;
    }
    for(const [k,events] of Object.entries(a.incubatorStore.shadowFunnel()))for(const [at,kind,reason] of events)if(at>=from&&at<now){const v=activity(k.split('|')[0]);v.signals++;if(kind!=='opened')v.reasons[reason??kind]=(v.reasons[reason??kind]??0)+1;}
    for(const r of a.db.all<{scanner_id:string;fills:number;pending:number}>(`SELECT scanner_id,sum(status IN ('open','closed') AND qty>0) fills,sum(status='pending') pending FROM positions WHERE bt IN (0,2) AND entry_at>=? AND entry_at<? GROUP BY scanner_id`,from,now))Object.assign(activity(r.scanner_id),{fills:r.fills??0,pending:r.pending??0});
    // The full library has >100k probes. Read only allocated scanners, with an
    // index lookup, and yield between profiles so this view cannot starve exits.
    const profiles=new Map<string,ReturnType<Dependencies['profiles']['forScanner']>>();
    const make=async(id:string,cs:ReadinessCell[],p?:ExecutionPlanSnapshot,planError?:string)=>{
      const s=a.registry.get(id),sc=p?.reading??cfg.scanners[id]??{};
      if(!s){rows.push({key:id,scannerId:id,name:id,author:'Unknown',planId:p?.id??null,enabled:Boolean(sc.enabled),cells:cs,runtime:'held',runtimeReasons:['Scanner missing from registry'],profiles:{matching:0,other:0},activity:empty('Unavailable'),policy:{signature:null,executionVersion:null,partialExitVersion:null,reversalEntryVersion:null,promotion:'Not assessed'},contract:{role:'unresolved',sourceStatus:'unavailable',publicationStatus:'unavailable',sourceHash:'',runtimeHash:'',contractVersion:'',reader:sc.reader??1,adapter:'Unavailable',capabilities:[],gaps:['Source unavailable'],intent:'Unknown'}});return;}
      const d=this.contracts.get(s,sc,p),reasons:string[]=[];
      if(s.status!=='ok')reasons.push(s.reason??`Source ${s.status}`);
      if(cs.some(c=>c.book==='paper')&&(sc.hidden||health.has(id)))reasons.push(sc.hidden?'Paper scanner hidden':health.get(id)!);
      if(cs.some(c=>c.book!=='paper')&&!cfg.incubator.enabled)reasons.push('Incubator disabled');
      if(cs.some(c=>!(c.tf in TF_SECONDS)))reasons.push('Unsupported timeframe');
      if(planError)reasons.push(planError);
      // Research profiles must match their effective reading, never the source scanner's other reading.
      if(!profiles.has(id))profiles.set(id,a.profiles.forScanner(id));
      const ps=profiles.get(id)!.filter(x=>cs.some(c=>c.symbol===x.market&&c.tf===x.tf));
      const matching=ps.filter(x=>x.signature===profileSignature(s,sc,x.tf)&&x.kind!=='broken').length;
      const runtime=reasons.length?'held':!cs.length?'unallocated':cs.some(c=>c.state==='scanned')?'collecting':'waiting';
      rows.push({key:p?`plan:${p.id}`:id,scannerId:id,name:p?`${s.name} · ${p.id}`:s.name,author:s.author,planId:p?.id??null,enabled:Boolean(sc.enabled),contract:d.summary,cells:cs,runtime,runtimeReasons:reasons,
        profiles:{matching,other:ps.length-matching},activity:p?empty('Current research cohort only; excluded from promotion.'):activity(id),
        policy:{signature:p?.signature??null,executionVersion:p?.executionVersion??null,partialExitVersion:p?.partialExitVersion??null,reversalEntryVersion:p?.reversalEntryVersion??null,
          promotion:p?'Experimental; excluded from promotion':'Existing shared evidence rules apply per cell; this matrix grants no eligibility'}});
      if(rows.length%10===0)await yieldToRuntime();
    };
    for(const [id,cs] of cells)await make(id,cs);
    for(const p of cfg.executionPlans??[])if(p.enabled){
      let snap:ExecutionPlanSnapshot;
      try{snap=this.snapshot(cfg,p.id)!;}catch(e){
        await make(p.scannerId,[cell(p.scannerId,p.symbol,p.tf,'research')],undefined,`Research plan ${p.id}: ${(e as Error).message}`);
        const r=rows.at(-1)!;r.key=`plan:${p.id}`;r.planId=p.id;r.name+=` · ${p.id}`;r.policy.promotion='Experimental; invalid plan snapshot; excluded from promotion';r.activity=empty('Plan snapshot unavailable');continue;
      }
      const cohort=planScannerId(snap);
      const scan=a.db.get<{at:number|null}>('SELECT max(at) at FROM execution_plan_scans WHERE scanner_id=?',cohort);
      const c=cell(p.scannerId,p.symbol,p.tf,'research');
      // Raw scanner runs cannot stand in for a completed reading comparison.
      if(p.readingOverride){c.lastAt=scan?.at??null;c.state=!c.lastAt?'unobserved':lastFresh(c.lastAt,p.tf,now)?'scanned':'stale';c.reason=c.lastAt?null:'No scan recorded for this exact plan cohort';}
      await make(p.scannerId,[c],snap);
      const row=rows.at(-1)!;
      for(const e of a.db.all<{action:string;reason:string|null;n:number}>('SELECT action,reason,count(*) n FROM execution_plan_events WHERE scanner_id=? AND at>=? AND at<? GROUP BY action,reason',cohort,from,now)){row.activity.signals+=e.n;if(e.reason)row.activity.reasons[e.reason]=(row.activity.reasons[e.reason]??0)+e.n;}
      const fills=a.db.get<{fills:number;pending:number}>("SELECT sum(status IN ('open','closed') AND qty>0) fills,sum(status='pending') pending FROM positions WHERE bt=2 AND scanner_id=? AND entry_at>=? AND entry_at<?",cohort,from,now);
      row.activity.fills=fills?.fills??0;row.activity.pending=fills?.pending??0;
    }
    return {at:now,from,rows,summary:{scanners:rows.filter(r=>!r.planId).length,plans:rows.filter(r=>r.planId).length,sourceMatched:rows.filter(r=>r.contract.sourceStatus==='matches').length,reviewNeeded:rows.filter(r=>r.contract.gaps.length>0).length,collecting:rows.filter(r=>r.runtime==='collecting').length,held:rows.filter(r=>r.runtime==='held').length},
      notes:['Read-only: no scanner, evidence identity, allocation, fee rule, margin or risk setting is changed.',
        'Author intent, implemented adapters, source-matched probes and trading eligibility are separate. A running scanner is not certified profitable or live-ready.',
        'Collecting means at least one allocated cell has a recent successful scan; inspect every cell for partial coverage. Freshness allows two bars plus two minutes. A quiet scan is not a fault.',
        'Activity is last 24 hours, not an outcome cohort. Base rows combine paper and retained shadow history across readings; research rows use the exact current plan signature. Tracker and research data do not become promotion evidence.',
        'The author catalogue is a dated local review, not a live update check. Historical notes can predate implemented adapters; current capabilities are listed separately.']};
  }
}
function lastFresh(at:number|null,tf:string,now:number){return at!==null&&at<=now&&now-at<=2*(TF_SECONDS[tf]??0)*1000+120_000;}
