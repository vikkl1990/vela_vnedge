import {isCrypto,withoutCachedBookVeto,type MarketsToday} from '../risk/marketGate.ts';

/** Explicit batches reach their requested markets; an all-refused assessment never becomes a turnover fallback. */
export function screenUniverse(tickers:Array<{symbol:string;contract_type?:string;description?:string;turnover_usd?:unknown}>,opts:{today?:MarketsToday;freshDepth:boolean;onlyMarkets:Set<string>|null;top:number;floor:number}) {
  const allowed=opts.today?.enabled?opts.today.markets.filter(m=>(opts.freshDepth&&m.reasons?withoutCachedBookVeto(m).allowed:m.allowed)&&/USD$/.test(m.symbol)).map(m=>m.symbol):[];
  const turnover=new Map(tickers.map(t=>[t.symbol,Number(t.turnover_usd)||0]));
  const base=opts.today?.enabled?allowed:tickers.filter(t=>t.contract_type==='perpetual_futures'&&isCrypto(t.description)&&/USD$/.test(t.symbol)&&Number(t.turnover_usd)>=opts.floor).map(t=>t.symbol);
  const symbols=[...new Set(base)].filter(s=>!opts.onlyMarkets||opts.onlyMarkets.has(s)).sort((a,b)=>(turnover.get(b)??0)-(turnover.get(a)??0)||a.localeCompare(b));
  return {symbols:symbols.slice(0,opts.onlyMarkets?Math.max(opts.top,opts.onlyMarkets.size):opts.top),allowedCount:allowed.length,hasVerdicts:!!opts.today?.enabled};
}
