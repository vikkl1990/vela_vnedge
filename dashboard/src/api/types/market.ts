// ---------- Markets & candles ----------

export interface Market {
  symbol: string
  description: string
  tickSize: number
  contractValue: number
  markPrice: number
  change24hPct: number
  /** Asset class from the server's classifier (shared/assetClass.ts). */
  group?: string
  sector?: string
}

export interface AssetClassesResponse {
  groups: ReadonlyArray<{ key: string; label: string; hint: string }>
  sectors: ReadonlyArray<{ key: string; label: string }>
  classes: Record<string, { group: string; sector: string; tags: string[] }>
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Ticker {
  symbol: string
  price: number
  markPrice: number
  time: number
}
