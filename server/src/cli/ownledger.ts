/**
 * Decision 286: grade scripts by their own ledger. Each `strategy()` script runs exactly as its author wrote it (own entries,
 * stops, targets, exits and default inputs) and its closed and open trades are charged Delta's costs and stressed: open trades
 * marked to market, a one-bar delay, both halves, beyond the market's drift, both sides, t above 2. Read-only on the bot: it
 * fetches public candles, runs the scripts in worker processes and writes one JSON file.
 *
 * Usage: IDS=ids.txt [MARKETS=BTCUSD,ETHUSD,SOLUSD,XRPUSD] [TFS=1h,4h] [CONCURRENCY=2] [OUT=ownledger.json] \
 *        node src/cli/ownledger.ts
 * On the VM run it under `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19`, CONCURRENCY=2.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { PinePool, processWorker } from '../pine/pool.ts';
import { TF_SECONDS } from '../config.ts';
import { summariseOwnLedger, gradeOwnLedger, ownBarToWorkerBar, type OwnBar, type OwnCell } from '../research/ownLedger.ts';

if (!process.env.IDS) { console.error('IDS=<file of scanner ids> is required'); process.exit(2); }
const ids = [...new Set(fs.readFileSync(process.env.IDS, 'utf8').split(/\s+/).filter(Boolean))];
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD,XRPUSD').split(','), TFS = (process.env.TFS ?? '1h,4h').split(',');
const BARS: Record<string, number> = { '15m': 6000, '1h': 4000, '4h': 2000 };
const CONC = Number(process.env.CONCURRENCY ?? 2), OUT = process.env.OUT ?? 'ownledger.json';
const rest = new DeltaRest(), registry = new ScannerRegistry(), pool = new PinePool(CONC, 150_000, processWorker);

const series = new Map<string, { bars: OwnBar[]; tick: number }>();
for (const symbol of MARKETS) {
  const product: any = await rest.product(symbol);
  for (const tf of TFS) {
    if (!BARS[tf] || !TF_SECONDS[tf]) { console.error(`unsupported timeframe ${tf}`); process.exit(2); }
    const candles = await rest.recentCandles(symbol, tf, BARS[tf], TF_SECONDS[tf]);
    series.set(`${symbol}|${tf}`, { bars: candles.slice(0, -1).map((x: any) => [x.time * 1000, x.open, x.high, x.low, x.close, x.volume] as OwnBar), tick: Number(product?.tick_size ?? 0.5) });
  }
}

const results: any[] = [];
for (const id of ids) {
  const s = registry.get(id);
  if (!s || s.status !== 'ok') { results.push({ id, error: s ? `status ${s.status}` : 'unknown scanner' }); continue; }
  const fillsOnClose = /process_orders_on_close\s*=\s*true/.test(s.patched);
  const cells: OwnCell[] = [], errors: string[] = [];
  const jobs = MARKETS.flatMap(symbol => TFS.map(tf => ({ symbol, tf })));
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const j = jobs.shift(); if (!j) return;
      const { bars, tick } = series.get(`${j.symbol}|${j.tf}`)!;
      const r = await pool.run({ scannerId: id, source: s.patched, symbol: j.symbol, tf: j.tf, tickSize: tick,
        bars: bars.map(ownBarToWorkerBar), tailBars: 'all', plotTail: 0, ledger: true });
      if (!r.ok || !r.ledger) { errors.push(`${j.symbol} ${j.tf}: ${r.error ?? 'not a strategy()'}`); continue; }
      cells.push({ symbol: j.symbol, tf: j.tf, bars, fillsOnClose, trades: [...r.ledger.closed, ...r.ledger.open] });
    }
  }));
  const summary = summariseOwnLedger(cells), verdict = gradeOwnLedger(summary);
  results.push({ id, summary, verdict, errors });
  console.log(`${verdict.pass ? '*' : ' '} ${id.padEnd(44)} trades ${String(summary.trades + summary.open).padStart(5)} | net ${summary.net.toFixed(0).padStart(5)} bps | delayed ${summary.delayedNet.toFixed(0).padStart(5)} | halves ${summary.firstHalf.toFixed(0)}/${summary.secondHalf.toFixed(0)} | t ${summary.t.toFixed(1)}${verdict.pass ? '' : ' | failed: ' + verdict.failed.join(',')}${verdict.replicable ? '' : ` | NOT REPLICABLE: ${summary.partialExits} partial exits`}`);
}
fs.writeFileSync(OUT, JSON.stringify({ at: Date.now(), markets: MARKETS, tfs: TFS, results }, null, 1));
console.log(`wrote ${OUT}`);
process.exit(0);
