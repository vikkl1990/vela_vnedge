/** Signal-unit profile used by the existing server reader. Exchange lot sizing is separate.
 * Preserve this profile when comparing browser runs; changing it requires versioned evidence. */
export function signalSymbolInfo(symbol:string,tickSize:number,timezone='Etc/UTC',description?:string){
 const tick=tickSize||0.5,pricescale=Math.round(1/tick),sym=symbol.replace(/^DELTA:/i,''),base=sym.replace(/USDT?$/i,'');
 return {current_contract:'',description:description??`${base} Perpetual`,isin:'',main_tickerid:`DELTA:${sym}`,prefix:'DELTA',root:sym,ticker:sym,tickerid:`DELTA:${sym}`,type:'crypto',basecurrency:base,country:'',currency:'USD',timezone:timezone||'Etc/UTC',employees:0,industry:'',sector:'',shareholders:0,shares_outstanding_float:0,shares_outstanding_total:0,expiration_date:0,session:'24x7',volumetype:'base',mincontract:0.000001,minmove:1,mintick:tick,pointvalue:1,pricescale,recommendations_buy:0,recommendations_buy_strong:0,recommendations_date:0,recommendations_hold:0,recommendations_sell:0,recommendations_sell_strong:0,recommendations_total:0,target_price_average:0,target_price_date:0,target_price_estimates:0,target_price_high:0,target_price_low:0,target_price_median:0};
}
export function signalMetadataText(info:Record<string,unknown>){
 const fields=signalSymbolInfo(String(info.ticker??''),Number(info.mintick)||.5);
 return JSON.stringify(Object.keys(fields).sort().map(k=>[k,k==='timezone'&&['UTC','Etc/UTC'].includes(String(info[k]))?'UTC':info[k]??null]));
}
