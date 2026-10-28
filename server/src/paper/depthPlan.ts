/** Fit a market order to observed depth without increasing its initial risk-sized quantity. */
export function depthPlan<S extends {qty:number;riskAmount:number;leverage:number}>(initial:S,reference:number,side:'long'|'short',
 quote:(qty:number)=>{price?:number;reject?:string},sizeAt:(price:number)=>S):{price:number;size:S}|{reject:string}{
 let qty=initial.qty;
 for(let i=0;i<12&&qty>=1;i++){
  const q=quote(qty);if(q.reject)return {reject:q.reject};
  if(!(q.price&&Number.isFinite(q.price)&&q.price>0))return {reject:'depth has no executable price'};
  const price=side==='long'?Math.max(reference,q.price):Math.min(reference,q.price);
  const sized=sizeAt(price),next=Math.min(qty,sized.qty);
  if(next<1)return {reject:'depth-adjusted risk budget below one contract'};
  if(next===qty){const fraction=qty/sized.qty;return {price,size:{...sized,qty,riskAmount:sized.riskAmount*fraction,leverage:sized.leverage*fraction}};}
  qty=next;
 }
 return {reject:'depth sizing did not converge'};
}
