/** Research identity only. The established maker reader and its evidence stay unchanged. */
export const SOL_MAKER_FILTER_OFF = 'trend-impulse-channels-zeiierman-maker-filter-off';
export const SOL_MAKER_FILTER_SOURCE = 'trend-impulse-channels-zeiierman-maker';
export const SOL_MAKER_FILTER_SOURCE_SHA = '0c47ade7557ac23e25869b6a017d09a9773b525534a4fa35f5a0f6c06c1b07a5';
export const SOL_FILTER_PLAN_PREFIX = 'sol-filter-v1-';
/** Match source-specific risk checks; never use this alias for evidence identity. */
export const solMakerRiskSource = (id:string) => id===SOL_MAKER_FILTER_OFF?SOL_MAKER_FILTER_SOURCE:id;
export const solFilterPlan = (p:{id:string;scannerId:string;symbol:string;tf:string;revision:number}) =>
  ['on-candle','off-candle','on-tick','off-tick'].some(s=>p.id===SOL_FILTER_PLAN_PREFIX+s)
  && p.scannerId===(p.id.includes('-off-')?SOL_MAKER_FILTER_OFF:SOL_MAKER_FILTER_SOURCE)
  && p.symbol==='SOLUSD' && p.tf==='15m' && p.revision===1;
