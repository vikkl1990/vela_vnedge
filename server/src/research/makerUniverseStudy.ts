import type {ExecutionPlan} from '../paper/executionPlans.ts';

/** Existing maker cells selected from the seven-day account journal, without ranking their P&L.
 * Both arms receive future source signals. No historical signal is admitted at activation.
 */
export const MAKER_UNIVERSE_CELLS = [
  ['btc-native','trend-impulse-channels-zeiierman-native','BTCUSD','1h'],
  ['eth-impulse','trend-impulse-channels-zeiierman','ETHUSD','1h'],
  ['sol-impulse','trend-impulse-channels-zeiierman-maker','SOLUSD','15m'],
  ['sol-liquidity','liquidity-trail-matrix-atr-maker','SOLUSD','15m'],
  ['eth-liquidity','liquidity-trail-matrix-atr-maker','ETHUSD','15m'],
  ['bnb-channel','half-trend-channel','BNBUSD','4h'],
  ['xrp-pivot','pivot-channel-breaks','XRPUSD','1h'],
  ['zec-slope','slope-ma-cross-acc-range-filter','ZECUSD','1h'],
  ['uni-rsi','reverse-rsi-signals','UNIUSD','1h'],
  ['link-impulse','trend-impulse-channels-zeiierman','LINKUSD','1h'],
  ['doge-impulse','trend-impulse-channels-zeiierman','DOGEUSD','1h'],
  ['m-engine','smart-money-engine','MUSD','1h'],
] as const;

export const MAKER_UNIVERSE_PLANS:ExecutionPlan[] = MAKER_UNIVERSE_CELLS.flatMap(([key,scannerId,symbol,tf]) =>
  (['control','candidate'] as const).map(role => ({
    id:`maker-v2-${key}-${role}`, revision:1, enabled:true, scannerId,symbol,tf,
    variant:'current' as const, referenceEquity:1000,
    label:`${symbol} ${tf} · ${key} · ${role==='control'?'current maker':'tick/depth maker v2'}`,
    comparison:{group:`maker-v2-${key}`,role,kind:'maker-fill' as const},
    ...(role==='candidate'?{makerFill:'tick-depth-v2' as const}:{}),
  })),
);
