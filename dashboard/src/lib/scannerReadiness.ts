import type {ReadinessRow,ScannerRole} from '../../../shared/scannerContracts.ts'
export const ROLE_LABELS:Record<ScannerRole,string>={strategy:'Strategy contract',entry:'Entry indicator',setup:'Setup detector',context:'Context indicator',exit:'Exit tool',manual:'Manual / restricted',unresolved:'Unresolved'}
export function filterReadiness(rows:ReadinessRow[],search:string,scope:string){
  const term=search.trim().toLowerCase()
  return rows.filter(r=>(!term||`${r.name} ${r.scannerId} ${r.author} ${r.cells.map(c=>c.symbol).join(' ')}`.toLowerCase().includes(term))&&
    (scope==='all'||scope==='research'&&!!r.planId||scope==='paper'&&r.enabled&&!r.planId||scope==='shadow'&&!r.planId&&r.cells.some(c=>c.book==='shadow'||c.book==='tracked')||scope==='review'&&r.contract.gaps.length>0||scope==='held'&&r.runtime==='held'))
}
