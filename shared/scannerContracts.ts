/** Read-only registry DTOs. These are not admission or trade-policy inputs. */
export type ScannerRole = 'strategy' | 'entry' | 'setup' | 'context' | 'exit' | 'manual' | 'unresolved';
export interface ContractSummary {
  role: ScannerRole;
  sourceStatus: string;
  publicationStatus: string;
  sourceHash: string;
  runtimeHash: string;
  contractVersion: string;
  reader: number;
  adapter: string;
  capabilities: string[];
  gaps: string[];
  intent: string;
}
export interface ReadinessCell {
  symbol: string; tf: string; book: 'paper' | 'shadow' | 'tracked' | 'research';
  state: string; lastAt: number | null; reason: string | null;
}
export interface ReadinessRow {
  key: string; scannerId: string; name: string; author: string; planId: string | null;
  enabled: boolean; contract: ContractSummary; cells: ReadinessCell[];
  runtime: 'held' | 'collecting' | 'scanning' | 'waiting' | 'unallocated';
  runtimeReasons: string[];
  profiles: {matching: number; other: number};
  activity: {signals: number; fills: number; pending: number; reasons: Record<string,number>; scope: string};
  policy: {signature: string | null; executionVersion: number | null; partialExitVersion: number | null; reversalEntryVersion: number | null; promotion: string};
}
export interface ScannerReadiness {
  at: number; from: number; rows: ReadinessRow[];
  summary: {scanners: number; plans: number; sourceMatched: number; reviewNeeded: number; collecting: number; held: number};
  notes: string[];
}
export interface ScannerContractDetail {
  id: string; name: string; url: string; planId: string | null; summary: ContractSummary;
  sourceReviewedAt: string | null; publicationReviewedAt: string | null;
  variant: {base: string; reason: string | null} | null;
  author: {entries: unknown[]; nonEntries: unknown[]; stop: unknown; targets: unknown; exit: unknown; timing: unknown; requirements: string | null};
  reading: Record<string,unknown>;
  policy: {exitMode: string; entryProtection: string; takeProfit: string | null; inputs: Record<string,unknown>; timezone: string; scannerOverrides: Record<string,unknown>};
  dependencies: string[]; cautions: string[]; historicalNotes: string[];
}
