import type { App } from '../app.ts';
import { CandleCache } from '../data/candleCache.ts';
import { logger } from '../log.ts';
import { ConsensusFilter } from './consensus.ts';
import { ValidationService } from './service.ts';
import { ShadowLedger } from './shadow.ts';
const log=logger.scoped('validation');

export interface ValidationModule { cache: CandleCache; service: ValidationService; shadow: ShadowLedger; consensus: ConsensusFilter; stop(): void }

/** Runtime-owned validation. Constructed before HTTP, equally for headless execution. */
export function createValidation(app: App): ValidationModule {
  const cfg = () => app.config.get();
  const h = cfg().validation.history;
  const cache = new CandleCache(app.db, app.rest, { chunkBars: h.chunkBars, delayMs: h.delayMs });
  if (h.enabled) app.scanners.setHistorySource(cache);
  const service = new ValidationService({ db: app.db, cfgRef: cfg, registry: app.registry, pool: app.pool, cache, scanners: app.scanners });
  const shadow = new ShadowLedger({ cfgRef: cfg, candles: app.candles, signals: app.scanners, marketInfo: s => app.scanners.marketInfo(s), db: app.db, archiveOnly:true });
  const consensus = new ConsensusFilter(() => cfg().validation.consensus);
  app.scanners.setEntryFilter(c => consensus.shouldEnter(c));
  const unsubscribe=app.config.onChange(next => { app.scanners.setHistorySource(next.validation.history.enabled ? cache : null); service.reschedule(); });
  const m = { cache, service, shadow, consensus, stop:()=>{unsubscribe();service.stop();} };
  log.info(`validation module ready (history ${h.enabled ? `${h.days}d cache` : 'off'}, legacy ML ledger archived, consensus ${cfg().validation.consensus.enabled ? 'on' : 'off'}, oos auto-tune ${cfg().autoTune.oos.enabled ? 'on' : 'off'})`);
  return m;
}
