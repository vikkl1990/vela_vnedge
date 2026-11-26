import { Db } from '../../src/db.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { PaperEngine } from '../../src/paper/engine.ts';
import { sourceHash } from '../../src/paper/fingerprint.ts';
import { IncubatorStore } from '../../src/incubator/store.ts';
import { ShadowRunner } from '../../src/incubator/shadow.ts';

export function shadowRecovery(file: string) {
  const db = new Db(file),
    cfg = structuredClone(DEFAULT_CONFIG),
    closeAt = Date.now();
  cfg.incubator.enabled = true;
  cfg.incubator.mirror = { enabled: false };
  cfg.risk.regime.enabled = false;
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  Object.assign(cfg.paper, {
    trendGate: { enabled: false, emaLen: 50, tf: '', mode: 'follow' },
    minRiskFeeRatio: 0,
    feeRatePct: 0,
    makerFeeRatePct: 0,
    slippageBps: 0,
    fillSource: 'candles',
    latencyMs: 0,
    liquidation: false,
  });
  const source = 'alert("LONG | Price: 100")',
    paper = new PaperEngine(db, () => cfg, { book: 2 });
  paper.sourceHashFor = () => sourceHash(source);
  paper.sourceCodeFor = () => source;
  const store = new IncubatorStore(db),
    pair =
      store.find('s', 'BTCUSD', '15m') ??
      store.move({ scannerId: 's', symbol: 'BTCUSD', tf: '15m' }, 'shadow', 'test');
  const bars = Array.from({ length: 80 }, (_, i) => ({
    time: closeAt - (80 - i) * 900000,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 100,
  }));
  const runner = new ShadowRunner({
    store,
    cfgRef: () => cfg,
    paper,
    candles: { get: () => bars },
    registry: { get: () => ({ id: 's', name: 'S', status: 'ok', patched: source }) },
    marketInfo: async () => ({ tickSize: 0.01, contractValue: 1 }),
    pool: {
      run: async () => ({
        ok: true,
        alerts: [{ type: 'alert', time: bars.at(-1)!.time, barIndex: 79, message: 'LONG | Price: 100' }],
        labels: [],
        plots: [],
        shapes: [],
        ms: 1,
      }),
    },
  } as any) as any;
  return { db, cfg, paper, store, pair, runner, bars, closeAt };
}
