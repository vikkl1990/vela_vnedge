import type { Position } from '../api/types'
/** Explanation of the engine-resolved policy; never infer a policy from global defaults. */
export function protectionText(p: Position): string {
  const r=p.protection;
  if(!r) return 'Effective exit policy unavailable; current stop and targets are shown above.';
  const parts:string[]=[];
  if(r.floorAtR>0) parts.push(`Floor: locks ${r.floorKeepR.toFixed(2)}R after +${r.floorAtR.toFixed(2)}R`);
  else parts.push('Profit floor off');
  if(r.trailAfterR>0) {
    const method=r.trailAtrMult>0 ? `${r.trailAtrMult} × ATR distance when ATR is available` : r.trailGiveBackPct>0 ? `keeps ${r.keepPct.toFixed(1)}% of the favorable price excursion` : `${r.trailDistanceR}R behind the peak`;
    parts.push(`Trail: arms at +${r.trailAfterR.toFixed(2)}R, ${method}`);
    if(r.trailSteps.length) parts.push('Steps: '+r.trailSteps.map(([at,give])=>`+${at}R keeps ${100-give}%`).join('; '));
    if(r.trailStall && r.trailStall.minutes>0) parts.push(`After ${r.trailStall.minutes} minutes without a new peak, give-back is multiplied by ${r.trailStall.factor}`);
  } else parts.push('Trailing stop off');
  return parts.join(' · ')+'. Stop protection is before exit costs and gap risk.';
}
export function quantityText(qty:number, contractValue:number):string {
  return new Intl.NumberFormat('en-US',{maximumSignificantDigits:12}).format(qty*contractValue);
}
export function targetR(p:Position, price:number):number|null {
  const distance=p.slOriginal==null?0:Math.abs(p.entryPrice-p.slOriginal);
  return distance>0?(price-p.entryPrice)*(p.side==='long'?1:-1)/distance:null;
}
