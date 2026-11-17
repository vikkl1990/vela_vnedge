import path from 'node:path';
import {ReplayArchive,type ReplayArchiveOptions} from './replayArchive.ts';

export const EXIT_STUDY_SYMBOLS=['ARIAUSD','INITUSD','PARTIUSD','EVAAUSD'] as const;
/** Separate bounded retention prevents the broad universe from evicting this study's tape.
 * Both writers are observational; failure in either is reported, never an execution gate. */
export class FocusedReplay {
 readonly broad:ReplayArchive;readonly study:ReplayArchive;
 constructor(options:ReplayArchiveOptions){
  this.broad=new ReplayArchive(options);
  this.study=new ReplayArchive({...options,dir:path.join(options.dir,'entry-invalidation-v1'),keepDays:21,maxBytes:4*1024**3,minFreeBytes:4*1024**3});
  this.study.setSymbols([...EXIT_STUDY_SYMBOLS]);
 }
 setSymbols(symbols:string[],at?:number){this.broad.setSymbols([...new Set([...symbols,...EXIT_STUDY_SYMBOLS])],at);}
 record(symbol:string,kind:string,payload:unknown,at?:number,source?:string){
  this.broad.record(symbol,kind,payload,at,source);this.study.record(symbol,kind,payload,at,source);
 }
 async flush(){await Promise.all([this.broad.flush(),this.study.flush()]);}
 async close(){await Promise.all([this.broad.close(),this.study.close()]);}
 status(){return {...this.broad.status(),entryInvalidationStudy:this.study.status()};}
}
