import { deriveRules, trainLogReg, type LogRegModel, type Sample } from './model.ts';
import type { MlSnapshot, ScannerInsight } from './service.ts';
const MIN_SCANNER_SAMPLES = 40;
export function fitModels(all: Sample[], names: Record<string, string>, stored: number, resetAt: number) {
  const byScanner = new Map<string, Sample[]>();
  for (const s of all) {
    const l = byScanner.get(s.scannerId) ?? [];
    l.push(s);
    byScanner.set(s.scannerId, l);
  }
  let global: LogRegModel | null = null;
  const timeframeMap = new Map<string, LogRegModel>(),
    models = new Map<string, LogRegModel>();
  let snapshot: MlSnapshot;
  const timeframeModels: NonNullable<MlSnapshot['timeframeModels']> = [];
  global = trainLogReg(all);
  timeframeMap.clear();
  for (const tf of new Set(all.map((s) => s.tf))) {
    const model = trainLogReg(all.filter((s) => s.tf === tf));
    if (model) {
      timeframeMap.set(tf, model);
      timeframeModels.push({ scannerId: null, tf, model: model.metrics });
    }
  }
  const gRules = deriveRules(all, { minN: 50 });
  const scanners: ScannerInsight[] = [];
  models.clear();
  for (const [id, list] of byScanner) {
    const m = list.length >= MIN_SCANNER_SAMPLES ? trainLogReg(list) : null;
    if (m) models.set(id, m);
    for (const tf of new Set(list.map((s) => s.tf))) {
      const rows = list.filter((s) => s.tf === tf);
      const cell = rows.length >= MIN_SCANNER_SAMPLES ? trainLogReg(rows) : null;
      if (cell) {
        models.set(JSON.stringify([id, tf]), cell);
        timeframeModels.push({ scannerId: id, tf, model: cell.metrics });
      }
    }
    const { baseline, rules } = deriveRules(list);
    scanners.push({
      scannerId: id,
      scannerName: names[id] ?? id,
      samples: list.length,
      liveSamples: list.filter((s) => !s.bt).length,
      baseline,
      model: m?.metrics ?? null,
      calibration: m?.calibration ?? null,
      importance: m?.importance.slice(0, 8) ?? [],
      rules,
    });
  }
  scanners.sort((a, b) => b.samples - a.samples);
  snapshot = {
    timeframeModels,
    eligibility: { stored: stored, eligible: all.length, excluded: stored - all.length },
    trainedAt: Date.now(),
    samples: all.length,
    liveSamples: all.filter((s) => !s.bt).length,
    liveSinceReset: all.filter((s) => !s.bt && s.at >= resetAt).length,
    scannersWithModel: scanners.filter((s) => s.model !== null).length,
    global: global
      ? {
          model: global.metrics,
          calibration: global.calibration,
          importance: global.importance,
          rules: gRules.rules,
          baseline: gRules.baseline,
        }
      : null,
    scanners,
  };
  const bundle = {
    version: 3,
    timeframeModels: Object.fromEntries(timeframeMap),
    global: global,
    models: Object.fromEntries(models),
    snapshot: snapshot,
  };
  return { bundle, maxResolvedAt: all.reduce((v, s) => Math.max(v, s.resolvedAt!), 0) };
}
