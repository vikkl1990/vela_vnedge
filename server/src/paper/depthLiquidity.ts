import {createHash} from 'node:crypto';
/** Entry buys and short exits spend the same ask-side observation. Sorting is
 * canonical so REST and WS level ordering cannot replenish a consumed book. */
export function depthBookKey(book:{exchangeAt:number;bids:Array<{price:number;size:number}>;asks:Array<{price:number;size:number}>}){
 const sort=(levels:typeof book.bids)=>[...levels].sort((a,b)=>a.price-b.price);
 return createHash('sha256').update(JSON.stringify([book.exchangeAt,sort(book.bids),sort(book.asks)])).digest('hex');
}
