import type {Bar} from '../data/candleStore.ts';

/** Research entry model. All transitions use completed one-minute candles. */
export interface ReclaimOptions {
  pullbackAtr: number;
  setupMinutes: number;
  orderMinutes: number;
  structuralStop?: boolean;
  stopBufferAtr?: number;
  maxHoldMinutes?: number;
}
export interface ReclaimSetup {
  side: 'long' | 'short'; at: number; reference: number; atr: number; stop: number; tick: number;
}
export interface ReclaimState extends ReclaimSetup {
  options: ReclaimOptions; phase: 'pullback' | 'reclaim' | 'order';
  last?: Bar; extreme: number; limit?: number; placedAt?: number; orderStop?: number;
}
export type ReclaimStep = {kind: 'waiting' | 'placed'} | {kind: 'filled'; price: number; stop: number; at: number}
  | {kind: 'cancelled'; reason: string};
export function createReclaim(setup: ReclaimSetup, options: ReclaimOptions): ReclaimState {
  if (![setup.at, setup.reference, setup.atr, setup.stop, setup.tick, options.pullbackAtr,
    options.setupMinutes, options.orderMinutes, options.stopBufferAtr ?? 0].every(Number.isFinite)
    || setup.reference <= 0 || setup.atr <= 0 || setup.tick <= 0 || options.pullbackAtr < 0
    || !Number.isInteger(options.setupMinutes) || options.setupMinutes < 2
    || !Number.isInteger(options.orderMinutes) || options.orderMinutes < 1 || (options.stopBufferAtr ?? 0) < 0
    || (options.maxHoldMinutes !== undefined && (!Number.isInteger(options.maxHoldMinutes) || options.maxHoldMinutes < 1))
    || (setup.side === 'long' ? setup.stop >= setup.reference : setup.stop <= setup.reference)) throw Error('invalid reclaim setup');
  return {...setup, options: {...options}, phase: 'pullback', extreme: setup.reference};
}
export function advanceReclaim(s: ReclaimState, bar: Bar, observedAt: number, through = true): ReclaimStep {
  const minute = 60_000;
  if (bar.time < s.at || bar.time + minute > observedAt || (s.last && bar.time <= s.last.time)) return {kind: 'waiting'};
  const expected = s.last ? s.last.time + minute : Math.ceil(s.at / minute) * minute;
  if (bar.time !== expected) return {kind: 'cancelled', reason: 'minute data gap'};
  if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    || bar.low <= 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)) return {kind: 'cancelled', reason: 'invalid minute candle'};
  const previous = s.last;
  s.last = {...bar};
  const long = s.side === 'long';
  if (s.phase === 'order') {
    if (bar.time >= s.placedAt! + s.options.orderMinutes * minute) return {kind: 'cancelled', reason: 'order expired'};
    const hit = long ? (through ? bar.low < s.limit! : bar.low <= s.limit!) : (through ? bar.high > s.limit! : bar.high >= s.limit!);
    // Fill at the limit even on a gap through it. The replay charges the adverse stop
    // first if this minute also crossed the stop; it cannot claim an intraminute target.
    if (hit) return {kind: 'filled', price: s.limit!, stop: s.orderStop!, at: bar.time};
    return {kind: 'waiting'};
  }
  if (bar.time + minute > s.at + s.options.setupMinutes * minute) return {kind: 'cancelled', reason: 'setup expired'};
  if (long ? bar.low <= s.stop : bar.high >= s.stop) return {kind: 'cancelled', reason: 'setup invalidated'};
  s.extreme = long ? Math.min(s.extreme, bar.low) : Math.max(s.extreme, bar.high);
  if (s.phase === 'pullback') {
    if (long ? bar.low <= s.reference - s.options.pullbackAtr * s.atr : bar.high >= s.reference + s.options.pullbackAtr * s.atr) s.phase = 'reclaim';
    return {kind: 'waiting'}; // never infer pullback then reclaim within this same candle
  }
  if (!previous || !(long ? bar.close > previous.high : bar.close < previous.low)) return {kind: 'waiting'};
  const raw = long ? previous.high : previous.low;
  const limit = Number(((long ? Math.floor(raw / s.tick + 1e-9) : Math.ceil(raw / s.tick - 1e-9)) * s.tick).toPrecision(14));
  if (!(long ? limit < bar.close : limit > bar.close)) return {kind: 'waiting'};
  const buffer = Math.max(s.tick, (s.options.stopBufferAtr ?? 0) * s.atr);
  const stop = s.options.structuralStop ? (long ? s.extreme - buffer : s.extreme + buffer) : s.stop;
  if (!(long ? stop < limit : stop > limit)) return {kind: 'cancelled', reason: 'invalid trigger stop'};
  s.phase = 'order'; s.limit = limit; s.orderStop = stop; s.placedAt = bar.time + minute;
  return {kind: 'placed'};
}
