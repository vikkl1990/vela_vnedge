import { useCallback, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
export function QueryFreshness() {
  const client=useQueryClient(), cache=client.getQueryCache();
  const subscribe=useCallback((notify:()=>void)=>cache.subscribe(notify),[cache]);
  const snapshot=useCallback(()=>JSON.stringify(cache.getAll().filter(q=>q.isActive() && q.state.status==='error').map(q=>({key:q.queryHash,at:q.state.dataUpdatedAt}))),[cache]);
  const failed: {key:string;at:number}[]=JSON.parse(useSyncExternalStore(subscribe,snapshot,snapshot));
  if(!failed.length) return null;
  const at=Math.min(...failed.map(f=>f.at).filter(t=>t>0));
  return <div className="banner banner-warn small" role="alert"><b>{failed.length} data refresh{failed.length===1?'':'es'} failed.</b> Displayed values may be stale. {Number.isFinite(at) ? `Oldest affected data: ${new Date(at).toLocaleString()}. ` : 'Some data is unavailable. '}<button className="btn btn-sm" onClick={()=>void client.refetchQueries({type:'active'})}>Retry data</button></div>
}
