/**
 * Worker thread: runs one Pine script through PineTS against a candle array and returns a
 * compact, serialisable digest (alerts, shape hits, labels, plot tails). Runs isolated so a
 * runaway script cannot block the event loop of the main process.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PineTS, Indicator } from 'pinets';
import { DeltaPineProvider, type ProviderBar } from './provider.ts';
import { DeltaRest } from '../delta/rest.ts';
import { TF_SECONDS, TF_TO_PINE } from '../config.ts';

export interface WorkerJob {
  id: number;
  scannerId: string;
  source: string;
  symbol: string;
  tf: string;              // Delta resolution
  tickSize: number;
  bars: ProviderBar[];     // ascending, closed bars
  /** Return alerts/shape hits for the last N bars only (live) or all (backtest). */
  tailBars: number | 'all';
  /** Number of plot points to return for charting overlays. */
  plotTail: number;
  /** Per-script `input.*` overrides keyed by variable name or title (see pine/inputs.ts). */
  inputs?: Record<string, number | string | boolean>;
}

export interface WorkerAlert { barIndex: number; time: number; type: 'alert' | 'alertcondition'; title?: string; message: string }
export interface WorkerShape { title: string; shape?: string; location?: string; color?: string; times: number[] }
export interface WorkerLabel { time: number; y: number; text: string; color?: string; style?: string; barIndex?: number }
export interface WorkerPlot { title: string; style: string; overlay: boolean; color?: string; data: Array<{ time: number; value: number | null; color?: string }> }

export interface WorkerResult {
  id: number;
  ok: boolean;
  error?: string;
  ms: number;
  bars: number;
  lastBarTime: number;
  title?: string;
  overlay?: boolean;
  warnings: number;
  alerts: WorkerAlert[];
  shapes: WorkerShape[];
  labels: WorkerLabel[];
  plots: WorkerPlot[];
}

const rest = new DeltaRest();
const htfCache = new Map<string, { at: number; bars: ProviderBar[] }>();

async function fetchOther(symbol: string, deltaTf: string, bars: number, endMs: number): Promise<ProviderBar[]> {
  const key = `${symbol}:${deltaTf}`;
  const secs = TF_SECONDS[deltaTf] ?? (deltaTf === '1w' ? 604800 : 2592000);
  const cached = htfCache.get(key);
  if (cached && Date.now() - cached.at < secs * 1000 * 0.5 && cached.bars.length >= bars) return cached.bars;
  const endSec = Math.floor(endMs / 1000);
  let list: Awaited<ReturnType<typeof rest.candles>> = [];
  try { list = await rest.candles(symbol, deltaTf, endSec - secs * (bars + 2), endSec + secs, bars + 10); } catch (e) { console.warn(`[worker] HTF fetch ${symbol} ${deltaTf} failed: ${(e as Error).message}`); list = []; }
  const out = list.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  htfCache.set(key, { at: Date.now(), bars: out });
  return out;
}

function shapeKind(opts: any): string | undefined {
  const s = opts?.shape ?? opts?.char;
  return typeof s === 'string' ? s.replace(/^shape_/, '') : undefined;
}

