export type ChartVenue = 'delta' | 'binance' | 'coinbase' | 'hyperliquid';
export function venueSymbol(symbol: string, venue: ChartVenue): string {
  if (venue === 'delta') return `delta:${symbol}`;
  if (!['BTCUSD', 'ETHUSD', 'SOLUSD'].includes(symbol)) throw new Error('Venue comparison currently supports BTC, ETH and SOL');
  const coin = symbol.slice(0, -3);
  return venue === 'binance' ? `binance:${coin}USDT.P` : venue === 'coinbase' ? `coinbase:${coin}-USD` : `hyperliquid:${coin}`;
}

/** start() includes the named bar: select the last bar CLOSED at the shared clock. */
export function replayOpenAt(cutoff: number, duration: number): number {
  return Math.floor(cutoff / duration) * duration - duration;
}
