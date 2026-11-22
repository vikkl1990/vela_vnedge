/** Read-only observations. None of these values admits a trade or changes its stop. */
export interface ReplayCoverage {
  capturing: boolean;
  segments: number;
  from: number | null;
  to: number | null;
  checkpoints: number;
  segmentsWithGaps: number;
  failures: number;
  dropped: number;
}
export interface PositionHealth {
  id: number;
  identity: { symbol: string; side: string; entryAt: number; entryPrice: number; qtyOpen: number; sl: number | null; realizedPnl: number; fees: number };
  at: number;
  closeNow: {
    netUsd: number | null; price: number | null; filledQty: number; requestedQty: number;
    grossExitFee: number | null; cashExitFee: number | null; feeDiscount: number | null;
    validForMs: number; depthAgeMs: number | null; reason: string | null;
  };
  stop: { price: number | null; state: 'none' | 'initial' | 'reduced-loss' | 'entry-price' | 'profit-level'; netAtLevel: number | null; liquidationBeforeStop: boolean };
  coverage: { policy: 'frozen' | 'adopted' | 'legacy'; entry: 'depth-recorded' | 'limit-observation' | 'receipt-only' | 'missing'; pendingFunding: number; replay: ReplayCoverage | null };
}
export interface PositionsHealth { at: number; positions: PositionHealth[] }
