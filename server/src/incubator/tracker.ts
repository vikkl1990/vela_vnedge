/**
 * Trackers (decision 139): a named set of scanners × markets × timeframes shadow-traded for the operator to watch,
 * outside the incubator's judgement. A tracked cell is traded by the shadow runner with the same engine, gates and
 * costs as any shadow cell, but the gate never promotes, retires or ages it, it holds no shadow slot, the nightly
 * screen skips it, and the account never mirrors it. A cell already in the shadow book or live keeps its stage and is
 * read as a member as it is.
 */
import type { Db } from '../db.ts';
import type { IncubatorStore } from './store.ts';

export interface TrackerDef { id: string; name: string; scanners: string[]; symbols: string[]; tfs: string[]; createdAt: number }
export interface CellStat { scannerId: string; symbol: string; tf: string; stage: string; trades: number; sumR: number; avgR: number; wins: number; stops: number; open: number; lastAt: number | null }
export interface TrackerView { tracker: TrackerDef; cells: CellStat[]; totals: { cells: number; trading: number; trades: number; sumR: number; avgR: number; winRate: number; open: number } }

const KEY = 'trackers';
const note = (id: string) => `tracker:${id}`;
export const listTrackers = (db: Db): TrackerDef[] => db.kvGet<TrackerDef[]>(KEY) ?? [];

const cellsOf=(t:Pick<TrackerDef,'scanners'|'symbols'|'tfs'>)=>[...new Set(t.scanners)].flatMap(scannerId=>[...new Set(t.symbols)].flatMap(symbol=>[...new Set(t.tfs)].map(tf=>({scannerId,symbol,tf}))));
const keyOf=(c:{scannerId:string;symbol:string;tf:string})=>JSON.stringify([c.scannerId,c.symbol,c.tf]);

/** A watch list owns a subscription, never an account allocation. Shared cells have multiple owners. */
function releaseMembership(store:IncubatorStore,id:string,next:TrackerDef[],now:number):number {
  const owners=new Map<string,string[]>();
  for(const t of next)for(const c of cellsOf(t)){const key=keyOf(c);owners.set(key,[...(owners.get(key)??[]),t.id]);}
  let released=0;
  for(const r of store.list(['tracked']))if(r.note===note(id)){
    const keep=owners.get(keyOf(r));
    if(keep?.length){if(!keep.includes(id))store.move(r,'tracked','tracker',{owners:keep},note(keep[0]),now,{keepSince:true});}
    else {store.move(r,'candidate','tracker',{released:id},'left the last tracker',now);released++;}
  }
  return released;
}

/** Membership and stage changes commit together; repeated dimensions cannot double-count a cell. */
export function saveTracker(db:Db,store:IncubatorStore,def:Omit<TrackerDef,'createdAt'>,now=Date.now()):{tracker:TrackerDef;added:number;kept:number;released:number}{
  if(!/^[a-z0-9-]{2,40}$/.test(def.id))throw new Error('tracker id: 2–40 lowercase letters, digits or dashes');
  if(![def.scanners,def.symbols,def.tfs].every(a=>Array.isArray(a)&&a.length&&a.every(v=>typeof v==='string'&&v.trim())))throw new Error('a tracker needs scanners, markets and timeframes');
  const all=listTrackers(db),prev=all.find(t=>t.id===def.id);
  const tracker:TrackerDef={...def,scanners:[...new Set(def.scanners)],symbols:[...new Set(def.symbols)],tfs:[...new Set(def.tfs)],createdAt:prev?.createdAt??now};
  const next=[...all.filter(t=>t.id!==def.id),tracker];
  return db.transaction(()=>{
    const released=releaseMembership(store,def.id,next,now);let added=0,kept=0;
    for(const c of cellsOf(tracker)){
      const cur=store.find(c.scannerId,c.symbol,c.tf);
      if(cur&&['shadow','proposed','live','demote_proposed','tracked'].includes(cur.stage)){kept++;continue;}
      store.move(c,'tracked','tracker',{tracker:def.id},note(def.id),now);added++;
    }
    db.kvSet(KEY,next);return {tracker,added,kept,released};
  });
}

/** Only the last owner can release a watched cell. Allocations and held trades are untouched. */
export function removeTracker(db:Db,store:IncubatorStore,id:string,now=Date.now()):number{
  return db.transaction(()=>{const next=listTrackers(db).filter(t=>t.id!==id);const n=releaseMembership(store,id,next,now);db.kvSet(KEY,next);return n;});
}

/** Each member cell's shadow trades since the tracker began, and the totals. */
export function trackerView(db: Db, store: IncubatorStore, t: TrackerDef): TrackerView {
  // Aggregate once per named view, not two full journal queries for every member cell.
  const rows=db.all<{scanner_id:string;symbol:string;tf:string;trades:number;sumR:number;wins:number;stops:number;open:number;lastAt:number|null}>(`
    SELECT scanner_id,symbol,tf,
      SUM(CASE WHEN status='closed' AND risk_amount>0 THEN 1 ELSE 0 END) trades,
      COALESCE(SUM(CASE WHEN status='closed' AND risk_amount>0 THEN (realized_pnl-fees)/risk_amount ELSE 0 END),0) sumR,
      SUM(CASE WHEN status='closed' AND risk_amount>0 AND realized_pnl-fees>0 THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN status='closed' AND risk_amount>0 AND exit_reason='sl' THEN 1 ELSE 0 END) stops,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,
      MAX(CASE WHEN status='closed' AND risk_amount>0 THEN exit_at END) lastAt
    FROM positions WHERE bt=2 AND scanner_id NOT LIKE 'plan:%'
      AND (status='open' OR (status='closed' AND entry_at>=?)) GROUP BY scanner_id,symbol,tf`,t.createdAt);
  const stats=new Map(rows.map(r=>[keyOf({scannerId:r.scanner_id,symbol:r.symbol,tf:r.tf}),r]));
  const stages=new Map(store.list().map(r=>[keyOf(r),r.stage]));
  const cells:CellStat[]=cellsOf(t).map(c=>{
    const x=stats.get(keyOf(c));const trades=x?.trades??0,sumR=x?.sumR??0;
    return {...c,stage:stages.get(keyOf(c))??'none',trades,sumR,avgR:trades?sumR/trades:0,wins:x?.wins??0,stops:x?.stops??0,open:x?.open??0,lastAt:x?.lastAt??null};
  });
  const trades = cells.reduce((a, c) => a + c.trades, 0), sumR = cells.reduce((a, c) => a + c.sumR, 0), wins = cells.reduce((a, c) => a + c.wins, 0);
  return { tracker: t, cells, totals: { cells: cells.length, trading: cells.filter(c => c.trades > 0).length, trades, sumR, avgR: trades ? sumR / trades : 0, winRate: trades ? wins / trades : 0, open: cells.reduce((a, c) => a + c.open, 0) } };
}
