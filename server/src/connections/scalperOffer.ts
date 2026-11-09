import {createHash} from 'node:crypto';
import type {PaperConfig} from '../config.ts';
import {DELTA_INDIA_PROD, type DeltaRest} from '../delta/rest.ts';

export interface ScalperEligibility {
  active: boolean | null; checkedAt: number; accountHash: string; connectionRevision: string;
}

/** Only this account's explicit boolean is evidence; authentication alone is not enrollment. */
export async function readScalperEligibility(rest:DeltaRest, connectionRevision:string):Promise<ScalperEligibility> {
  if(rest.baseUrl!==DELTA_INDIA_PROD)throw Error('Offer eligibility requires Delta India production');
  const p=await rest.request<Record<string,unknown>>('GET','/v2/users/trading_preferences',{auth:true,retries:0});
  if(!p || !/^[1-9]\d{0,39}$/.test(String(p.user_id)) || (typeof p.user_id==='number'&&!Number.isSafeInteger(p.user_id)))throw Error('Missing account identity');
  return {active:typeof p.futures_scalper_offer_enabled==='boolean'?p.futures_scalper_offer_enabled:null,
    checkedAt:Date.now(),connectionRevision,
    accountHash:createHash('sha256').update(`${DELTA_INDIA_PROD}:${p.user_id}`).digest('hex')};
}

/** Use after a successful read. Does not join an offer or claim knowledge of its original start date. */
export function activateScalperOffer(paper:PaperConfig, observed:ScalperEligibility):PaperConfig {
  if(observed.active!==true || !/^[a-f0-9]{64}$/.test(observed.accountHash) || !observed.connectionRevision ||
    !Number.isSafeInteger(observed.checkedAt) || observed.checkedAt<=0)throw Error('Scalper eligibility not verified');
  const prior=paper.scalperOffer?.verification;
  const same=prior?.source==='delta-india-trading-preferences' && prior.accountHash===observed.accountHash &&
    prior.connectionRevision===observed.connectionRevision && prior.verifiedAt>0 && prior.effectiveFrom>=prior.verifiedAt && prior.effectiveFrom<=observed.checkedAt;
  const verification=same?prior:{source:'delta-india-trading-preferences' as const,accountHash:observed.accountHash,
    connectionRevision:observed.connectionRevision,verifiedAt:observed.checkedAt,effectiveFrom:observed.checkedAt};
  return {...paper,scalperOffer:{...paper.scalperOffer,enabled:true,majors:['BTCUSD','ETHUSD'],majorsMinutes:30,
    othersMinutes:15,excluded:['PAXGUSD','SLVONUSD','XAUTUSD'],verification}};
}

/** New orders must not inherit eligibility from removed/replaced account credentials. Held policies stay frozen. */
export function bindScalperConnection(paper:PaperConfig, currentRevision:string|null):PaperConfig {
  const o=paper.scalperOffer;
  return o?.verification && o.verification.connectionRevision!==currentRevision ? {...paper,scalperOffer:{...o,enabled:false}} : paper;
}
