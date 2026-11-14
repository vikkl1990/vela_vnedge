/** Scheduling only. The existing evaluator and promotion gate own every decision. */
export interface ReviewState {
  attemptAt: number; successAt: number; evidenceAt: number; screenAt: number;
  actor: string | null; error: string | null;
}
export interface ReviewSettings { enabled: boolean; paper: boolean; auto: boolean; minutes?: number }
const MIN_GAP=5*60_000;
interface ReviewDependencies<T> {
  settings:()=>ReviewSettings; now:()=>number; screenAt:()=>number;
  load:()=>Partial<ReviewState>|undefined; save:(s:ReviewState)=>void; evaluate:(actor:string)=>Promise<T>;
}
export class EvidenceReview<T> {
  private state:ReviewState;
  private running:Promise<T>|null=null;
  private deps:ReviewDependencies<T>;
  constructor(deps:ReviewDependencies<T>){
    this.deps=deps;
    this.state={attemptAt:0,successAt:0,evidenceAt:0,screenAt:0,actor:null,error:null,...deps.load()};
  }
  noteEvidence(){this.state.evidenceAt=this.deps.now();this.persist();}
  private persist(){this.deps.save({...this.state});}
  private interval(){return Math.max(5,Math.min(1440,this.deps.settings().minutes??15))*60_000;}
  view(){
    const c=this.deps.settings(),s=this.state;
    const due=s.evidenceAt>s.successAt?s.successAt+MIN_GAP:s.successAt+this.interval();
    return {...s,enabled:c.enabled&&c.paper&&c.auto,paper:c.paper,running:!!this.running,
      intervalMinutes:this.interval()/60_000,evidenceMinutes:5,nextAt:Math.max(due,s.attemptAt+MIN_GAP)};
  }
  /** Nightly, pair-agent, manual and scheduled reviews share one in-flight operation. */
  run(actor:string):Promise<T>{
    if(this.running)return this.running;
    const started=this.deps.now(),screenAt=this.deps.screenAt();
    this.state={...this.state,attemptAt:started,actor,error:null};this.persist();
    this.running=Promise.resolve().then(()=>this.deps.evaluate(actor)).then(result=>{
      this.state={...this.state,successAt:started,screenAt:Math.max(this.state.screenAt,screenAt),error:null};this.persist();
      return result;
    }).catch(error=>{
      this.state.error=String(error instanceof Error?error.message:error).slice(0,300);this.persist();throw error;
    }).finally(()=>{this.running=null;});
    return this.running;
  }
  async tick():Promise<T|undefined>{
    const c=this.deps.settings(),now=this.deps.now();
    if(!c.enabled||!c.paper||this.running||now<this.state.attemptAt+MIN_GAP)return;
    // A failed review never acknowledges a nightly screen; it remains retryable after restart.
    if(this.deps.screenAt()>this.state.screenAt)return this.run('nightly evidence');
    if(c.auto&&now>=this.view().nextAt)return this.run(this.state.evidenceAt>this.state.successAt?'closed-trade evidence':'scheduled evidence');
  }
}
