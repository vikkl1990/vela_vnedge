/**
 * The incubator's daily job: screen one slice of the script library on every liquid market, then
 * judge the shadow book and the live fleet.
 *
 *   npm run incubate                 # today's slice (the library is covered once per `slices` days)
 *   SLICE=3 npm run incubate         # a given slice
 *   SLICE=none npm run incubate      # judge only, no screen
 *   WORKERS=4 LIMIT=20 …             # worker threads; LIMIT caps scripts (for a quick trial)
 *
 * Runs as its own process (a systemd timer on the VM) so screening never competes with the live
 * bot for its worker pool; it shares only the database, which the bot re-reads every few minutes.
 *
 * The screen is deliberately only a filter. Across ~1600 scripts and ~40 markets it makes tens of
 * thousands of comparisons, and hundreds will pass by luck; what it passes merely earns a slot in
 * the shadow book, where the evidence that decides promotion is collected (decision 17).
 */
import fs from 'node:fs';
import { Db } from '../db.ts';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { IncubatorStore } from '../incubator/store.ts';
import { evaluate, recordScreen, syncLive, type ScreenResult } from '../incubator/cycle.ts';
import { sliceOf } from '../incubator/gate.ts';

const started = Date.now();
const cfg = new ConfigStore().get();
const inc = cfg.incubator;
const db = new Db();
const store = new IncubatorStore(db);
const rest = new DeltaRest();
const TF = inc.tf, tfMs = TF_SECONDS[TF] * 1000;
const DAY = 86400_000;
const out = (m: string) => console.log(`[incubate ${new Date().toISOString().slice(0, 19)}] ${m}`);

const synced = syncLive(store, cfg);
out(`live fleet synced: +${synced.added} −${synced.removed}`);

// ADD=file.json: record screen results produced elsewhere (e.g. `npm run survey` on another machine),
// [{ scannerId, symbol, tf, result: ScreenResult }], before judging
if (process.env.ADD) {
  let added = 0;
  for (const x of JSON.parse(fs.readFileSync(process.env.ADD, 'utf8'))) {
    const k = recordScreen(store, { scannerId: x.scannerId, symbol: x.symbol, tf: x.tf }, { ...x.result, at: Date.now() }, inc);
    if (k === 'new' || k === 'updated') added++;
  }
  out(`recorded ${added} screen results from ${process.env.ADD}`);
}
const sliceArg = process.env.SLICE ?? String(Math.floor(Date.now() / DAY) % inc.screen.slices);
const summary: any = { at: started, slice: sliceArg, tf: TF, done: 0, scripts: 0, symbols: 0, runs: 0, silentSkipped: 0, failed: 0, passed: 0, new: 0, updated: 0, cooldown: 0 };

