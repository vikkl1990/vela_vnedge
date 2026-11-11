import {stablePolicy,strategyIdFor} from './strategyIdentity.ts';
export {stablePolicy} from './strategyIdentity.ts';
/** Immutable strategy settings. Runtime account halts remain outside this snapshot. */
import {createHash} from 'node:crypto';
import type {AppConfig, PaperConfig, ScannerConfig, ExitMode} from '../config.ts';
import type {Db} from '../db.ts';
import {SIM_VERSION} from './fingerprint.ts';
import {scannerExitPolicy} from './policy.ts';
import {exitConfigFor} from './logic.ts';
import {scannerEntryConfig} from './entryProtection.ts';
import {trialRiskConfig,selectiveReclaimRule} from './selectiveEntry.ts';

export const POLICY_VERSION = 1;
const hash=(v:unknown)=>createHash('sha256').update(stablePolicy(v)).digest('hex');

/** Allocation and presentation do not change a scanner's interpretation. */
export function policyReading(sc:Partial<ScannerConfig>|undefined) {
  const {enabled,hidden,symbols,timeframes,pairs,...reading}=sc??{};
  return structuredClone(reading);
}
export interface TradePolicy {
  version:1; id:string; strategyId:string; sim:number;
  scannerId:string; symbol:string; tf:string; sourceHash:string|null;
  reading:ReturnType<typeof policyReading>; exitMode:ExitMode;
  paper:PaperConfig; sizing:PaperConfig;
  risk:AppConfig['risk']; ml:AppConfig['ml'];
  /** Unknown original rules must never become new-policy qualification evidence. */
  adoptedAt?:number;
}

export function makeTradePolicy(cfg:AppConfig,cell:{scannerId:string;symbol:string;tf:string;exitMode:ExitMode},
  paper:PaperConfig,sizing:PaperConfig,sourceHash:string|null,book:number):TradePolicy {
  const resolved=structuredClone(paper);
  delete resolved.exitBySymbol;delete resolved.exitByTf;
  if(resolved.minRiskFeeRatioBySymbol)resolved.minRiskFeeRatio=resolved.minRiskFeeRatioBySymbol[cell.symbol]??resolved.minRiskFeeRatio;
  delete resolved.minRiskFeeRatioBySymbol;
  const le=resolved.limitEntry;
  resolved.limitEntry=le?.enabled&&le.tfs.includes(cell.tf)&&le.books.includes(book===0?'account':'shadow')
    ? {...le,atr:le.atrByTf?.[cell.tf]??le.atr,atrByTf:undefined,tfs:[cell.tf],books:[book===0?'account':'shadow']} : undefined;
  resolved.makerQuoteCells=resolved.makerQuoteCells?.filter(r=>r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf);
  if(!resolved.makerQuoteCells?.length)delete resolved.makerQuoteCells;
  resolved.entryAlignments=resolved.entryAlignments?.filter(r=>r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf);
  resolved.reclaimTrials=resolved.reclaimTrials?.filter(r=>r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf);
  if(!resolved.reclaimTrials?.length)delete resolved.reclaimTrials;
  if(!resolved.entryAlignments?.length)delete resolved.entryAlignments;
  const body={version:POLICY_VERSION as 1,sim:SIM_VERSION,scannerId:cell.scannerId,symbol:cell.symbol,tf:cell.tf,exitMode:cell.exitMode,
    sourceHash,reading:policyReading(cfg.scanners[cell.scannerId]),
    paper:resolved,sizing:structuredClone(sizing),risk:structuredClone(cfg.risk),ml:structuredClone(cfg.ml)};
  // Cross-book strategy evidence is separate from capital feasibility. Preserve execution,
  // cost and stop restrictions; remove only the book's purse and sizing controls.
  const strategyId=strategyIdFor(body);
  return {...body,strategyId,id:hash(body)};
}

export function resolveTradePolicy(cfg:AppConfig,cell:{scannerId:string;symbol:string;tf:string},source:string|null,book=0):TradePolicy {
  const sizing=book===0&&cfg.execution.mode==='paper'?trialRiskConfig(cfg.paper,selectiveReclaimRule(cfg.paper,cell)):cfg.paper;
  const sc=cfg.scanners[cell.scannerId];
  const paper=scannerEntryConfig(exitConfigFor(sizing,cell.symbol,scannerExitPolicy(cfg,cell.scannerId),cell.tf),sc,cell.tf);
  return makeTradePolicy(cfg,{...cell,exitMode:sc?.exitMode??'both'},paper,sizing,source,book);
}

export function saveTradePolicy(db:Db,p:TradePolicy){
  const {adoptedAt,...snapshot}=p;
  db.run('INSERT OR IGNORE INTO trade_policies(id,strategy_id,source_hash,snapshot) VALUES(?,?,?,?)',p.id,p.strategyId,p.sourceHash,JSON.stringify(snapshot));
}
export function loadTradePolicy(db:Db,id:string|null|undefined,adoptedAt?:number|null):TradePolicy|undefined {
  if(!id)return undefined;
  const row=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',id);
  if(!row)throw new Error(`missing bound trade policy ${id}`);
  const p=JSON.parse(row.snapshot) as TradePolicy;
  if(p.version!==POLICY_VERSION)throw new Error(`unsupported bound trade policy version ${p.version}`);
  return {...p,...(adoptedAt!=null?{adoptedAt}:{})};
}

// Backwards-compatible exports; all consumers share the evidence module.
export { eligibleEvidence, evidenceCoverage, type EvidenceCoverage } from '../evidence/trades.ts';
