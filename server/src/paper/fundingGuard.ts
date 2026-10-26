import type { FundingState } from '../data/marks.ts';
import type { PaperConfig } from '../config.ts';
export function fundingAssessment(f: FundingState | undefined, cfg: PaperConfig, side: 'long'|'short', tf: string, notional: number, risk: number, now: number) {
 const g=cfg.fundingGuard;
 const limitR=tf==='15m'||tf==='1m'||tf==='3m'||tf==='5m'?g?.scalpMaxR??0.1:g?.swingMaxR??0.2;
 const fresh=!!f && Number.isFinite(f.ratePct) && f.at<=now+2000 && now-f.at<=(g?.maxAgeSec??120)*1000;
 const cost=fresh?Math.max(0,notional*f!.ratePct/100*(side==='long'?1:-1)):null;
 const costR=cost!==null&&risk>0?cost/risk:null;
 const near=!!f && f.nextAt>now && f.nextAt-now<=(g?.leadMinutes??5)*60000;
 const trigger=!!g?.enabled && cfg.fundingCharges && fresh && near && costR!==null && costR>=limitR;
 return {fresh,cost,costR,limitR,nextAt:f?.nextAt??null,ratePct:f?.ratePct??null,near,trigger,enabled:!!g?.enabled};
}
