import type { AppConfig } from '../config.ts';

/** Admission may share the execution universe only while every eventual order
 * is checked against fresh depth at its actual size. This does not certify a
 * scanner, supply missing history, reserve capital or change a risk limit. */
export function turnoverAlignment(cfg: AppConfig) {
  const m=cfg.risk.marketGate;
  if(cfg.execution.mode!=='paper'||cfg.execution.allowProduction)throw Error('Turnover alignment requires paper mode');
  if(!m?.enabled||!m.freshDepth||!(m.maxBookCostPct!>0)||m.exempt?.length)
    throw Error('Mandatory fresh depth for every market is required');
  if(!(m.minTurnoverUsd>0)||!Number.isFinite(m.minTurnoverUsd))throw Error('A finite positive execution discovery floor is required');
  if(!cfg.incubator.mirror)throw Error('Copy policy is missing');
  const next=structuredClone(cfg),floor=m.minTurnoverUsd;
  next.incubator.minTurnoverUsd=floor;
  next.incubator.mirror!.minTurnoverUsd=floor;
  next.incubator.gate.minTurnoverUsd=floor;
  return {config:next,floor,changes:[
    {path:'incubator.minTurnoverUsd',before:cfg.incubator.minTurnoverUsd,after:floor},
    {path:'incubator.mirror.minTurnoverUsd',before:cfg.incubator.mirror.minTurnoverUsd,after:floor},
    {path:'incubator.gate.minTurnoverUsd',before:cfg.incubator.gate.minTurnoverUsd,after:floor},
  ].filter(c=>c.before!==c.after)};
}
