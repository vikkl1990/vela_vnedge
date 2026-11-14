import {candleReplayBlock} from '../paper/basket.ts';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { LoadedScanner } from '../scanners/registry.ts';
import { strategyIdentity } from '../scanners/identity.ts';
import { backtestPolicy } from '../paper/policy.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { isCrypto, type MarketVerdict } from '../risk/marketGate.ts';
import type { IncubatorStore } from './store.ts';
import type { ScreenQueue } from './screenQueue.ts';
import type { ScreenResult } from './cycle.ts';

const DAY = 86400_000, KEY = 'incubator.pairAgents', ACTOR = 'pair-agents';
const cellKey = (id: string, symbol: string, tf: string) => JSON.stringify([id, symbol, tf]);
export const AGENT_DEFAULTS = { enabled: false, maxJobsPerDay: 24, scannersPerJob: 4, marketsPerJob: 3, refreshDays: 7, budgetMinutes: 15 };

/** A completed negative screen is evidence too; failed or unrun jobs are never counted as tested. */
export function coverageSignature(cfg: AppConfig, scanner: Pick<LoadedScanner,'id'|'patched'>, tf: string): string {
  return createHash('sha256').update(JSON.stringify({ identity: strategyIdentity(scanner.patched,cfg,scanner.id),
    policy: backtestPolicy(cfg,scanner.id,tf,'shadow'), screen: cfg.incubator.screen, sim: SIMULATION_VERSION })).digest('hex').slice(0,24);
}
export function recordCoverage(db: Db, scannerId: string, symbol: string, tf: string, signature: string, result: ScreenResult) {
  db.run(`INSERT INTO pair_screen_evidence VALUES(?,?,?,?,?,?) ON CONFLICT(scanner_id,symbol,tf)
    DO UPDATE SET at=excluded.at,signature=excluded.signature,result=excluded.result`,scannerId,symbol,tf,result.at,signature,JSON.stringify(result));
}

interface State { day: string; used: number; attempts: Record<string,number>; handled: string[]; nextAt: number; lastAt: number; status: string }
export interface CoverageMarket { symbol: string; turnover: number; eligible: boolean; reasons: string[]; account: number; shadow: number; tracked: number; candidates: number; screened: number; passed: number; due: number; cells: number }
interface Market { symbol: string; description?: string; volume24h: number; price: number }
export interface PairAgentDeps {
  db: Db; cfg: () => AppConfig; store: IncubatorStore; queue: ScreenQueue;
  scanners: () => Array<Pick<LoadedScanner,'id'|'name'|'patched'>>;
  markets: () => Promise<Market[]>;
  verdict: (symbol: string, now: number) => MarketVerdict | null;
  pressure: () => boolean;
  evaluate: () => Promise<unknown>;
  now?: () => number;
}

/** Three duties, one existing pipeline: discover markets, fill research gaps, hand evidence to the incubator. */
export class PairAgents {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = true;
  private deps: PairAgentDeps;
  constructor(deps: PairAgentDeps) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private state(): State {
    const day = new Date(this.now()).toISOString().slice(0,10);
    const s = this.deps.db.kvGet<State>(KEY) ?? {day,used:0,attempts:{},handled:[],nextAt:0,lastAt:0,status:'Waiting for first cycle'};
    return {...s,day,used:s.day === day ? s.used : 0};
  }
  start() { if(this.timer)return; this.stopped=false; this.timer=setInterval(()=>{void this.tick();},60_000);this.timer.unref?.(); }
  stop() { this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null; }

