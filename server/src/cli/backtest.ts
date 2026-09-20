/**
 * Standalone backtest: npm run backtest -- <scanner-id> [SYMBOL] [TF] [BARS]
 * Runs the script through PineTS on real Delta history and replays the paper engine.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';

const [id, symbol = 'BTCUSD', tf = '15m', barsArg = '1000'] = process.argv.slice(2);
if (!id) { console.error('usage: npm run backtest -- <scanner-id> [SYMBOL] [TF] [BARS]'); process.exit(1); }
const registry = new ScannerRegistry();
const s = registry.get(id);
if (!s) { console.error(`unknown scanner ${id}. Known: ${registry.all().map(x => x.id).join(', ')}`); process.exit(1); }
if (s.status !== 'ok') { console.error(`${id} is ${s.status}: ${s.reason}`); process.exit(1); }
const cfg = new ConfigStore().get();
const rest = new DeltaRest();
const product = await rest.product(symbol);
const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
const candles = await rest.recentCandles(symbol, tf, Number(barsArg), TF_SECONDS[tf]);
const bars = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
const pool = new PinePool(1, 180_000);
const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: 10 });
await pool.stop();
if (!res.ok) { console.error('script error:', res.error); process.exit(1); }
const events = extractEvents(res.alerts, res.shapes);
const exitMode = cfg.scanners[id]?.exitMode ?? 'both';
const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars, events, cfg: cfg.paper, exitMode, contractValue: market.contractValue, tickSize: market.tickSize });
console.log(`\n${s.name} — ${symbol} ${tf}, ${bars.length} bars (${new Date(bt.from).toISOString().slice(0, 10)} → ${new Date(bt.to).toISOString().slice(0, 10)}), script ${res.ms} ms`);
console.log(`events: ${events.length} (entries ${events.filter(e => e.kind === 'entry').length}, exits ${events.filter(e => e.kind === 'exit').length})  rejected: ${JSON.stringify(bt.rejected)}`);
const st = bt.stats;
console.log(`trades ${st.trades}  win ${st.winRatePct.toFixed(1)}%  pnl ${st.pnl.toFixed(2)} (${st.pnlPct.toFixed(2)}%)  fees ${st.fees.toFixed(2)}  PF ${st.profitFactor === null ? '-' : st.profitFactor.toFixed(2)}  avgR ${st.avgR?.toFixed(2) ?? '-'}  maxDD ${st.maxDrawdownPct.toFixed(2)}%`);
console.log('\nlast trades:');
for (const t of bt.trades.slice(0, 15)) console.log(`  ${new Date(t.entryAt).toISOString().slice(5, 16)} ${t.side.padEnd(5)} x${t.qty} in ${t.entryPrice.toFixed(1)} out ${t.exitPrice?.toFixed(1)} ${String(t.exitReason).padEnd(11)} pnl ${t.pnl.toFixed(2).padStart(9)} R ${(t.rMultiple ?? 0).toFixed(2)}`);
