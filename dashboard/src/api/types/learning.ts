// ---- machine learning ----
export interface MlRule {
  feature: string
  label: string
  kind: 'prefer' | 'avoid'
  condition: string
  n: number
  coverage: number
  winRate: number
  avgR: number
  baselineAvgR: number
  lift: number
  text: string
}
export interface MlMetrics {
  economic?: {
    baselineBrier: number
    calibratedBrierSkill: number
    testNetR: number
    selectedN: number
    selectedNetR: number
    rejectedNetR: number
    threshold: number
  }
  holdout: number
  accuracy: number
  auc: number
  logLoss: number
  baseWinRate: number
}
export interface MlImportance {
  feature: string
  label: string
  weight: number
}
export interface MlScannerInsight {
  scannerId: string
  scannerName: string
  samples: number
  liveSamples: number
  baseline: { n: number; winRate: number; avgR: number }
  model: MlMetrics | null
  importance: MlImportance[]
  rules: MlRule[]
}
export interface MlSnapshot {
  timeframeModels?: Array<{ scannerId: string | null; tf: string; model: MlMetrics }>
  eligibility?: { stored: number; eligible: number; excluded: number }
  trainedAt: number | null
  samples: number
  liveSamples: number
  liveSinceReset: number
  scannersWithModel: number
  global: {
    model: MlMetrics | null
    importance: MlImportance[]
    rules: MlRule[]
    baseline: { n: number; winRate: number; avgR: number }
  } | null
  scanners: MlScannerInsight[]
  counts?: { total: number; live: number }
  config?: { minProb: number; useAsScore: boolean }
}
// ---- the gate's yardstick (decision 108) ----
export interface YardBucket {
  label: string
  lo: number
  hi: number
  n: number
  avgR: number
  winRatePct: number
  sumR: number
}
export interface YardThreshold {
  minProb: number
  kept: number
  keptAvgR: number
  keptSumR: number
  dropped: number
  droppedAvgR: number
  droppedSumR: number
  deltaSumR: number
}
export interface YardBook {
  trades: number
  scored: number
  scoredAtEntry: number
  unscored: number
  verifiedAtEntry: number
  allAvgR: number
  allSumR: number
  auc: number | null
  later: { trades: number; avgR: number; sumR: number; auc: number | null; buckets: YardBucket[] }
  buckets: YardBucket[]
  thresholds: YardThreshold[]
  verdict: { pays: boolean; minProb: number | null; text: string }
}
export interface MlYardstick {
  at: number
  windowDays: number
  model: { trainedAt: number | null; holdoutAuc: number | null; samples: number }
  config: { minProb: number; useAsScore: boolean }
  enriched: { cached: number; unscorable: number }
  live: YardBook
  shadow: YardBook
  call: { minProb: number | null; candidateMinProb?: number; text: string }
}
