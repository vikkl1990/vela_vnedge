import type {WsTrade} from '../delta/ws.ts';

export interface FlowWindow { trades:number; buy:number; sell:number; imbalance:number|null; firstPrice:number|null; lastPrice:number|null }
export interface IntrabarFlowSnapshot {
 at:number; since:number; covered:boolean; reason:string|null; lastTradeAt:number|null;
 windows:{s5:FlowWindow;s15:FlowWindow;s60:FlowWindow};
}
interface Bucket {at:number;buy:number;sell:number;trades:number;firstAt:number;lastAt:number;firstPrice:number;lastPrice:number;keys:string[]}
interface Stream {since:number;invalidUntil:number;lastAt:number|null;buckets:Map<number,Bucket>;seen:Set<string>}
const empty=():FlowWindow=>({trades:0,buy:0,sell:0,imbalance:null,firstPrice:null,lastPrice:null});
/** Bounded, incremental public prints. No candle inference, SQL, Pine execution or trading access. */
export class IntrabarFlow {
 private streams=new Map<string,Stream>();private connected=false;private lastPulse=0;
 connection(connected:boolean,now=Date.now()) {if(connected!==this.connected){this.connected=connected;this.reset(now);} }
 private reset(now:number){for(const s of this.streams.values())Object.assign(s,{since:now,invalidUntil:now+60000,lastAt:null,buckets:new Map(),seen:new Set()});}
 observeSymbols(symbols:string[],now=Date.now()){
  for(const symbol of symbols)if(!this.streams.has(symbol))this.streams.set(symbol,{since:now,invalidUntil:now+60000,lastAt:null,buckets:new Map(),seen:new Set()});
 }
 /** A stalled event loop cannot turn a backlog of prints into current order flow. */
 pulse(now=Date.now()){if(this.lastPulse&&(now<this.lastPulse||now-this.lastPulse>3000))this.reset(now);this.lastPulse=now;}
 private prune(s:Stream,now:number){for(const [at,b] of s.buckets)if(at<now-61000){for(const id of b.keys)s.seen.delete(id);s.buckets.delete(at);}}
 onTrade(t:WsTrade,receivedAt=Date.now()){
  const s=this.streams.get(t.symbol);if(!s||!this.connected)return;
  this.prune(s,receivedAt);
  if(t.timeKnown===false||!Number.isFinite(t.timeMs)||t.timeMs>receivedAt||receivedAt-t.timeMs>2000||!(t.price>0&&Number.isFinite(t.price)&&t.qty>0&&Number.isFinite(t.qty))||!t.aggressor){s.invalidUntil=receivedAt+60000;return;}
  // Some Delta messages have no id. Identical prints in that case are conservatively
  // counted once; they can never inflate the minimum activity needed for this study.
  const id=t.id?`id:${t.id}`:`print:${t.timeMs}:${t.price}:${t.qty}:${t.aggressor}`;
  if(s.seen.has(id))return;
  if(s.seen.size>=20000){s.invalidUntil=receivedAt+60000;return;}
  const at=Math.floor(t.timeMs/1000)*1000;
  const b=s.buckets.get(at)??{at,buy:0,sell:0,trades:0,firstAt:t.timeMs,lastAt:t.timeMs,firstPrice:t.price,lastPrice:t.price,keys:[]};
  b[t.aggressor]+=t.qty;b.trades++;b.keys.push(id);s.seen.add(id);
  if(t.timeMs<b.firstAt){b.firstAt=t.timeMs;b.firstPrice=t.price;}
  if(t.timeMs>=b.lastAt){b.lastAt=t.timeMs;b.lastPrice=t.price;}
  s.lastAt=Math.max(s.lastAt??0,t.timeMs);s.buckets.set(at,b);
 }
 snapshot(symbol:string,now=Date.now()):IntrabarFlowSnapshot{
  const s=this.streams.get(symbol),windows={s5:empty(),s15:empty(),s60:empty()};
  const reason=!this.connected?'disconnected':!s?'not subscribed':now<s.since+60000?'warming 60 seconds':now<s.invalidUntil?'unknown, late or interrupted prints':null;
  if(s){this.prune(s,now);for(const [name,duration] of [['s5',5000],['s15',15000],['s60',60000]] as const){
   const w=windows[name];let first=Infinity,last=-Infinity;
   // Exclude the partial oldest second; never include prints from beyond the observation.
   for(const b of s.buckets.values())if(b.at>=now-duration&&b.lastAt<=now){
    w.buy+=b.buy;w.sell+=b.sell;w.trades+=b.trades;
    if(b.firstAt<first){first=b.firstAt;w.firstPrice=b.firstPrice;}
    if(b.lastAt>last){last=b.lastAt;w.lastPrice=b.lastPrice;}
   }
   w.imbalance=w.buy+w.sell>0?(w.buy-w.sell)/(w.buy+w.sell):null;
  }}
  return {at:now,since:s?.since??now,covered:reason===null,reason,lastTradeAt:s?.lastAt??null,windows};
 }
}