if (sliceArg !== 'none') {
  const slice = Number(sliceArg);
  // ---- universe: the most liquid USD perpetuals ----
  const tickers = await rest.tickers();
  const universe = tickers
    .filter((t: any) => t.contract_type === 'perpetual_futures' && /USD$/.test(t.symbol) && Number(t.turnover_usd ?? 0) >= inc.minTurnoverUsd)
    .sort((a: any, b: any) => Number(b.turnover_usd) - Number(a.turnover_usd))
    .slice(0, inc.universeTop).map((t: any) => String(t.symbol));
  summary.symbols = universe.length;
  out(`universe: ${universe.length} perpetuals over $${(inc.minTurnoverUsd / 1e6).toFixed(1)}M 24h turnover`);

  const registry = new ScannerRegistry();
  let scripts = registry.all().filter(s => s.status === 'ok' && sliceOf(s.id, inc.screen.slices) === slice);
  if (Number(process.env.LIMIT) > 0) scripts = scripts.slice(0, Number(process.env.LIMIT));
  summary.scripts = scripts.length;
  out(`slice ${slice}/${inc.screen.slices}: ${scripts.length} scripts × ${universe.length} markets`);

  // ---- candles, fetched once per market ----
  const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
  const data = new Map<string, { bars: Bar[]; m1: Bar[]; market: { contractValue: number; tickSize: number } }>();
  for (const symbol of universe) {
    try {
      const p = await rest.product(symbol);
      const bars = toBars(await rest.recentCandles(symbol, TF, inc.screen.bars, TF_SECONDS[TF]));
      if (bars.length < 500) { out(`  ${symbol}: only ${bars.length} bars, skipped`); continue; }
      const m1 = toBars(await rest.recentCandles(symbol, '1m', Math.ceil((bars.length + 2) * tfMs / 60_000), 60));
      data.set(symbol, { bars, m1, market: { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) } });
    } catch (e: any) { out(`  ${symbol}: no candles (${e?.message ?? e})`); }
  }
  out(`candles loaded for ${data.size} markets`);

  // ---- screen ----
  const pool = new PinePool(Number(process.env.WORKERS) || 4, 120_000);
  const skipStages = new Set(['live', 'demote_proposed', 'shadow', 'proposed']);
  const markets = [...data.keys()];
  for (const s of scripts) {
    let probed = 0, sawEntry = false;
    for (const symbol of markets) {
      // a script that produced no entry on its first three markets is not going to on the rest
      if (probed >= 3 && !sawEntry) { summary.silentSkipped += markets.length - probed; break; }
      probed++;
      const cur = store.find(s.id, symbol, TF);
      if (cur && skipStages.has(cur.stage)) continue;
      if (cur?.stage === 'retired' && Date.now() - cur.since < inc.cooldownDays * DAY) { summary.cooldown++; continue; }
      const d = data.get(symbol)!;
      summary.runs++;
      try {
        const inputs = cfg.scanners[s.id]?.inputs;
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf: TF, tickSize: d.market.tickSize, bars: d.bars, tailBars: 'all', plotTail: d.bars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined });
        if (!res.ok) { summary.failed++; continue; }
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars: d.bars, mode: 'backtest' });
        const events = extractEvents(res.alerts, res.shapes, { derived });
        if (!events.some(e => e.kind === 'entry')) continue;
        sawEntry = true;
        const base = { scannerId: s.id, scannerName: s.name, symbol, tf: TF, bars: d.bars, events, cfg: cfg.paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', contractValue: d.market.contractValue, tickSize: d.market.tickSize, subBars: d.m1 } as const;
        const bt = runBacktest(base);
        const stressed = runBacktest({ ...base, cfg: { ...cfg.paper, slippageBps: inc.screen.stressBps } });
        const trades = bt.trades as any[];
        const span = (d.bars.at(-1)!.time - d.bars[0].time) / 8;
        const w = new Array(8).fill(0);
        for (const t of trades) w[Math.min(7, Math.floor((t.entryAt - d.bars[0].time) / span))] += t.pnl;
        const gp = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
        const pf = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
        const r: ScreenResult = {
          pass: false, at: Date.now(), trades: trades.length, profitFactor: pf, netPnl: gp - gl, netAtStress: stressed.stats.pnl,
          windowsUp: w.filter(x => x > 0).length, winRatePct: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length * 100 : 0,
          avgR: trades.length ? trades.reduce((a, t) => a + (t.rMultiple ?? 0), 0) / trades.length : 0, bars: d.bars.length, days: (d.bars.at(-1)!.time - d.bars[0].time) / DAY,
        };
        r.pass = r.trades >= inc.screen.minTrades && r.profitFactor >= inc.screen.minProfitFactor && r.windowsUp >= inc.screen.minWindowsUp && r.netAtStress > 0;
        if (r.pass) summary.passed++;
        const k = recordScreen(store, { scannerId: s.id, symbol, tf: TF }, r, inc);
        if (k === 'new' || k === 'updated' || k === 'cooldown') summary[k]++;
      } catch (e: any) { summary.failed++; }
    }
    if (++summary.done % 25 === 0 || summary.done === scripts.length) out(`  ${summary.done}/${scripts.length} scripts · ${summary.runs} runs · ${summary.passed} passed`);
  }
  await pool.stop();
}

// ---- judge ----
const report = evaluate(store, cfg);
summary.report = report;
summary.ms = Date.now() - started;
db.kvSet('incubator.lastRun', summary);
out(`screen: ${summary.runs} runs, ${summary.passed} passed (${summary.new} new candidates), ${summary.silentSkipped} skipped as silent, ${summary.failed} failed`);
out(`judge: ${report.admitted.length} admitted to shadow, ${report.proposed.length} proposed, ${report.retired.length} retired, ${report.demoteProposed.length} proposed for demotion, ${report.brewing} brewing, ${report.free} free slots`);
for (const p of report.proposed) out(`  PROPOSED ${p}`);
for (const p of report.demoteProposed) out(`  DEMOTION PROPOSED ${p}`);
out(`done in ${(summary.ms / 60000).toFixed(1)} min`);
