import type {MonitorPair} from '../api/tradeMonitor.ts'
export type HeatMetric='paper'|'shadow'|'open'|'market'|'flow'
export function heatValue(pair:MonitorPair,metric:HeatMetric):number|null {
 if(metric==='paper'||metric==='shadow')return pair[metric].trades?pair[metric].r:null
 if(metric==='open')return pair.worstOpenR
 if(metric==='market')return pair.change24hPct
 return pair.flow?.covered?pair.flow.imbalance:null
}
export function heatLabel(value:number|null,metric:HeatMetric):string {
 if(value===null||!Number.isFinite(value))return 'No data'
 return `${value>=0?'+':''}${(metric==='flow'?value*100:value).toFixed(metric==='flow'?0:2)}${metric==='market'||metric==='flow'?'%':'R'}`
}
export function evidenceBook(book:number,scope:string):string{return book===0?'Paper':['shadow','legacy-shadow'].includes(scope)?'Shadow':'Research'}
