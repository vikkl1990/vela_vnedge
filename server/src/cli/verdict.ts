/**
 * Fleet verdict: backtest every runnable scanner on the given symbols/timeframe with a
 * paper-config override and print a ranked table.
 * Usage: node src/cli/verdict.ts [SYMBOLS=BTCUSD,ETHUSD] [TF=15m] [BARS=1500] [JSON paper override]
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';

const [symArg = 'BTCUSD,ETHUSD', tf = '15m', barsArg = '1500', overrideJson = '{}'] = process.argv.slice(2);
const symbols = symArg.split(',');
const cfg = new ConfigStore().get();
const paper = { ...cfg.paper, ...JSON.parse(overrideJson) };
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(4, 180_000);

const markets: Record<string, { contractValue: number; tickSize: number; bars: any[] }> = {};
for (const symbol of symbols) {
  const product = await rest.product(symbol);
  const candles = await rest.recentCandles(symbol, tf, Number(barsArg), TF_SECONDS[tf]);
  markets[symbol] = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5), bars: candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) };
}
console.log(`purse ${paper.initialEquity} · sizing ${paper.sizingMode}${paper.sizingMode === 'quality' ? ` ${paper.minLeverage}x–${paper.maxLeverage}x by score` : ` ${paper.riskPerTradePct}% risk`} · liquidation ${paper.liquidation ? 'on' : 'off'} · ${symbols.join('+')} ${tf} × ${barsArg} bars`);

const rows: any[] = [];
await Promise.all(registry.runnable().map(async (s) => {
  let trades = 0, wins = 0, pnl = 0, fees = 0, gp = 0, gl = 0, liq = 0, wiped = 0, maxDd = 0, scored = 0;
  for (const symbol of symbols) {
    const m = markets[symbol];
    const r = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: m.tickSize, bars: m.bars, tailBars: 'all', plotTail: 5 });
    if (!r.ok) continue;
    const events = extractEvents(r.alerts, r.shapes, { derived: applyRules({ scannerId: s.id, alerts: r.alerts, shapes: r.shapes, labels: r.labels, bars: m.bars, mode: 'backtest' }) });
    scored += events.filter(e => e.kind === 'entry' && e.score !== undefined).length;
    const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars: m.bars, events, cfg: paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', contractValue: m.contractValue, tickSize: m.tickSize });
    trades += bt.stats.trades; wins += bt.stats.wins; pnl += bt.stats.pnl; fees += bt.stats.fees; gp += bt.stats.grossProfit; gl += bt.stats.grossLoss;
    liq += bt.trades.filter(t => t.exitReason === 'liquidation').length; if (bt.rejected['purse_wiped']) wiped++;
    maxDd = Math.max(maxDd, bt.stats.maxDrawdownPct);
  }
  rows.push({ id: s.id, name: s.name, trades, winPct: trades ? wins / trades * 100 : 0, pnl, pnlPct: pnl / paper.initialEquity * 100, pf: gl > 0 ? gp / gl : gp > 0 ? 99 : 0, fees, liq, wiped, maxDd, scoredPct: trades ? scored / Math.max(1, trades) * 100 : 0 });
}));
await pool.stop();

rows.sort((a, b) => b.pnl - a.pnl);
const pad = (v: any, n: number) => String(v).padStart(n);
console.log('\n' + 'scanner'.padEnd(36) + pad('trades', 7) + pad('win%', 6) + pad('PF', 6) + pad('pnl', 10) + pad('pnl%', 8) + pad('maxDD%', 8) + pad('liq', 5) + pad('wiped', 6));
for (const r of rows) console.log(r.name.slice(0, 35).padEnd(36) + pad(r.trades, 7) + pad(r.winPct.toFixed(0), 6) + pad(r.pf.toFixed(2), 6) + pad(r.pnl.toFixed(0), 10) + pad(r.pnlPct.toFixed(0) + '%', 8) + pad(r.maxDd.toFixed(0) + '%', 8) + pad(r.liq, 5) + pad(r.wiped, 6));
const tot = rows.reduce((a, r) => ({ trades: a.trades + r.trades, pnl: a.pnl + r.pnl, liq: a.liq + r.liq, wiped: a.wiped + r.wiped, pos: a.pos + (r.pnl > 0 ? 1 : 0) }), { trades: 0, pnl: 0, liq: 0, wiped: 0, pos: 0 });
console.log(`\n${rows.length} scanners · ${tot.trades} trades · ${tot.pos} profitable scanners · liquidations ${tot.liq} · purses wiped ${tot.wiped} · sum of per-scanner pnl ${tot.pnl.toFixed(0)} (each scanner run on its own ${paper.initialEquity} purse)`);
