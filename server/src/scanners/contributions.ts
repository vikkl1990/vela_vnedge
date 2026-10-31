import type {App} from '../app.ts';
import {createHash} from 'node:crypto';
import {loadSpecs} from '../config.ts';
import {aliasMap, duplicateGroups} from './identity.ts';
import {profileSignature, summarizeKind, type ProfileRow} from './profile.ts';
import {sourceFacts, type SourceFacts} from './sourceFacts.ts';
import {funnelClass} from '../incubator/store.ts';
import {setImmediate as yieldToRuntime} from 'node:timers/promises';

type Dependencies = Pick<App,'db'|'registry'|'config'|'profiles'|'incubatorStore'|'scanners'>;
export type EvidenceState = 'matching'|'changed'|'legacy';
export function evidenceState(row: ProfileRow, signature: string): EvidenceState { return !row.signature ? 'legacy' : row.signature === signature ? 'matching' : 'changed'; }
const DAY=86_400_000;
const MAJORS=['WillyAlgoTrader','LuxAlgo','BigBeluga','AlgoAlpha','Zeiierman','ChartPrime'];
const emptyActivity=()=>({signals:0,opened:0,pending:0,blocked:0,reasons:{} as Record<string,number>});
export interface ContributionRow {
  id:string; name:string; author:string; status:string; reason:string|null; aliasOf:string|null;
  readingSpecified:boolean; entryDisabled:boolean; hidden:boolean; channels:string[]; cautions:number; role:string;
  profiles:{total:number;matching:number;changed:number;legacy:number;lastAt:number|null;tfs:string[]};
  cells:{paper:number;shadow:number;candidate:number;tracked:number};
  paper:ReturnType<typeof emptyActivity>; shadow:ReturnType<typeof emptyActivity>;
  closes:{paper:number;shadow:number}; next:string;
}

