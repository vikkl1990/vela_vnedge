/**
 * Validation module wiring + REST routes (registered through api/extensions.ts):
 *   candle cache → walk-forward service → OOS-aware auto-tune, shadow ledgers, consensus
 *   filter, per-script input overrides and generic rules.
 * Every endpoint is documented in docs/API.md.
 */
import type { App } from '../app.ts';
import type { Extension } from '../api/extensions.ts';
import { GENERIC_RULES, TF_SECONDS, type GenericRule } from '../config.ts';
import { CandleCache } from '../data/candleCache.ts';
import { logger } from '../log.ts';
import { parseInputs, validateInputOverrides } from '../pine/inputs.ts';
import { selectOscillator, selectTrail } from '../scanners/rules.ts';
import { ConsensusFilter } from './consensus.ts';
import { ValidationService } from './service.ts';
import { ShadowLedger } from './shadow.ts';

const log = logger.scoped('validation');

export interface ValidationModule { cache: CandleCache; service: ValidationService; shadow: ShadowLedger; consensus: ConsensusFilter }

const modules = new WeakMap<App, ValidationModule>();

/** Build (once per App) and wire the validation components into the running engine. */
export function attachValidation(app: App): ValidationModule {
  let m = modules.get(app);
  if (m) return m;
  const cfg = () => app.config.get();
  const h = cfg().validation.history;
  const cache = new CandleCache(app.db, app.rest, { chunkBars: h.chunkBars, delayMs: h.delayMs });
  if (h.enabled) app.scanners.setHistorySource(cache);
  const service = new ValidationService({ db: app.db, cfgRef: cfg, registry: app.registry, pool: app.pool, cache, scanners: app.scanners });
  const shadow = new ShadowLedger({ cfgRef: cfg, candles: app.candles, signals: app.scanners, marketInfo: s => app.scanners.marketInfo(s), db: app.db }).attach();
  const consensus = new ConsensusFilter(() => cfg().validation.consensus);
  app.scanners.setEntryFilter(c => consensus.shouldEnter(c));
  app.config.onChange(next => { app.scanners.setHistorySource(next.validation.history.enabled ? cache : null); service.reschedule(); });
  m = { cache, service, shadow, consensus };
  modules.set(app, m);
  log.info(`validation module ready (history ${h.enabled ? `${h.days}d cache` : 'off'}, shadow ${cfg().validation.shadow.enabled ? 'on' : 'off'}, consensus ${cfg().validation.consensus.enabled ? 'on' : 'off'}, oos auto-tune ${cfg().autoTune.oos.enabled ? 'on' : 'off'})`);
  return m;
}

