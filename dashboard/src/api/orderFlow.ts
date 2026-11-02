export interface Footprint { openTime: number; levels: Array<{price: number; buyVolume: number; sellVolume: number}> }
export interface OrderFlowView {
  symbol: string; venue: string; unit: string; supported: boolean; connected: boolean;
  observedSince: number | null; lastTradeAt: number | null; retention: string; coverageBasis: string; dropped: number;
  bars: Array<Footprint & {buy: number; sell: number; unknown: number; trades: number; covered: boolean;
    observedMinutes: number; expectedMinutes: number; delta: number | null; cvd: number | null; cvdStart: number | null}>;
}
