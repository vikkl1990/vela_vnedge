/** One serialized retry after shared memory pressure; never replay an expired/changed cell. */
export class ScanRecovery {
  private tail:Promise<unknown>=Promise.resolve();
  readonly counts={requested:0,retried:0,recovered:0,abandoned:0};
  private clock:()=>number;private wait:(ms:number)=>Promise<void>;
  constructor(clock:()=>number=Date.now,wait:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms))){this.clock=clock;this.wait=wait;}
  async recover<T extends {ok:boolean;error?:string}>(result:T,run:()=>Promise<T>,valid:()=>boolean,ready:()=>boolean,deadline:number):Promise<T>{
    if(result.ok||!result.error?.startsWith('memory-shared:'))return result;
    this.counts.requested++;
    const work=this.tail.then(async()=>{
      const end=Math.min(deadline,this.clock()+30_000);
      await this.wait(1500);
      while(valid()&&this.clock()<end&&!ready())await this.wait(1000);
      if(!valid()||this.clock()>=end||!ready()){this.counts.abandoned++;return result;}
      this.counts.retried++;
      const next=await run();if(next.ok)this.counts.recovered++;
      return next;
    });
    this.tail=work.catch(()=>{});return work;
  }
}
