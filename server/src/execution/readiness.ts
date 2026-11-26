import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { TradePolicy } from '../paper/tradePolicy.ts';
import { stablePolicy } from '../paper/tradePolicy.ts';

export interface AdmissionProof {
  identity: string;
  evaluatedAt: number;
  validUntil: number;
}
/** An evaluation is an entry permission only for the exact running policy/source set. It never arms production. */
export class ProductionReadiness {
  private approved: AdmissionProof | null = null;
  identity(cfg: AppConfig, sources: Record<string, string | null>) {
    return createHash('sha256')
      .update(
        stablePolicy({
          paper: cfg.paper,
          risk: cfg.risk,
          ml: cfg.ml,
          execution: cfg.execution,
          scanners: Object.fromEntries(Object.entries(cfg.scanners).filter(([, v]) => v.enabled)),
          sources,
        }),
      )
      .digest('hex');
  }
  invalidate() {
    this.approved = null;
  }
  observe(ok: boolean, cfg: AppConfig, sources: Record<string, string | null>, now = Date.now()) {
    this.approved = ok
      ? { identity: this.identity(cfg, sources), evaluatedAt: now, validUntil: now + 60_000 }
      : null;
  }
  check(
    cfg: AppConfig,
    sources: Record<string, string | null>,
    bound: TradePolicy | undefined,
    current: TradePolicy,
    now = Date.now(),
  ): AdmissionProof | string {
    const proof = this.approved;
    if (!proof || now < proof.evaluatedAt || now >= proof.validUntil)
      return 'production readiness has no fresh passing evaluation';
    if (proof.identity !== this.identity(cfg, sources))
      return 'production readiness policy or source set changed';
    if (!bound?.sourceHash || bound.adoptedAt != null || bound.strategyId !== current.strategyId)
      return 'production entry does not match the evaluated policy';
    return { ...proof };
  }
}
