/**
 * A strategy() script's trade ledger, as the runtime leaves it after a run, turned into the worker's
 * machine messages: one per fill, at the bar it filled on.
 *
 * Decision 111: an entry that filled on the LAST bar of the run — the one the live engine acts on — also
 * carries the stop and limit the strategy itself placed for it (`strategy.exit`), read from the orders
 * still resting when the run ended. The runtime keeps no per-trade history of resting orders, so an
 * earlier entry carries none: historical and backtest fills are exactly as before, and the per-cell
 * `script` diagnose variant stays the measurement of whether a strategy's own levels beat the fallback.
 */

export interface LedgerTrade {
  id?: string; entry_id?: string; size: number; status?: 'open' | 'closed';
  entry_bar_index?: number; entry_price: number; exit_bar_index?: number; exit_price?: number;
}
export interface LedgerOrder {
  id?: string; status?: 'pending' | 'filled' | 'cancelled'; category?: 'entry' | 'exit';
  type?: 'market' | 'limit' | 'stop' | 'stop-limit'; stop?: number; limit?: number; direction?: number;
  from_entry?: string; _intended_trade_ids?: string[];
}
export interface LedgerState { opentrades?: LedgerTrade[]; closedtrades?: LedgerTrade[]; pending_orders?: LedgerOrder[] }
export interface LedgerAlert { barIndex: number; time: number; type: 'alert'; title: 'strategy'; message: string }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The stop and the limits the strategy has resting against one open trade, on the right side of its entry. */
export function restingLevels(t: LedgerTrade, orders: LedgerOrder[], openTrades: number): { sl?: number; tp: number[] } {
  const long = t.size > 0;
  const forThis = (o: LedgerOrder) => {
    if (o.status && o.status !== 'pending') return false;
    if (o.category === 'entry') return false;
    if (o._intended_trade_ids?.length && t.id) return o._intended_trade_ids.includes(t.id);
    if (o.from_entry && t.entry_id) return o.from_entry === t.entry_id;
    // an exit order that names no entry belongs to the position; with one open trade that is this one
    return openTrades === 1 && o.category === 'exit';
  };
  const mine = orders.filter(forThis);
  const stops = mine.map(o => o.stop).filter((v): v is number => num(v) && (long ? v < t.entry_price : v > t.entry_price));
  const limits = mine.map(o => o.limit).filter((v): v is number => num(v) && (long ? v > t.entry_price : v < t.entry_price));
  // the stop nearest the entry is the one that fills first
  const sl = stops.length ? (long ? Math.max(...stops) : Math.min(...stops)) : undefined;
  const tp = [...new Set(limits)].sort((a, b) => (long ? a - b : b - a)).slice(0, 3);
  return { sl, tp };
}

/** The worker's machine messages for every fill from `fromIdx` on; `lastIdx` is the run's last bar. */
export function ledgerAlerts(st: LedgerState, fromIdx: number, lastIdx: number, timeAt: (i: number) => number): LedgerAlert[] {
  const out: LedgerAlert[] = [];
  const seen = new Set<string>();
  const open = st.opentrades ?? [];
  const emit = (idx: number | undefined, verb: 'entry' | 'exit', side: string, price: number, extra = '') => {
    if (idx === undefined || idx === null || idx < fromIdx || !(price > 0)) return;
    const k = `${idx}:${verb}:${side}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ barIndex: idx, time: timeAt(idx), type: 'alert', title: 'strategy', message: `STRATEGY ${verb} ${side} @ ${price}${extra}` });
  };
  for (const t of [...(st.closedtrades ?? []), ...open]) {
    const side = t.size > 0 ? 'long' : 'short';
    let extra = '';
    if (t.status !== 'closed' && t.exit_bar_index === undefined && t.entry_bar_index === lastIdx) {
      const lv = restingLevels(t, st.pending_orders ?? [], open.length);
      if (lv.sl !== undefined) extra += ` sl=${lv.sl}`;
      if (lv.tp.length) extra += ` tp=${lv.tp.join(',')}`;
    }
    emit(t.entry_bar_index, 'entry', side, Number(t.entry_price), extra);
    if (t.status === 'closed' || t.exit_bar_index !== undefined) emit(t.exit_bar_index, 'exit', side, Number(t.exit_price));
  }
  return out;
}