async function runJob(job: WorkerJob): Promise<WorkerResult> {
  const t0 = Date.now();
  const base: WorkerResult = { id: job.id, ok: false, ms: 0, bars: job.bars.length, lastBarTime: job.bars.at(-1)?.time ?? 0, warnings: 0, alerts: [], shapes: [], labels: [], plots: [] };
  try {
    const provider = new DeltaPineProvider({ symbol: job.symbol, tf: job.tf, bars: job.bars, tickSize: job.tickSize, fetchOther });
    const pine = new PineTS(provider as any, job.symbol, TF_TO_PINE[job.tf] ?? '15', job.bars.length);
    pine.setAlertMode('all');
    pine.setMaxLoops(200_000);
    let program: string | Indicator = job.source;
    if (job.inputs && Object.keys(job.inputs).length) {
      // PineTS validates each override (type, minval/maxval, options); an invalid override fails the run rather than silently using the default
      const ind = new Indicator(job.source);
      const bad: string[] = [];
      for (const [k, v] of Object.entries(job.inputs)) { try { (ind.input as any)[k] = v; } catch (e: any) { bad.push(String(e?.message ?? e)); } }
      if (bad.length) throw new Error(`input overrides rejected: ${bad.join('; ')}`);
      program = ind;
    }
    const ctx: any = await pine.run(program as any);
    const n = job.bars.length;
    const fromIdx = job.tailBars === 'all' ? 0 : Math.max(0, n - job.tailBars);
    const timeAt = (i: number) => job.bars[i]?.time ?? 0;

    const alerts: WorkerAlert[] = [];
    for (const a of ctx.alerts ?? []) {
      if (a.bar_index < fromIdx) continue;
      alerts.push({ barIndex: a.bar_index, time: a.time ?? timeAt(a.bar_index), type: a.type, title: a.title, message: String(a.message ?? '') });
    }
    // strategy() scripts trade through strategy.entry / strategy.exit, not alerts. The runtime keeps
    // their ledger; each fill becomes a machine-readable message at the bar it FILLED on (by default
    // the bar after the signal), so a strategy can never be acted on before its order could exist.
    const st = ctx.strategy;
    if (st) {
      const seen = new Set<string>();
      const emit = (idx: number | undefined, verb: 'entry' | 'exit', side: string, price: number) => {
        if (idx === undefined || idx === null || idx < fromIdx || !(price > 0)) return;
        const k = `${idx}:${verb}:${side}`;
        if (seen.has(k)) return;
        seen.add(k);
        alerts.push({ barIndex: idx, time: timeAt(idx), type: 'alert', title: 'strategy', message: `STRATEGY ${verb} ${side} @ ${price}` });
      };
      for (const t of [...(st.closedtrades ?? []), ...(st.opentrades ?? [])]) {
        const side = t.size > 0 ? 'long' : 'short';
        emit(t.entry_bar_index, 'entry', side, Number(t.entry_price));
        if (t.status === 'closed' || t.exit_bar_index !== undefined) emit(t.exit_bar_index, 'exit', side, Number(t.exit_price));
      }
    }

    const shapes: WorkerShape[] = [];
    const plots: WorkerPlot[] = [];
    for (const [key, pl] of Object.entries<any>(ctx.plots ?? {})) {
      if (key.startsWith('__')) continue;
      const opts = pl.options ?? {};
      const data: any[] = pl.data ?? [];
      if (opts.style === 'shape' || opts.style === 'char') {
        const times: number[] = [];
        for (let i = Math.max(0, data.length - (job.tailBars === 'all' ? data.length : job.tailBars)); i < data.length; i++) {
          const d = data[i];
          if (d && d.value !== false && d.value !== null && d.value !== undefined && d.value !== 0 && !Number.isNaN(d.value)) times.push(d.time);
        }
        shapes.push({ title: pl.title ?? key, shape: shapeKind(opts), location: opts.location, color: opts.color, times });
        continue;
      }
      if (opts.style === 'fill' || opts.style === 'bgcolor' || opts.style === 'barcolor') continue;
      const tail = data.slice(-job.plotTail).map((d: any) => ({ time: d.time, value: (typeof d.value === 'number' && Number.isFinite(d.value)) ? d.value : null, color: d.options?.color ?? d.color }));
      if (tail.some(p => p.value !== null)) plots.push({ title: pl.title ?? key, style: opts.style ?? 'line', overlay: Boolean(ctx.indicator?.overlay ?? opts.overlay), color: opts.color, data: tail });
    }

    const labels: WorkerLabel[] = [];
    const rawLabels: any[] = ctx.plots?.__labels__?.data?.at(-1)?.value ?? [];
    for (const l of rawLabels.slice(-300)) {
      const y = Number(l.y ?? l.price);
      const t = Number(l.x ?? l.time ?? l.bar_time ?? 0);
      const time = (l.xloc === 'bar_index' || (t > 0 && t < 1e9)) ? timeAt(Math.round(t)) : t;
      if (!Number.isFinite(y)) continue;
      labels.push({ time, y, text: String(l.text ?? '').slice(0, 80), color: l.color, style: l.style });
    }

    return { ...base, ok: true, ms: Date.now() - t0, title: ctx.indicator?.title, overlay: ctx.indicator?.overlay, warnings: (ctx.warnings ?? []).length, alerts, shapes, labels, plots };
  } catch (e: any) {
    return { ...base, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) };
  }
}

if (parentPort) {
  parentPort.on('message', async (job: WorkerJob) => {
    const res = await runJob(job);
    parentPort!.postMessage(res);
  });
  parentPort.postMessage({ id: -1, ok: true, ready: true, worker: workerData?.index });
}
