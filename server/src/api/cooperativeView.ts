/** Large read-only views share the event loop with feed, quote and exit timers.
 * Preserve order and the caller's timestamp; yielding never creates trade evidence. */
export async function mapForView<T,R>(rows:readonly T[],read:(row:T)=>R,
  {budgetMs=10,now=()=>performance.now()}:{budgetMs?:number;now?:()=>number}={}):Promise<R[]> {
 const out:R[]=[];let deadline=now()+budgetMs;
 for(let i=0;i<rows.length;i++){
  out.push(read(rows[i]));
  if(i+1<rows.length&&now()>=deadline){await new Promise<void>(resolve=>setImmediate(resolve));deadline=now()+budgetMs;}
 }
 return out;
}

/** Share only an in-flight report. A completed result is never reused as fresh data. */
export function singleFlightView<T>(read:()=>T|Promise<T>):()=>Promise<T>{
 let pending:Promise<T>|null=null;
 return()=>{
  if(pending)return pending;
  const task=Promise.resolve().then(read);pending=task;
  const clear=()=>{if(pending===task)pending=null;};
  void task.then(clear,clear);
  return task;
 };
}