  async view() {
    const {db,cfg,store}=this.deps,c=cfg(), settings={...AGENT_DEFAULTS,...c.incubator.agents},now=this.now(),s=this.state();
    const scanners=this.deps.scanners().filter(sc=>!candleReplayBlock(sc.id)), tfs=[...new Set(c.incubator.tfs?.length?c.incubator.tfs:[c.incubator.tf])];
    const signatures=new Map(scanners.flatMap(sc=>tfs.map(tf=>[`${sc.id}|${tf}`,coverageSignature(c,sc,tf)] as const)));
    const evidence=new Map(db.all<{scanner_id:string;symbol:string;tf:string;at:number;signature:string;result:string}>('SELECT * FROM pair_screen_evidence')
      .filter(r=>r.at<=now && r.at>now-settings.refreshDays*DAY && r.signature===signatures.get(`${r.scanner_id}|${r.tf}`))
      .map(r=>[cellKey(r.scanner_id,r.symbol,r.tf),r]));
    const pairs=new Map(store.list().map(r=>[cellKey(r.scannerId,r.symbol,r.tf),r]));
    const marketAttempts=new Map<string,number>();
    const active=new Set(['live','demote_proposed','shadow','proposed','tracked']);
    const due: Array<{id:string;symbol:string;tf:string;attempt:number;turnover:number}>=[];
    const markets:CoverageMarket[]=(await this.deps.markets()).filter(m=>/^[A-Z0-9]+USD$/.test(m.symbol)&&isCrypto(m.description)).map(m=>{
      const verdict=this.deps.verdict(m.symbol,now), reasons=[...(verdict?.allowed===false?verdict.reasons:[])];
      if(c.universe.exclude?.includes(m.symbol))reasons.push('Excluded by operator');
      if(!(m.price>0&&Number.isFinite(m.price)))reasons.push('No valid market price');
      if(!Number.isFinite(m.volume24h)||m.volume24h<(c.risk.marketGate?.minTurnoverUsd??c.incubator.minTurnoverUsd))reasons.push('Below market turnover floor');
      if(c.risk.marketGate?.enabled&&!verdict)reasons.push('Waiting for market assessment');
      const row:CoverageMarket={symbol:m.symbol,turnover:m.volume24h,eligible:!reasons.length,reasons,account:0,shadow:0,tracked:0,candidates:0,screened:0,passed:0,due:0,cells:scanners.length*tfs.length};
      for(const sc of scanners)for(const tf of tfs){
        const key=cellKey(sc.id,m.symbol,tf),pair=pairs.get(key),e=evidence.get(key);
        const attempt=s.attempts[key]??0;
        marketAttempts.set(m.symbol,Math.max(marketAttempts.get(m.symbol)??0,attempt));
        if(pair?.stage==='live'||pair?.stage==='demote_proposed')row.account++;
        else if(pair?.stage==='shadow'||pair?.stage==='proposed')row.shadow++;
        else if(pair?.stage==='tracked')row.tracked++;
        else if(pair?.stage==='candidate')row.candidates++;
        if(e){row.screened++;if(JSON.parse(e.result).pass)row.passed++;}
        if(active.has(pair?.stage??'')||e)continue;
        if(pair?.stage==='retired'&&now-pair.since<c.incubator.cooldownDays*DAY)continue;
        row.due++;
        if(row.eligible&&(!attempt||now-attempt>=DAY))due.push({id:sc.id,symbol:m.symbol,tf,attempt,turnover:m.volume24h});
      }
      return row;
    }).sort((a,b)=>b.turnover-a.turnover||a.symbol.localeCompare(b.symbol));
    // Visit other markets before trying another policy on the same high-turnover trio.
    due.sort((a,b)=>(marketAttempts.get(a.symbol)??0)-(marketAttempts.get(b.symbol)??0)||a.attempt-b.attempt||b.turnover-a.turnover||a.symbol.localeCompare(b.symbol)||a.tf.localeCompare(b.tf)||a.id.localeCompare(b.id));
    const q=this.deps.queue.list();
    return {enabled:settings.enabled&&c.incubator.enabled,settings,at:now,lastAt:s.lastAt,status:s.status,usedToday:s.used,nextAt:s.nextAt,
      scannerCount:scanners.length,tfs,markets,eligible:markets.filter(m=>m.eligible).length,
      running:q.running?.actor===ACTOR?q.running:null,history:q.history.filter(j=>j.actor===ACTOR).slice(0,6),
      queueBusy:!!q.running||q.queued.length>0||q.nightlyRunning, due};
  }

  async tick() {
    if(this.busy||this.stopped)return;
    this.busy=true;
    try {
      const cfg=this.deps.cfg(),settings={...AGENT_DEFAULTS,...cfg.incubator.agents},s=this.state(),now=this.now();
      const save=(status:string)=>{s.status=status;s.lastAt=now;this.deps.db.kvSet(KEY,s);};
      if(!settings.enabled||!cfg.incubator.enabled){save('Paused');return;}
      const q=this.deps.queue.list();
      const finished=q.history.filter(j=>j.actor===ACTOR&&!s.handled.includes(j.id));
      if(finished.length){
        if(finished.some(j=>j.status==='done'))await this.deps.evaluate();
        s.handled=[...finished.map(j=>j.id),...s.handled].slice(0,80);
        save('Screen evidence handed to the existing incubator');
      }
      if(q.running||q.queued.length||q.nightlyRunning){save('Waiting for the shared research queue');return;}
      if(this.deps.pressure()){save('Waiting for trading workers to clear');return;}
      if(s.used>=settings.maxJobsPerDay){save('Daily research budget used; resumes next UTC day');return;}
      if(now<s.nextAt){save('Waiting for next research cycle');return;}
      const view=await this.view();
      // A stop/pause while market discovery awaited must prevent submission.
      const current=this.deps.cfg().incubator;
      if(this.stopped||!current.enabled||!current.agents?.enabled)return;
      const first=view.due[0];
      if(!first){save('All eligible coverage is active, recently tested, or cooling down');return;}
      const ids=[...new Set(view.due.filter(d=>d.symbol===first.symbol&&d.tf===first.tf).map(d=>d.id))].slice(0,settings.scannersPerJob);
      const markets=[...new Set(view.due.filter(d=>d.tf===first.tf&&ids.includes(d.id)).map(d=>d.symbol))].slice(0,settings.marketsPerJob);
      const latest=this.deps.queue.list();
      if(latest.running||latest.queued.length||latest.nightlyRunning||this.deps.pressure()){save('Research queue became busy');return;}
      const job=this.deps.queue.enqueue({label:`Pair agents · ${markets.join(', ')} · ${first.tf}`,ids,markets,tf:first.tf,actor:ACTOR,budgetMinutes:settings.budgetMinutes});
      for(const id of ids)for(const symbol of markets)s.attempts[cellKey(id,symbol,first.tf)]=now;
      s.attempts=Object.fromEntries(Object.entries(s.attempts).filter(([,at])=>at>now-30*DAY).sort((a,b)=>b[1]-a[1]).slice(0,20000));
      s.used++;s.nextAt=now+10*60_000;save(`Research submitted: ${job.label}`);
    } catch(e) {
      const s=this.state();s.status=`Agent error: ${e instanceof Error?e.message:String(e)}`;s.lastAt=this.now();this.deps.db.kvSet(KEY,s);
    } finally {this.busy=false;}
  }
}
