/**
 * Minimal Prometheus-style metrics registry (no dependencies). Counters are incremented by the
 * ops modules; gauges are sampled at render time through `gauge(name, help, fn)`. `render()`
 * produces the text exposition format (`# HELP` / `# TYPE` / samples).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

type Labels = Record<string, string | number>;

interface Counter { help: string; values: Map<string, { labels: Labels; value: number }> }
interface Gauge { help: string; sample: () => number | Array<{ labels: Labels; value: number }> | null }

/** Sliding one-minute window of event timestamps; `perMinute()` is the count in the last 60 s. */
export class RateWindow {
  private times: number[] = [];
  private windowMs: number;
  constructor(windowMs = 60_000) { this.windowMs = windowMs; }
  hit(now = Date.now()) { this.times.push(now); this.trim(now); }
  perMinute(now = Date.now()): number { this.trim(now); return this.times.length * (60_000 / this.windowMs); }
  private trim(now: number) { const cut = now - this.windowMs; let i = 0; while (i < this.times.length && this.times[i] < cut) i++; if (i) this.times.splice(0, i); }
}

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private loop: IntervalHistogram | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private cpuPct = 0;
  private prefix: string;

  constructor(prefix = 'vnedge_') {
    this.prefix = prefix;
    try { this.loop = monitorEventLoopDelay({ resolution: 20 }); this.loop.enable(); } catch { this.loop = null; }
    this.gauge('process_resident_memory_bytes', 'Resident set size in bytes', () => process.memoryUsage().rss);
    this.gauge('process_heap_used_bytes', 'V8 heap used in bytes', () => process.memoryUsage().heapUsed);
    this.gauge('process_cpu_percent', 'CPU usage of the process over the last sampling interval (0-100 per core)', () => this.sampleCpu());
    this.gauge('process_uptime_seconds', 'Seconds since process start', () => process.uptime());
    this.gauge('event_loop_lag_p50_ms', 'Event-loop delay median (ms)', () => this.loop ? this.loop.percentile(50) / 1e6 : null);
    this.gauge('event_loop_lag_p99_ms', 'Event-loop delay 99th percentile (ms)', () => this.loop ? this.loop.percentile(99) / 1e6 : null);
    this.gauge('event_loop_lag_max_ms', 'Event-loop delay maximum since last scrape (ms)', () => { if (!this.loop) return null; const v = this.loop.max / 1e6; this.loop.reset(); return v; });
  }

  /** Increment a counter (creates it on first use). */
  inc(name: string, help: string, labels: Labels = {}, by = 1) {
    let c = this.counters.get(name);
    if (!c) { c = { help, values: new Map() }; this.counters.set(name, c); }
    const key = labelKey(labels);
    const cur = c.values.get(key);
    if (cur) cur.value += by; else c.values.set(key, { labels, value: by });
  }

  /** Current value of a counter (sum over all label sets when `labels` is omitted). */
  value(name: string, labels?: Labels): number {
    const c = this.counters.get(name);
    if (!c) return 0;
    if (labels) return c.values.get(labelKey(labels))?.value ?? 0;
    let n = 0; for (const v of c.values.values()) n += v.value; return n;
  }

  /** Register (or replace) a gauge sampled on every render. Return null to omit the sample. */
  gauge(name: string, help: string, sample: Gauge['sample']) { this.gauges.set(name, { help, sample }); }

  /** Prometheus text exposition (version 0.0.4). */
  render(): string {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      const full = this.prefix + name;
      out.push(`# HELP ${full} ${escapeHelp(c.help)}`, `# TYPE ${full} counter`);
      for (const v of c.values.values()) out.push(`${full}${fmtLabels(v.labels)} ${fmt(v.value)}`);
    }
    for (const [name, g] of this.gauges) {
      const full = this.prefix + name;
      let sampled: ReturnType<Gauge['sample']>;
      try { sampled = g.sample(); } catch { sampled = null; }
      if (sampled === null || sampled === undefined) continue;
      out.push(`# HELP ${full} ${escapeHelp(g.help)}`, `# TYPE ${full} gauge`);
      if (typeof sampled === 'number') out.push(`${full} ${fmt(sampled)}`);
      else for (const v of sampled) out.push(`${full}${fmtLabels(v.labels)} ${fmt(v.value)}`);
    }
    return out.join('\n') + '\n';
  }

  /** JSON view of the same data (for dashboards / tests). */
  snapshot(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const [name, c] of this.counters) o[this.prefix + name] = c.values.size === 1 && c.values.has('') ? c.values.get('')!.value : [...c.values.values()];
    for (const [name, g] of this.gauges) { try { const v = g.sample(); if (v !== null && v !== undefined) o[this.prefix + name] = v; } catch { /* skip */ } }
    return o;
  }

  private sampleCpu(): number {
    const now = Date.now();
    const dt = now - this.lastCpuAt;
    if (dt >= 1000) {
      const u = process.cpuUsage(this.lastCpu);
      this.cpuPct = ((u.user + u.system) / 1000) / dt * 100;
      this.lastCpu = process.cpuUsage(); this.lastCpuAt = now;
    }
    return Math.round(this.cpuPct * 10) / 10;
  }

  stop() { try { this.loop?.disable(); } catch { /* ignore */ } }
}

function labelKey(l: Labels): string { return Object.keys(l).sort().map(k => `${k}=${l[k]}`).join(','); }
function fmtLabels(l: Labels): string {
  const keys = Object.keys(l).sort();
  if (!keys.length) return '';
  return '{' + keys.map(k => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',') + '}';
}
function fmt(v: number): string { return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toPrecision(10).replace(/\.?0+$/, '')) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN'; }
function escapeHelp(s: string): string { return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'); }
