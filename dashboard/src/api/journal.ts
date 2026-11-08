import type { TradeQuery } from './types'
export type JournalBook = 'paper' | 'shadow'
export interface JournalQuery extends TradeQuery { book: string; status: string; scope: string; history: string; dateBy: string; sort: string }
export interface JournalFill { at: number; price: number; qty: number; reason: string; fee: number; pnl: number; liquidity?: string; feeWaived?: boolean }
export interface JournalRow {
  id: number; book: JournalBook; archived: boolean; status: string; scannerId: string; scannerName: string; symbol: string; tf: string; side: string | null; evidenceScope: string;
  entryAt: number | null; exitAt: number | null; eventAt: number | null; entryPrice: number | null; exitPrice: number | null; qty: number | null; qtyOpen: number | null; contractValue: number | null;
  slOriginal: number | null; sl: number | null; targets: number[] | null; targetsHit: boolean[] | null; levelsSource: string | null;
  risk: number | null; notional: number | null; marginLeverage: number | null; margin: number | null;
  realizedNet: number | null; net: number | null; commission: number | null; funding: number | null; grossTrading: number | null; r: number | null; peakR: number | null; worstR: number | null;
  exitReason: string | null; mlProbability: number | null; policyId: string | null; configFingerprint: string | null; signalId: number | null;
  fills: JournalFill[] | null; accountingPending: boolean; source: string | null; missingPosition: boolean;
  pending: {price: number | null; expiresAt: number | null; dueAt: number | null} | null;
}
export interface JournalPage {
  at: number; book: JournalBook; total: number; offset: number; limit: number; rows: JournalRow[];
  summary: { archived: number; closed: number; open: number; pending: number; cancelled: number; net: number; commission: number; funding: number; grossTrading: number; wins: number; losses: number;
    winRate: number | null; profitFactor: number | null; noLosses: boolean; sumR: number | null; avgR: number | null; unknownFunding: number; unknownNet: number; unknownRisk: number; accountingPending: number };
}
export interface JournalDetail {
  row: JournalRow; signal: import('./types').Signal | null;
  policy: { id: string; strategyId: string; sourceHash: string; snapshot: unknown } | null;
  features: Record<string, number> | null; entryExecution: Record<string, unknown> | null;
  orders: {id: number; at: number; side: string; qty: number; price: number; fee: number; reason: string; price_source: string | null; ref_price: number | null; bid: number | null; ask: number | null; quote_at: number | null}[];
  decisions: {at: number; stage: string; reason: string | null; snapshot: unknown}[];
  pathCoverage: {samples: number; fromAt: number | null; throughAt: number | null}; caveats: string[];
}
