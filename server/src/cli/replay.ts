/**
 * Does the live record match the backtest?
 *
 *   npm run replay
 *
 * Takes every closed live trade, runs its scanner through the backtester on the same bars, and
 * lines the two up trade by trade: did the backtest take it, and did it end the same way.
 *
 * This is the check that separates two very different explanations for a bad run. If the
 * backtest reproduces the live losses on the same bars, the engine is faithful and the losses are
 * the strategy meeting the market. If it does not, something in execution differs from what was
 * tested, and no amount of strategy work will fix that.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { Db } from '../db.ts';

const db = new Db();
const live = db.all<any>("SELECT id,scanner_id,symbol,side,entry_at,exit_at,entry_price,exit_price,realized_pnl,fees,risk_amount,exit_reason FROM positions WHERE bt=0 AND status='closed' ORDER BY entry_at");
const cfg = new ConfigStore().get(); const reg = new ScannerRegistry(); const rest = new DeltaRest(); const pool = new PinePool(2, 120000);
const tfMs = TF_SECONDS['15m'] * 1000;
const cache = new Map<string, any[]>();
let simWins = 0, liveWins = 0, matched = 0, simR = 0, liveR = 0;
console.log('  live                                      |  backtest on the same bars');
for (const t of live) {
  const key = `${t.scanner_id}:${t.symbol}`;
  if (!cache.has(key)) {
    const s = reg.get(t.scanner_id)!; const p = await rest.product(t.symbol);
    const market = { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) };
    const c = await rest.recentCandles(t.symbol, '15m', 600, TF_SECONDS['15m']);
    const bars = c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: t.symbol, tf: '15m', tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
    const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars, mode: 'backtest' });
    const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol: t.symbol, tf: '15m', bars, events: extractEvents(res.alerts, res.shapes, { derived }), cfg: cfg.paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', contractValue: market.contractValue, tickSize: market.tickSize });
    cache.set(key, bt.trades as any[]);
  }
  const lr = (t.realized_pnl - t.fees) / (t.risk_amount || 1);
  if (lr > 0) liveWins++; liveR += lr;
  // the backtest enters at the signal bar; live fills seconds after that bar closes
  const sim = cache.get(key)!.find(b => b.side === t.side && Math.abs(b.entryAt - t.entry_at) <= tfMs * 1.5);
  const lv = `#${String(t.id).padEnd(3)} ${t.symbol.padEnd(8)} ${t.side.padEnd(5)} ${lr.toFixed(2).padStart(6)}R ${String(t.exit_reason).padEnd(9)}`;
  if (!sim) { console.log(`  ${lv}             |  NOT TAKEN by the backtest`); continue; }
  matched++; const sr = sim.rMultiple ?? 0; if (sr > 0) simWins++; simR += sr;
  const agree = Math.sign(sr) === Math.sign(lr) ? 'same' : 'DIFFERENT';
  console.log(`  ${lv}             |  ${sr.toFixed(2).padStart(6)}R ${String(sim.exitReason).padEnd(9)} ${agree}`);
}
await pool.stop(); db.db.close();
console.log(`\n  live:     ${liveWins}/${live.length} won, total ${liveR.toFixed(2)}R`);
console.log(`  backtest: ${simWins}/${matched} won of the ${matched} it also took, total ${simR.toFixed(2)}R`);

