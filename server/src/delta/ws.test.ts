import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaFeed, normalizePublicMessage, DELTA_INDIA_WS, DELTA_INDIA_PUBLIC_TESTNET_WS, parseQuote } from './ws.ts';
const T = 1792950480000;
function read(m: any, event: string) {
  const f = new DeltaFeed(); const out: any[] = [];
  f.on(event, x => out.push(x));
  for (const x of normalizePublicMessage(m)) (f as any).handle(x);
  return out;
}
test('compact candles preserve exchange candle start independently of publish time', () => {
  const [c] = read({ type: 'candlestick_1m', sy: 'BTCUSD', res: '1m', cst: T*1000, ts: (T+30000)*1000, o: 100, h: 102, l: 99, c: 101, v: 3 }, 'candle');
  assert.equal(c.candleStartMs, T); assert.equal(c.updatedMs, T+30000); assert.equal(c.close, 101);
  assert.deepEqual(read({ type: 'candlestick_1m', sy: 'BTCUSD', ts: T*1000, c: 101 }, 'candle'), []);
});
test('compact ticker batches preserve quote sides and product identities', () => {
  const out = read({ type: 'ticker', ts: T*1000, d: [{s:'BTCUSD',m:'101',ohlc:[1,2,3,100],q:['102',5,'99',6]}, {s:'ETHUSD',m:'11',ohlc:[1,2,3,10],q:['12',5,'9',6]}] }, 'ticker');
  assert.equal(out.length, 2); assert.equal(out[0].bestAsk,102); assert.equal(out[0].bestBid,99); assert.equal(out[1].symbol,'ETHUSD');
});
test('compact prints use trade time rather than publish time and marks strip MARK prefix', () => {
  const [t] = read({type:'trades',sy:'BTCUSD',p:'100',s:2,r:'m',t:T*1000,ts:(T+1000)*1000}, 'trade');
  assert.equal(t.timeMs,T); assert.equal(t.aggressor,'sell');
  assert.equal(read({type:'mark_price',sy:'MARK:BTCUSD',p:'101',ts:T*1000}, 'mark')[0].symbol,'BTCUSD');
});
test('compact and legacy funding preserve percent units, interval and settlement', () => {
  const compact=read({type:'funding_rate',sy:'BTCUSD',fr:.01,fi:28800,nfr:T*1000,ts:T*1000},'funding')[0];
  const legacy=read({type:'funding_rate',symbol:'BTCUSD',funding_rate:.01,funding_interval:28800,next_funding_realization:T*1000,timestamp:T*1000},'funding')[0];
  assert.deepEqual(compact,legacy); assert.equal(compact.ratePct,.01);
});
test('public subscriptions map logical channels and retain global status channels on reconnect', () => {
  const f=new DeltaFeed(); assert.ok(DELTA_INDIA_WS.includes('public-socket'));
  assert.deepEqual((f as any).wireChannel('v2/ticker',['BTCUSD']),{name:'ticker',symbols:['BTCUSD']});
  assert.deepEqual((f as any).wireChannel('all_trades',['BTCUSD']),{name:'trades',symbols:['BTCUSD']});
  assert.deepEqual((f as any).wireChannel('mark_price',['BTCUSD']),{name:'mark_price',symbols:['MARK:BTCUSD']});
  assert.deepEqual((f as any).wireChannel('system_status',[]),{name:'system_status'});
  assert.ok((f as any).subs.has('system_status'));
});

const quote = (at=T) => ({type:'ob_l1',sy:'BTCUSD',bp:'100',ap:'100.5',bs:'12',as:'30',lts:(at-1000)*1000,ts:at*1000});
test('L1 preserves contract sizes, publication and last-book-change clocks separately',()=>{
  assert.deepEqual(parseQuote(quote(),T+50),{symbol:'BTCUSD',bestBid:100,bestAsk:100.5,bidSize:12,askSize:30,timeMs:T,bookTimeMs:T-1000,receivedAt:T+50});
  assert.equal(parseQuote({...quote(),lts:(T-3600000)*1000},T)?.timeMs,T,'unchanged book can still be freshly published');
});
test('malformed, crossed, empty and future-dated L1 never become executable quotes',()=>{
  for(const patch of [{sy:null},{bp:'NaN'},{ap:99},{bs:0},{as:-1},{ts:null},{lts:null},{ts:(T+2001)*1000},{lts:(T+3000)*1000}]) assert.equal(parseQuote({...quote(),...patch},T),null,JSON.stringify(patch));
});
test('demo public endpoint uses compact channel names',()=>{
  const f=new DeltaFeed(DELTA_INDIA_PUBLIC_TESTNET_WS);
  assert.equal((f as any).wireChannel('v2/ticker',['BTCUSD']).name,'ticker');
  assert.equal((f as any).wireChannel('all_trades',['BTCUSD']).name,'trades');
});

class SocketFixture {
  static instances: SocketFixture[]=[];
  sent:any[]=[]; onopen?:()=>void; onmessage?:(e:any)=>void; onclose?:()=>void; onerror?:()=>void;
  constructor(_url:string){SocketFixture.instances.push(this);}
  send(s:string){this.sent.push(JSON.parse(s));}
  close(){this.onclose?.();}
  receive(m:any){this.onmessage?.({data:JSON.stringify(m)});}
}
function socketFixture(t:any){
  SocketFixture.instances=[];
  const original=globalThis.WebSocket;
  globalThis.WebSocket=SocketFixture as any;
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:T});
  const feed=new DeltaFeed();
  t.after(()=>{feed.stop();globalThis.WebSocket=original;t.mock.timers.reset();});
  return feed;
}
test('socket reconnect replays L1, ignores old socket data and stop cancels scheduled reconnect',t=>{
  const f=socketFixture(t);let quotes=0;f.on('quote',()=>quotes++);
  f.subscribe('ob_l1',['BTCUSD']);f.start();f.start();
  assert.equal(SocketFixture.instances.length,1);
  const first=SocketFixture.instances[0];first.onopen!();first.receive(quote());assert.equal(quotes,1);
  first.close();first.close();t.mock.timers.tick(1000);
  assert.equal(SocketFixture.instances.length,2);
  const next=SocketFixture.instances[1];next.onopen!();
  assert.ok(next.sent.some(m=>m.payload?.channels?.some((c:any)=>c.name==='ob_l1'&&c.symbols.includes('BTCUSD'))));
  first.receive(quote(T+1000));assert.equal(quotes,1);
  next.receive(quote(T+1000));assert.equal(quotes,2);
  next.close();f.stop();t.mock.timers.tick(60000);assert.equal(SocketFixture.instances.length,2);
});
test('healthy heartbeat cannot mask a silent L1 channel; repair is per stale symbol',t=>{
  const f=socketFixture(t);const gaps:any[]=[];f.on('quoteGap',e=>gaps.push(e));
  f.subscribe('ob_l1',['BTCUSD','ETHUSD']);f.start();const ws=SocketFixture.instances[0];ws.onopen!();
  t.mock.timers.tick(19000);ws.receive({type:'heartbeat'});ws.receive({...quote(T+19000),sy:'ETHUSD'});
  t.mock.timers.tick(1000);
  assert.deepEqual(gaps[0].symbols,['BTCUSD']);
  assert.equal(SocketFixture.instances.length,1);
  const repairs=ws.sent.filter(m=>m.type==='unsubscribe');assert.deepEqual(repairs[0].payload.channels[0].symbols,['BTCUSD']);
});
