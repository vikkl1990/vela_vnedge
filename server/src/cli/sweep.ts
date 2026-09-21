/**
 * Broad sweep: every runnable script against a grid of timeframes and symbols.
 *
 *   npm run sweep -- [TFS] [SYMBOLS] [BARS] [LIMIT]
 *
 * Emits one tab-separated line per (script, timeframe, symbol) to stdout, so the result can be
 * aggregated however you like without re-running anything. Progress goes to stderr.
 *
 * A word on what this is for. Testing ~1600 scripts across several timeframes and symbols is tens
 * of thousands of comparisons, and at any sane significance level thousands of them will look
 * profitable by chance alone. The last time this fleet was selected that way, 27 candidates
 * survived an in-sample filter and only 4 survived walk-forward. So treat the output as a list of
 * things to *test*, never as a list of things that work: the selection step is the walk-forward,
 * not this file.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const [tfArg = '15m', symArg = 'BTCUSD', barsArg = '1500', limitArg = '0'] = process.argv.slice(2);
const TFS = tfArg.split(',').map(s => s.trim()).filter(t => t in TF_SECONDS);
const SYMBOLS = symArg.split(',').map(s => s.trim()).filter(Boolean);
const BARS = Number(barsArg);
const LIMIT = Number(limitArg);

const cfg = new ConfigStore().get();
const registry = new ScannerRegistry();
const rest = new DeltaRest();

let scripts = registry.all().filter(s => s.status === 'ok');
if (LIMIT > 0) scripts = scripts.slice(0, LIMIT);
console.error(`sweep: ${scripts.length} scripts x ${TFS.length} tf x ${SYMBOLS.length} symbols = ${scripts.length * TFS.length * SYMBOLS.length} runs`);

const pool = new PinePool(4, 120_000);
console.log(['scanner', 'tf', 'symbol', 'trades', 'wins', 'pnl', 'pf', 'avgR', 'maxDDpct', 'ms'].join('\t'));

const started = Date.now();
let done = 0, errors = 0, emitted = 0;
const total = scripts.length * TFS.length * SYMBOLS.length;

for (const tf of TFS) {
  for (const symbol of SYMBOLS) {
    let bars: Bar[] = [];
    let market = { contractValue: 0.001, tickSize: 0.5 };
    try {
      const product = await rest.product(symbol);
      market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
      const c = await rest.recentCandles(symbol, tf, BARS, TF_SECONDS[tf]);
      bars = c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    } catch (e: any) {
      console.error(`  ${tf}/${symbol}: no candles (${e?.message ?? e}), skipping ${scripts.length} scripts`);
      done += scripts.length;
      continue;
    }
    if (bars.length < 200) { console.error(`  ${tf}/${symbol}: only ${bars.length} bars, skipping`); done += scripts.length; continue; }

    for (const s of scripts) {
      try {
        const t0 = Date.now();
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
        if (!res.ok) { errors++; }
        else {
          const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars, mode: 'backtest' });
          const events = extractEvents(res.alerts, res.shapes, { derived });
          if (events.some(e => e.kind === 'entry')) {
            const bt = runBacktest({ scannerId: s.id, scannerName: s.name, symbol, tf, bars, events, cfg: cfg.paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', contractValue: market.contractValue, tickSize: market.tickSize });
            const st = bt.stats;
            if (st.trades > 0) {
              emitted++;
              console.log([s.id, tf, symbol, st.trades, st.wins, st.pnl.toFixed(2), st.profitFactor === null ? '' : st.profitFactor.toFixed(3), (st.avgR ?? 0).toFixed(3), st.maxDrawdownPct.toFixed(2), Date.now() - t0].join('\t'));
            }
          }
        }
      } catch { errors++; }
      if (++done % 100 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const left = (total - done) / Math.max(rate, 0.01);
        console.error(`  ${done}/${total} (${(done / total * 100).toFixed(0)}%) · ${emitted} with trades · ${errors} failed · ${rate.toFixed(1)}/s · ~${(left / 60).toFixed(0)} min left`);
      }
    }
  }
}
await pool.stop();
console.error(`done: ${done} runs, ${emitted} produced trades, ${errors} failed, ${((Date.now() - started) / 60000).toFixed(1)} min`);