export const validationRoutes: Extension = (add, app) => {
  const m = attachValidation(app);
  const a = app;

  // ---- walk-forward validation ----
  add('GET', '/api/validation', () => ({
    at: Date.now(), status: m.service.status,
    config: { ...a.config.get().validation, oos: a.config.get().autoTune.oos, tuneTimeframes: a.config.get().autoTune.tuneTimeframes, autoTune: { minTrades: a.config.get().autoTune.minTrades, minProfitFactor: a.config.get().autoTune.minProfitFactor } },
    results: m.service.summaries(),
    history: m.cache.status(),
    consensus: m.consensus.status(),
    autoTune: a.scanners.lastAutoTune ? { at: a.scanners.lastAutoTune.at, reason: a.scanners.lastAutoTune.reason, scanners: a.scanners.lastAutoTune.report.length, disabled: a.scanners.lastAutoTune.report.filter(r => r.disabled).length, provisional: a.scanners.lastAutoTune.report.filter(r => r.provisional).length, rule: a.scanners.lastAutoTune.report[0]?.rule ?? null } : null,
  }));
  add('POST', '/api/validation/run', async (_p, _u, body) => {
    const opts = { scanner: body?.scanner ? String(body.scanner) : undefined, symbol: body?.symbol ? String(body.symbol) : undefined, tf: body?.tf ? String(body.tf) : undefined, days: body?.days ? Number(body.days) : undefined };
    if (opts.tf && !(opts.tf in TF_SECONDS)) throw new Error(`unsupported tf ${opts.tf}`);
    if (opts.scanner && !a.registry.get(opts.scanner)) throw new Error('unknown scanner');
    if (body?.wait) { const r = await m.service.run(opts); return { ...r, status: m.service.status, results: opts.scanner ? m.service.forScanner(opts.scanner).summaries : m.service.summaries() }; }
    const status = m.service.start(opts);
    return { started: !status.finishedAt || status.running, jobs: m.service.jobs(opts).length, status };
  });
  add('GET', '/api/validation/history', () => ({ config: a.config.get().validation.history, requests: m.cache.requests, series: m.cache.status() }));
  add('POST', '/api/validation/history/fetch', (_p, _u, body) => {
    const cfg = a.config.get();
    const days = Math.max(1, Math.min(cfg.validation.history.days, Number(body?.days ?? cfg.validation.history.days)));
    const symbols: string[] = body?.symbol ? [String(body.symbol)] : [...new Set(a.scanners.requiredSeries().map(r => r.symbol))];
    const tfs: string[] = body?.tf ? [String(body.tf)] : [...new Set(a.scanners.requiredSeries().map(r => r.tf))];
    const started: Array<{ symbol: string; tf: string; bars: number }> = [];
    for (const symbol of symbols) for (const tf of tfs) {
      if (!(tf in TF_SECONDS)) continue;
      const bars = Math.ceil(days * 86_400 / TF_SECONDS[tf]);
      started.push({ symbol, tf, bars });
      void m.cache.getHistory(symbol, tf, bars).catch(e => log.warn(`prefetch ${symbol} ${tf} failed: ${e?.message ?? e}`));
    }
    return { started };
  });
  add('GET', '/api/validation/shadow', () => m.shadow.snapshot());
  add('POST', '/api/validation/shadow/reset', () => { m.shadow.reset(); return m.shadow.snapshot(); });
  add('GET', '/api/validation/consensus', () => m.consensus.status());
  add('GET', '/api/validation/auto-tune', () => a.scanners.lastAutoTune ?? { at: null, reason: null, report: [] });
  add('POST', '/api/validation/auto-tune', async (_p, _u, body) => {
    const at = a.config.get().autoTune;
    const oos = { ...at.oos, enabled: typeof body?.oos === 'boolean' ? body.oos : at.oos.enabled };
    const report = a.scanners.autoTune({ minTrades: Number(body?.minTrades ?? at.minTrades), minProfitFactor: Number(body?.minProfitFactor ?? at.minProfitFactor), oos, tuneTimeframes: typeof body?.tuneTimeframes === 'boolean' ? body.tuneTimeframes : at.tuneTimeframes, reason: 'api' });
    await a.onConfigChanged();
    return { tuned: report.length, disabled: report.filter(r => r.disabled).length, provisional: report.filter(r => r.provisional).length, rule: oos.enabled ? 'oos' : 'in-sample', report };
  });
  add('GET', '/api/validation/:scanner', p => {
    if (!a.registry.get(p.scanner)) throw new Error('unknown scanner');
    return m.service.forScanner(p.scanner);
  });

  // ---- per-script inputs and generic rules ----
  add('GET', '/api/scanners/:id/inputs', p => {
    const s = a.registry.get(p.id); if (!s) throw new Error('unknown scanner');
    const declarations = parseInputs(s.source);
    const overrides = a.config.get().scanners[p.id]?.inputs ?? {};
    const { errors } = validateInputOverrides(declarations, overrides);
    return { id: s.id, name: s.name, declarations, overrides, errors };
  });
  add('PUT', '/api/scanners/:id/inputs', async (p, _u, body) => {
    const s = a.registry.get(p.id); if (!s) throw new Error('unknown scanner');
    const declarations = parseInputs(s.source);
    const raw = body?.inputs ?? body ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be { inputs: { name: value } }');
    const { values, errors } = validateInputOverrides(declarations, raw);
    if (errors.length) return { ok: false, errors, overrides: a.config.get().scanners[p.id]?.inputs ?? {} };
    a.config.setScanner(p.id, { inputs: values });
    await a.onConfigChanged();
    const queued = a.scanners.runNow(p.id); // re-backtest with the new inputs
    return { ok: true, overrides: values, queued };
  });
  add('GET', '/api/scanners/:id/rule', p => {
    const s = a.registry.get(p.id); if (!s) throw new Error('unknown scanner');
    const rule = a.config.get().scanners[p.id]?.rule ?? null;
    const symbol = a.scanners.symbolsFor(p.id)[0], tf = a.scanners.timeframesFor(p.id)[0];
    const ov = a.scanners.getOverlay(p.id, symbol, tf);
    const bars = a.candles.get(symbol, tf, { closedOnly: true });
    const trail = ov ? selectTrail(ov.plots, bars) : null, osc = ov ? selectOscillator(ov.plots, bars) : null;
    return { id: s.id, rule, available: GENERIC_RULES, candidates: { trailing: trail ? { title: trail.title, flips: trail.flips, merged: trail.merged } : null, oscillator: osc ? { title: osc.title, mode: osc.mode, ob: osc.ob, os: osc.os, crosses: osc.crosses } : null }, sampled: ov ? { symbol, tf, plots: ov.plots.map(pl => ({ title: pl.title, style: pl.style, overlay: pl.overlay })) } : null };
  });
  add('PUT', '/api/scanners/:id/rule', async (p, _u, body) => {
    const s = a.registry.get(p.id); if (!s) throw new Error('unknown scanner');
    const rule = body?.rule ?? null;
    if (rule !== null && !GENERIC_RULES.includes(rule as GenericRule)) throw new Error(`rule must be ${GENERIC_RULES.join('|')} or null`);
    a.config.setScanner(p.id, { rule: rule as GenericRule | null });
    await a.onConfigChanged();
    return { id: s.id, rule, queued: a.scanners.runNow(p.id) };
  });
};
