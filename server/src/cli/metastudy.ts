/** Research only. Reproducible MTF scanner readings; never wired into live entryFilter. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { PinePool, processWorker } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { readingOf } from '../scanners/reading.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { backtestPolicy } from '../paper/policy.ts';
import { createMetaStudy, META_CONTRACTS, META_PROFILES, type MetaScanner, type MetaCell } from '../meta/signals.ts';
import type { Bar } from '../data/candleStore.ts';

const outDir = path.resolve(process.env.OUT_DIR ?? 'data/reports/meta-study'); fs.mkdirSync(outDir, { recursive: true });
const cfg = new ConfigStore(process.env.META_CONFIG).get(), rest = new DeltaRest(), registry = new ScannerRegistry();
const pool = new PinePool(2, 120000, processWorker);
const end = Number(process.env.END_MS) || Math.floor(Date.now() / 14400000) * 14400000, start = end - (Number(process.env.DAYS) || 56) * 86400000, split = start + (end - start) / 2;
const symbols = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD').split(',');
const cacheDir = path.join(outDir, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const result: any = { researchOnly: true, start, end, split, profiles: META_PROFILES, contracts: META_CONTRACTS, coverage: [], readings: [], comparisons: [], prefixChecks: [], snapshots: [], errors: [], notes: ['Pine runs are research observations even if these scanners are disabled in live configuration.', 'Standalone vs meta uses identical current entry/exit policy per timeframe, isolating confirmation; it does not optimise scalp/swing exits.', 'R pools independent cells, not a portfolio. Historical spread/funding not provided.'] };
async function bars(symbol: string, tf: string): Promise<Bar[]> {
  const file = `${symbol}-${tf}-${end}.json`, existing = process.env.HISTORY_DIR && path.join(process.env.HISTORY_DIR, file), local = path.join(cacheDir, file);
  let b: Bar[];
  if (existing && fs.existsSync(existing)) b = JSON.parse(fs.readFileSync(existing, 'utf8'));
  else if (fs.existsSync(local)) b = JSON.parse(fs.readFileSync(local, 'utf8'));
  else {
    const from = tf === '1m' ? start : start - 500 * TF_SECONDS[tf] * 1000, all = new Map<number, Bar>();
    for (let t = from; t < end; t += 7 * 86400000) for (const c of await rest.candles(symbol, tf, Math.floor(t / 1000), Math.floor(Math.min(end, t + 7 * 86400000) / 1000), 12000)) if (c.time * 1000 >= from && c.time * 1000 + TF_SECONDS[tf] * 1000 <= end) all.set(c.time, { ...c, time: c.time * 1000 });
    b = [...all.values()].sort((a, b) => a.time - b.time); fs.writeFileSync(local, JSON.stringify(b));
  }
  let gaps = 0; for (let i = 1; i < b.length; i++) if (b[i].time - b[i - 1].time !== TF_SECONDS[tf] * 1000) gaps++;
  if (!b.length || b[0].time > start || b.at(-1)!.time + TF_SECONDS[tf] * 1000 < end || gaps) throw new Error(`${symbol} ${tf}: incomplete history`);
  result.coverage.push({ symbol, tf, bars: b.length, gaps }); return b;
}
const stats = (trades: any[]) => ({ trades: trades.length, sumR: trades.reduce((a, t) => a + (t.rMultiple ?? 0), 0), stops: trades.filter(t => t.exitReason === 'sl').length });
try {
  for (const symbol of symbols) {
    const market = marketSpec(await rest.product(symbol)), series: Record<string, Bar[]> = {};
    for (const tf of ['1m', '15m', '1h', '4h']) series[tf] = await bars(symbol, tf);
    for (const scannerId of Object.keys(META_CONTRACTS) as MetaScanner[]) {
      const s = registry.get(scannerId); if (!s || s.status !== 'ok') throw new Error(`unavailable scanner ${scannerId}`);
      const sc = cfg.scanners[scannerId] ?? {}, sourceHash = hash(s.patched), settingsHash = hash({ inputs: sc.inputs ?? {}, timezone: sc.timezone ?? 'UTC', reading: 'meta-v1' });
      async function compute(tf: string, b: Bar[]): Promise<MetaCell> {
        const key = hash([sourceHash, settingsHash, symbol, tf, hash(b)]), file = path.join(cacheDir, `${key}.json`);
        let res; if (fs.existsSync(file)) res = JSON.parse(fs.readFileSync(file, 'utf8'));
        else { res = await pool.run({ scannerId, source: s!.patched, symbol, tf, tickSize: market.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: sc.inputs, timezone: sc.timezone }); if (!res.ok) throw new Error(res.error); fs.writeFileSync(file, JSON.stringify(res)); }
        const read = readingOf(sc, scannerId, TF_SECONDS[tf] * 1000, s!.patched, s!.variantOf);
        const derived = applyRules({ scannerId, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, bars: b, mode: 'backtest', ...read.rule });
        const events = extractEvents(res.alerts, res.shapes, { derived, ...read.extract });
        return { scannerId, symbol, tf, sourceHash, settingsHash, bars: b, plots: res.plots, events, scheduled: true };
      }
      const cells: MetaCell[] = []; for (const tf of ['15m', '1h', '4h']) cells.push(await compute(tf, series[tf]));
      const study = createMetaStudy(scannerId, symbol, cells);
      for (const profile of ['scalp', 'swing'] as const) {
        const tf = META_PROFILES[profile].entryTf, ms = TF_SECONDS[tf] * 1000, decisions = study.triggerTimes(profile).filter(t => t.confirmedAt >= start && t.confirmedAt < end).map(t => study(profile, t.confirmedAt));
        const counts: Record<string, number> = {}; const reasons: Record<string, number> = {};
        for (const d of decisions) { counts[d.status] = (counts[d.status] ?? 0) + 1; reasons[d.reason] = (reasons[d.reason] ?? 0) + 1; }
        const ready = decisions.filter(d => d.status.startsWith('READY'));
        result.readings.push({ scannerId, symbol, profile, candidates: decisions.length, counts, reasons, uniqueReadyKeys: new Set(ready.map(d => d.key)).size });
        const allEvents = decisions.map(d => ({ kind: 'entry', side: d.trigger!.side, barTime: d.trigger!.barTime, barIndex: -1, tp: [], price: series[tf].find(b => b.time === d.trigger!.barTime)?.close, label: `meta study ${profile}`, message: d.reason, source: 'derived' } as ScanEvent));
        const readyBars = new Set(ready.map(d => d.trigger!.barTime));
        for (const variant of ['standalone', 'meta'] as const) {
          const policy = backtestPolicy(cfg, scannerId, tf, 'account');
          const bt = runBacktest({ scannerId, scannerName: s.name, symbol, tf, bars: series[tf], subBars: series['1m'], events: variant === 'standalone' ? allEvents : allEvents.filter(e => readyBars.has(e.barTime)), ...policy, ...market });
          const ts = bt.trades.filter(t => t.exitAt !== null && t.entryAt >= start);
          result.comparisons.push({ scannerId, symbol, profile, variant, ...stats(ts), first: stats(ts.filter(t => t.entryAt < split)), later: stats(ts.filter(t => t.entryAt >= split)), rejected: bt.rejected, costCoverage: bt.costCoverage });
        }
        // Prefix-test the join over identical Pine outputs for every historical trigger.
        let mismatches = 0;
        const prefixCells = cells.map(c => ({ ...c, bars: c.bars.filter(b => b.time + TF_SECONDS[c.tf] * 1000 <= split), plots: c.plots.map(p => ({ ...p, data: p.data.filter(v => v.time + TF_SECONDS[c.tf] * 1000 <= split) })), events: c.events.filter(e => e.barTime + TF_SECONDS[c.tf] * 1000 <= split) }));
        const prefix = createMetaStudy(scannerId, symbol, prefixCells);
        for (const d of decisions.filter(d => d.at <= split)) if (JSON.stringify(d) !== JSON.stringify(prefix(profile, d.at))) mismatches++;
        result.prefixChecks.push({ scannerId, symbol, profile, kind: 'join-cutoff', mismatches });
        result.snapshots.push(study(profile, end));
        fs.writeFileSync(path.join(outDir, `${scannerId}-${symbol}-${profile}-decisions.json`), JSON.stringify(decisions, null, 2));
      }
      if (symbol === symbols[0]) {
        const cut: MetaCell[] = []; for (const c of cells) cut.push(await compute(c.tf, c.bars.filter(b => b.time + TF_SECONDS[c.tf] * 1000 <= split)));
        const prefix = createMetaStudy(scannerId, symbol, cut);
        for (const profile of ['scalp', 'swing'] as const) {
          const times = study.triggerTimes(profile).filter(t => t.confirmedAt >= start && t.confirmedAt <= split).map(t => t.confirmedAt);
          const mismatches = times.filter(at => JSON.stringify(study(profile, at)) !== JSON.stringify(prefix(profile, at))).length;
          result.prefixChecks.push({ scannerId, symbol, profile, kind: 'pine-rerun-cutoff', evaluated: times.length, mismatches });
        }
      }
      console.error(`completed ${scannerId} ${symbol}`);
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(result, null, 2));
    }
  }
} catch (e) { result.errors.push(String(e)); throw e; }
finally { await pool.stop(); fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(result, null, 2)); }
