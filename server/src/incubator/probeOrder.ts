/** Probe unobserved/oldest markets first. Three quiet markets limit this pass, not the whole scanner. */
export function probeMarketOrder(markets:string[], observedAt:ReadonlyMap<string,number>):string[]{
  return [...markets].sort((a,b)=>(observedAt.get(a)??0)-(observedAt.get(b)??0));
}
