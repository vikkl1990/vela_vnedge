import type {PaperConfig} from '../config.ts';
/** Only policies whose behavior changes lose compatibility; ordinary single-target records keep their identity. */
export function lifecycleIdentity(p:PaperConfig){
 return (p.earlyCut?.minutes??0)>0 || p.staleBars>0 || p.tpSplit.filter(n=>n>0).length>1
  ? {causalLifecycleVersion:1 as const} : {};
}
