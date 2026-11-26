import {PRECISION_NATIVE} from './sourceReaders.ts';
import {upstreamLifecycle} from './upstreamLifecycle.ts';
/** Validated native trade engines. This capability never grants evidence eligibility. */
export const NATIVE_REENTRY_SCANNERS = new Set([
  'structure-anchored-vwap-upstream-2-0',
  'synapse-trail-pro-author-native',
  'liquidity-trail-matrix-author-native',
  'reactive-trail-system-author-native',
  'reaction-level-matrix-author-native',
  'strat-trap-vwap-engine-author-native',
]);

export const nativeReentry = (id: string, reader?: number) =>
  reader === 3 && NATIVE_REENTRY_SCANNERS.has(id) ||
  reader === 2 && (id===PRECISION_NATIVE || id === 'stealthtrail-supertrend-author-native-v1' || upstreamLifecycle(id));
