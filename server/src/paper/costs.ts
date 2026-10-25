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
