/** Commission and price-friction assumptions shared by admission, sizing and fills. */
import type { PaperConfig } from '../config.ts';
type FeeConfig = Pick<PaperConfig, 'feeRatePct' | 'feeTaxPct'> & Partial<Pick<PaperConfig, 'makerFeeRatePct'>>;
export interface EntryExecution { maker?: boolean; quoted?: boolean }
export function commissionRatePct(cfg: FeeConfig, maker = false): number {
  return (maker ? cfg.makerFeeRatePct ?? cfg.feeRatePct : cfg.feeRatePct) * (1 + (cfg.feeTaxPct ?? 0) / 100);
}
/** Conservative admission budget: never bank on a future closing-fee promotion or maker exit. */
export function admissionCostPct(cfg: FeeConfig, crossingPct = 0, entry: EntryExecution = {}): number {
  return commissionRatePct(cfg, !!entry.maker) + commissionRatePct(cfg) + Math.max(0, crossingPct) * (entry.maker ? 0.5 : 1);
}
/** Observed crossing replaces fallback spread/slippage. Additional stress is explicit. */
export function crossingSlippageBps(cfg: PaperConfig, crossingPct: number): number {
  return Math.max(0, crossingPct) * 50 + (cfg.quotedSlippageBps ?? 0);
}
/** A verified-current flag establishes future eligibility, never the original enrollment date. */
export function offerEffectiveFrom(cfg: PaperConfig): number | undefined {
  const o=cfg.scalperOffer;
  if(!o?.enabled)return undefined;
  if(o.joinedAt!==undefined&&(!Number.isFinite(o.joinedAt)||o.joinedAt<0))return undefined;
  if(o.verification){
    const v=o.verification;
    return v.source==='delta-india-trading-preferences' && /^[a-f0-9]{64}$/.test(v.accountHash) && !!v.connectionRevision &&
      Number.isSafeInteger(v.verifiedAt) && v.verifiedAt>0 && Number.isSafeInteger(v.effectiveFrom) && v.effectiveFrom>=v.verifiedAt
      ? Math.max(v.effectiveFrom,o.joinedAt??0) : undefined;
  }
  return Number.isFinite(o.joinedAt)&&o.joinedAt!>=0 ? o.joinedAt : undefined;
}
export function offerStatus(cfg: PaperConfig): 'disabled' | 'enrollment-recorded' | 'exchange-verified' | 'unverified-full-fees' {
  if(!cfg.scalperOffer?.enabled)return 'disabled';
  if(offerEffectiveFrom(cfg)===undefined)return 'unverified-full-fees';
  return cfg.scalperOffer.verification?'exchange-verified':'enrollment-recorded';
}
