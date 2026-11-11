/** Arrival-age protection, independent of strategy/pair selection and quiet-market age.
 * Five seconds matches the default tape fallback horizon. Stricter maker timing
 * still requires its existing one-second print; this does not relax that rule.
 */
export const MAX_TRADE_ARRIVAL_MS = 5000;
export type TradeObservation = {timeMs:number; price:number; qty:number; timeKnown?:boolean};
export function tradeRefusal(t:TradeObservation,receivedAt:number):string|null {
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return 'invalid receipt time';
  if (t.timeKnown === false || !Number.isFinite(t.timeMs) || t.timeMs <= 0) return 'unknown trade time';
  if (!Number.isFinite(t.price) || t.price <= 0 || !Number.isFinite(t.qty) || t.qty <= 0) return 'invalid trade price or quantity';
  if (t.timeMs > receivedAt + 2000) return 'future trade time';
  if (receivedAt - t.timeMs > MAX_TRADE_ARRIVAL_MS) return 'stale trade arrival';
  return null;
}
export function isExecutableTrade(t:TradeObservation,receivedAt=Date.now()):boolean {
  return tradeRefusal(t,receivedAt) === null;
}
