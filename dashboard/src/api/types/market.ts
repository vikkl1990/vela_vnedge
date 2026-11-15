// ---------- Markets & candles ----------

export interface Market {
  symbol: string
  description: string
  tickSize: number
  contractValue: number
  markPrice: number
  change24hPct: number
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