/** Read-only coverage ledger. Runtime evidence stays distinct from static source inventory. */
export class ContributionService {
  private a:Dependencies;
  private cache:{at:number;value:Awaited<ReturnType<ContributionService['build']>>}|null=null;
  private pending:Promise<Awaited<ReturnType<ContributionService['build']>>>|null=null;
  private facts=new Map<string,{hash:string;facts:SourceFacts}>();
  constructor(a:Dependencies){this.a=a;}
  private source(id:string){
    const s=this.a.registry.get(id);if(!s)return null;
    const hash=createHash('sha256').update(s.patched).digest('hex').slice(0,16),cached=this.facts.get(id);
    if(cached?.hash===hash)return cached;
    const value={hash,facts:sourceFacts(s.patched)};this.facts.set(id,value);return value;
  }
  async view(now=Date.now()){
    if(this.cache&&now-this.cache.at<60_000)return this.cache.value;
    if(this.pending)return this.pending;
    this.pending=this.build(now);
    try{const value=await this.pending;this.cache={at:now,value};return value;}finally{this.pending=null;}
  }
  detail(id:string){
    const s=this.a.registry.get(id);if(!s)return null;
    const sc=this.a.config.get().scanners[id];
    return {id,name:s.name,url:s.url,...this.source(id),reading:{sources:sc?.sources??null,labels:sc?.labels??null,rule:sc?.rule??null,inputs:sc?.inputs??{},edge:sc?.edge??null,invert:sc?.invert??false,sides:sc?.sides??null,timezone:sc?.timezone??'Etc/UTC'},
      profiles:this.a.profiles.forScanner(id).map(p=>({...p,evidence:evidenceState(p,profileSignature(s,sc,p.tf))}))};
  }
  private async build(now:number){
    const a=this.a,cfg=a.config.get(),from=now-7*DAY,all=a.registry.all(),pairs=a.incubatorStore.list(),specs=loadSpecs();
    const withPairs=new Set(pairs.map(p=>p.scannerId)),aliases=aliasMap(duplicateGroups(all,cfg,id=>withPairs.has(id)));
    const health=new Map(a.db.all<{scanner_id:string;reason:string}>('SELECT scanner_id,reason FROM script_health WHERE quarantined=1').map(r=>[r.scanner_id,r.reason]));
    const profiles=new Map<string,ProfileRow[]>();for(const p of a.profiles.all()){const list=profiles.get(p.scannerId)??[];list.push(p);profiles.set(p.scannerId,list);}
    const counts=new Map<string,ContributionRow['cells']>();
    for(const p of pairs){const c=counts.get(p.scannerId)??{paper:0,shadow:0,candidate:0,tracked:0};if(p.stage==='shadow'||p.stage==='proposed')c.shadow++;if(p.stage==='candidate')c.candidate++;if(p.stage==='tracked')c.tracked++;counts.set(p.scannerId,c);}
    const paper=new Map<string,ReturnType<typeof emptyActivity>>(),shadow=new Map<string,ReturnType<typeof emptyActivity>>();
    const add=(map:typeof paper,id:string,action:string,n:number,kind=funnelClass(action))=>{
      const v=map.get(id)??emptyActivity();v.signals+=n;if(kind==='opened')v.opened+=n;else if(kind==='pending')v.pending+=n;else{v.blocked+=n;v.reasons[action]=(v.reasons[action]??0)+n;}map.set(id,v);
    };
    for(const r of a.db.all<{scanner_id:string;action:string;n:number}>("SELECT scanner_id,action,count(*) n FROM signals WHERE kind='entry' AND at>=? AND at<? GROUP BY scanner_id,action",from,now))add(paper,r.scanner_id,r.action,r.n);
    const tracked=new Set(pairs.filter(p=>p.stage==='tracked').map(p=>`${p.scannerId}|${p.symbol}|${p.tf}`));
    for(const [key,list] of Object.entries(a.incubatorStore.shadowFunnel())){
      if(tracked.has(key))continue;
      const id=key.split('|')[0];for(const [at,kind,reason] of list)if(at>=from&&at<now)add(shadow,id,reason??kind,1,kind as ReturnType<typeof funnelClass>);
    }
    const closes=new Map<string,ContributionRow['closes']>();
    for(const r of a.db.all<{scanner_id:string;bt:number;n:number}>(`SELECT p.scanner_id,p.bt,count(*) n FROM positions p WHERE p.status='closed' AND p.bt IN (0,2) AND p.exit_at>=? AND p.exit_at<? AND (p.bt=0 OR NOT EXISTS (SELECT 1 FROM incubator_pairs i WHERE i.stage='tracked' AND i.scanner_id=p.scanner_id AND i.symbol=p.symbol AND i.tf=p.tf)) GROUP BY p.scanner_id,p.bt`,from,now)){
      const v=closes.get(r.scanner_id)??{paper:0,shadow:0};v[r.bt===0?'paper':'shadow']=r.n;closes.set(r.scanner_id,v);
    }
    const rows:ContributionRow[]=[];
    for(const s of all){
      // Source inventories must not monopolize the execution loop while a dashboard is opened.
      if(rows.length%25===0)await yieldToRuntime();
      const sc=cfg.scanners[s.id],ps=profiles.get(s.id)??[],matching=ps.filter(p=>evidenceState(p,profileSignature(s,sc,p.tf))==='matching');
      const legacy=ps.filter(p=>!p.signature).length,entryDisabled=Array.isArray(sc?.sources)&&!sc.sources.length;
      const cells=counts.get(s.id)??{paper:0,shadow:0,candidate:0,tracked:0};cells.paper=a.scanners.isActive(s)?a.scanners.pairsFor(s.id).length:0;
      const role=entryDisabled?'context / entries disabled':summarizeKind(matching)??'unverified';
      const reason=health.get(s.id)??s.reason??null,aliasOf=aliases.get(s.id)??null;
      const next=sc?.hidden?'Archived: review before restoring':aliasOf?'Use canonical scanner':entryDisabled?'Review context adapter':health.has(s.id)?'Repair runtime':s.status!=='ok'?'Resolve source hold':!matching.length?'Run current behavior probe':role==='broken'?'Repair runtime':role==='silent'||role==='levels'||role==='exits'?'Review reading / role':cells.paper?'Monitor paper execution':cells.shadow?'Collect shadow evidence':cells.candidate?'Review admission blockers':'Screen for shadow admission';
      const facts=this.source(s.id)!.facts;
      rows.push({id:s.id,name:s.name,author:s.author,status:health.has(s.id)?'quarantined':s.status,reason,aliasOf,readingSpecified:Object.hasOwn(specs,s.id),entryDisabled,hidden:Boolean(sc?.hidden),channels:facts.channels,cautions:facts.cautions.length,role,
        profiles:{total:ps.length,matching:matching.length,changed:ps.length-matching.length-legacy,legacy,lastAt:ps.length?Math.max(...ps.map(p=>p.at)):null,tfs:[...new Set(matching.map(p=>p.tf))].sort()},cells,paper:paper.get(s.id)??emptyActivity(),shadow:shadow.get(s.id)??emptyActivity(),closes:closes.get(s.id)??{paper:0,shadow:0},next});
    }
    const summarize=(rs:ContributionRow[])=>({total:rs.length,hidden:rs.filter(r=>r.hidden).length,matching:rs.filter(r=>r.profiles.matching>0).length,specified:rs.filter(r=>r.readingSpecified).length,paper:rs.filter(r=>r.cells.paper>0).length,shadow:rs.filter(r=>r.cells.shadow>0).length,aliases:rs.filter(r=>r.aliasOf).length,held:rs.filter(r=>r.status!=='ok').length,unverified:rs.filter(r=>!r.profiles.matching&&!r.aliasOf&&!r.hidden&&r.status==='ok').length});
    const authors=[...new Set([...MAJORS,...rows.map(r=>r.author)])].map(author=>({author,major:MAJORS.includes(author),...summarize(rows.filter(r=>r.author===author))})).sort((a,b)=>Number(b.major)-Number(a.major)||b.total-a.total);
    return {at:now,from,to:now,summary:summarize(rows),authors,rows,lastScreen:a.db.kvGet('incubator.lastRun')??null,
      notes:['Profiles describe observed behavior, not profitability or a completed code review. Matching means the source, reading, inputs and timeframe match; check the observation date and candle window.',
      'Shadow signal history is bounded to 120 decisions per cell over 14 days; this view uses the retained last 7 days and excludes tracker cells. Paper decisions and closed trades use the same 7-day window.',
      'Opened and pending are recorded signal decisions. Closed trades are counted from positions; these are different cohorts. Paper allocation counts enabled scanner cells; pilot entries can also arrive from shadow. Context indicators need an explicit, tested adapter before they can affect execution.']};
  }
}
