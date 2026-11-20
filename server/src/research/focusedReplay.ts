import path from 'node:path';
import {ReplayArchive,type ReplayArchiveOptions} from './replayArchive.ts';

export const EXIT_STUDY_SYMBOLS=['ARIAUSD','INITUSD','PARTIUSD','EVAAUSD'] as const;
/** Separate bounded retention prevents the broad universe from evicting this study's tape.
 * Both writers are observational; failure in either is reported, never an execution gate. */
export class FocusedReplay {
 readonly broad:ReplayArchive;readonly study:ReplayArchive;
 private studySymbols=new Set<string>(EXIT_STUDY_SYMBOLS);
 private broadSymbols:string[]=[];
 constructor(options:ReplayArchiveOptions){
  this.broad=new ReplayArchive(options);
  this.study=new ReplayArchive({...options,dir:path.join(options.dir,'entry-invalidation-v1'),keepDays:21,maxBytes:4*1024**3,minFreeBytes:4*1024**3});
  this.study.setSymbols([...EXIT_STUDY_SYMBOLS]);
 }
 setSymbols(symbols:string[],at?:number){this.broadSymbols=[...new Set([...symbols,...this.studySymbols])];this.broad.setSymbols(this.broadSymbols,at);}
 /** Selected active/recent reference markets share the existing bounded study archive. */
 setStudySymbols(symbols:string[],at?:number){this.studySymbols=new Set([...EXIT_STUDY_SYMBOLS,...symbols]);this.study.setSymbols([...this.studySymbols],at);}
 includeStudy(symbol:string,at?:number){this.setStudySymbols([...this.studySymbols,symbol],at);this.setSymbols(this.broadSymbols,at);}
 capturesStudy(symbol:string){return this.studySymbols.has(symbol);}
 record(symbol:string,kind:string,payload:unknown,at?:number,source?:string){
  this.broad.record(symbol,kind,payload,at,source);this.study.record(symbol,kind,payload,at,source);
 }
 async flush(){await Promise.all([this.broad.flush(),this.study.flush()]);}
 async close(){await Promise.all([this.broad.close(),this.study.close()]);}
 status(){return {...this.broad.status(),entryInvalidationStudy:this.study.status()};}
}
