import type { ScanEvent } from '../scanners/extractor.ts';
import {TF_SECONDS, type PaperConfig, type ScannerConfig} from '../config.ts';

/** Explicit entry policy; never infer ATR conversion from the legacy rejection switch. */
export type EntryProtection = 'atr' | 'native';
export function protectEntry(ev: ScanEvent, mode?: EntryProtection): ScanEvent {
  return mode === 'atr' && ev.kind === 'entry' ? { ...ev, sl: undefined, tp: [] } : ev;
}

export function scannerEntryConfig(paper:PaperConfig, scanner:Partial<ScannerConfig>|undefined, tf:string):PaperConfig {
  if(scanner?.entryExecution==='market')return {...paper,limitEntry:undefined};
  const le=scanner?.entryLimit;
  if(!le?.tfs.includes(tf))return paper;
  return {...paper,limitEntry:{enabled:true,tfs:[tf],books:['account','shadow'],atr:le.atr,bars:le.minutes*60/TF_SECONDS[tf]}};
}
