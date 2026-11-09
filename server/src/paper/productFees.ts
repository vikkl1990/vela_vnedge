import type { PaperConfig } from '../config.ts';

/** Public contract rates, in percent of notional, excluding GST and account promotions. */
export interface ProductFees {
  source: 'delta-product'; symbol: string; feeRatePct: number; makerFeeRatePct: number;
}

/** Delta returns fractions, not percentages. Missing/invalid fields must not become zero fees. */
export function productFees(p: {symbol: string; taker_commission_rate?: unknown; maker_commission_rate?: unknown} | undefined): ProductFees | undefined {
  if (!p) return undefined;
  const rate = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) ? Number(x) : NaN;
  const taker = rate(p.taker_commission_rate), maker = rate(p.maker_commission_rate);
  if (![taker,maker].every(n => Number.isFinite(n) && n >= 0 && n < 0.01)) return undefined;
  return {source:'delta-product',symbol:p.symbol,feeRatePct:taker*100,makerFeeRatePct:maker*100};
}

/** Apply to a NEW policy only. Held trades and pending orders retain their saved fee settings. */
export function withProductFees<T extends Pick<PaperConfig,'feeRatePct'|'makerFeeRatePct'>>(cfg:T, fees:ProductFees|undefined, symbol:string):T {
  if (!fees) return cfg;
  if (fees.symbol !== symbol || ![fees.feeRatePct,fees.makerFeeRatePct].every(n=>Number.isFinite(n)&&n>=0&&n<1)) throw new Error('invalid product fee specification');
  if (cfg.feeRatePct===fees.feeRatePct && cfg.makerFeeRatePct===fees.makerFeeRatePct) return cfg;
  return {...cfg,feeRatePct:fees.feeRatePct,makerFeeRatePct:fees.makerFeeRatePct};
}
