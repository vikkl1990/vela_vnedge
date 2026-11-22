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

/** What is moving now: change over 5, 15 and 60 minutes from a short server-side price ring (null when it does not reach back that far). */
export interface MoverRow {
  symbol: string
  price: number
  ch5: number | null
  ch15: number | null
  ch60: number | null
  peak: number
  group: string
  sector: string
}
export interface MoversResponse {
  at: number
  windows: number[]
  /** Minutes of history the server holds, so the strip can say it is still warming up. */
  historyMinutes: number
  rows: MoverRow[]
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
