import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CandleStore } from './candleStore.ts';

function store() {
  const feed: any = new EventEmitter(); feed.subscribe = () => {};
  const rest: any = { candles: async () => [] };
  const cs = new CandleStore(rest, feed, 100);
  return { cs, feed };
}

test('decision 74: a bar is announced closed by the clock, once, even when no later trade arrives', () => {
  const { cs } = store();
  const H = 3_600_000, open = Date.UTC(2026, 9, 3, 15);
  (cs as any).series.set('PIEVERSEUSD:1h', { symbol: 'PIEVERSEUSD', tf: '1h', bars: [{ time: open - H, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: open, open: 1, high: 1, low: 1, close: 1, volume: 1 }], loaded: true, loading: null, maxBars: 100, lastClosedEmitted: open - H, lastClosedAt: 0, loadedAt: 0, unfillable: new Set(), dormant: false, backfilling: null });
  const closed: any[] = [];
  cs.on('closed', e => closed.push(e));
  assert.equal(cs.announceDueCloses(open + H + 1000), 0, 'inside the grace: not yet');
  assert.equal(cs.announceDueCloses(open + H + 3000), 1, 'after the grace: announced');
  assert.equal(closed.length, 1); assert.equal(closed[0].bar.time, open); assert.equal(closed[0].historical, false);
  assert.equal(cs.announceDueCloses(open + H + 60_000), 0, 'never twice');
  // the websocket path arriving later finds the bar already announced
  (cs as any).merge((cs as any).series.get('PIEVERSEUSD:1h'), { time: open + H, open: 1, high: 1, low: 1, close: 1, volume: 1 }, 'ws');
  assert.equal(closed.length, 1);
});

function recoveryFixture(t: any) {
  const open = Date.UTC(2026, 10, 7, 8), now = open + 62_000;
  t.mock.method(Date, 'now', () => now);
  const { cs, feed } = store(); feed.connected = true;
  const bar = { time: open, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  const series = { symbol: 'BTCUSD', tf: '1m', bars: [bar], loaded: true, loading: null, maxBars: 100, lastClosedEmitted: open - 60_000, lastClosedAt: 0, loadedAt: 0, unfillable: new Set(), dormant: false, backfilling: null };
  (cs as any).series.set('BTCUSD:1m', series);
  const closed: any[] = []; cs.on('closed', e => closed.push(e));
  const disconnect = () => { feed.connected = false; feed.emit('status', { connected: false }); };
  const connect = () => { feed.connected = true; feed.emit('status', { connected: true }); };
  return { cs, feed, open, now, series, closed, disconnect, connect };
}

test('reconnect cannot close an interrupted candle before REST repairs it', async t => {
  const f = recoveryFixture(t); f.disconnect(); f.connect();
  let finish!: (rows: any[]) => void;
  (f.cs as any).rest.candles = () => new Promise(resolve => { finish = resolve; });
  const repairing = f.cs.resync('BTCUSD', '1m');
  assert.equal(f.cs.announceDueCloses(f.now), 0);
  f.feed.emit('candle', { symbol:'BTCUSD', resolution:'1m', candleStartMs:f.open+60_000, open:110, high:111, low:109, close:110, volume:2, updatedMs:f.now });
  assert.equal(f.closed.length, 0, 'first new websocket candle must also wait for repair');
  finish([{ time:f.open/1000, open:100, high:112, low:98, close:110, volume:20 }]);
  await repairing;
  assert.equal(f.closed.length, 1); assert.equal(f.closed[0].bar.close, 110);
  assert.equal(f.closed[0].historical, true, 'repaired OHLC must not fill new pending entries');
});

test('failed reconnect repair remains pending; another successful repair releases closes', async t => {
  const f = recoveryFixture(t); f.disconnect(); f.connect();
  (f.cs as any).rest.candles = async () => { throw Error('timeout'); };
  await assert.rejects(f.cs.resync('BTCUSD','1m'), /timeout/);
  assert.equal(f.cs.announceDueCloses(f.now), 0);
  (f.cs as any).rest.candles = async () => [{time:f.open/1000,open:100,high:110,low:98,close:109,volume:10}];
  await f.cs.resync('BTCUSD','1m'); assert.equal(f.closed[0].bar.close,109);
});

test('a REST request from an earlier connection cannot release a newer recovery', async t => {
  const f = recoveryFixture(t); f.disconnect(); f.connect();
  let finish!: (rows: any[]) => void;
  (f.cs as any).rest.candles = () => new Promise(resolve => { finish = resolve; });
  const old = f.cs.resync('BTCUSD','1m'); f.disconnect(); f.connect();
  finish([{time:f.open/1000,open:100,high:110,low:98,close:109,volume:10}]);
  await old;
  assert.equal(f.cs.announceDueCloses(f.now),0); assert.equal(f.closed.length,0);
});

test('REST resync does not overwrite a newer websocket candle received during the request', async t => {
  const f = recoveryFixture(t);
  let finish!: (rows: any[]) => void;
  (f.cs as any).rest.candles = () => new Promise(resolve => { finish = resolve; });
  const pending = f.cs.resync('BTCUSD','1m');
  f.feed.emit('candle',{symbol:'BTCUSD',resolution:'1m',candleStartMs:f.open+60_000,open:110,high:115,low:110,close:114,volume:30,updatedMs:f.now});
  finish([{time:(f.open+60_000)/1000,open:110,high:111,low:110,close:111,volume:3}]);
  await pending; assert.equal(f.cs.get('BTCUSD','1m').at(-1)?.close,114);
});

test('concurrent resyncs share one REST request', async t => {
  const f = recoveryFixture(t); let calls=0, finish!: (rows:any[])=>void;
  (f.cs as any).rest.candles = () => { calls++; return new Promise(resolve=>{finish=resolve;}); };
  const a=f.cs.resync('BTCUSD','1m'), b=f.cs.resync('BTCUSD','1m');
  assert.equal(calls,1); finish([]); await Promise.all([a,b]);
});

test('continuous tickers cannot retain an old healthy clock-drift sample forever', t => {
  const {cs}=store();let now=Date.UTC(2026,10,7,8);
  t.mock.method(Date,'now',()=>now);cs.noteExchangeTime(now-10,'ws');
  for(let i=0;i<6;i++){now+=10000;cs.noteExchangeTime(now-3000,'ws');}
  assert.equal(cs.integrity().driftMs,3000);assert.equal(cs.integrity().driftWarnings,1);
});

test('a periodic REST refresh while disconnected cannot clear the reconnect repair barrier',async t=>{
  const f=recoveryFixture(t);f.disconnect();
  (f.cs as any).rest.candles=async()=>[{time:f.open/1000,open:100,high:110,low:98,close:109,volume:10}];
  await f.cs.resync('BTCUSD','1m');f.connect();
  assert.equal(f.cs.announceDueCloses(f.now),0);assert.equal(f.closed.length,0);
  await f.cs.resync('BTCUSD','1m');assert.equal(f.closed.length,1);
});

test('scan readiness requires loaded history, connected feed and completed repair',async t=>{
 const f=recoveryFixture(t);assert.equal(f.cs.scanReadiness('ETHUSD','1m'),'candle history is loading');
 assert.equal(f.cs.scanReadiness('BTCUSD','1m'),null);f.disconnect();assert.equal(f.cs.scanReadiness('BTCUSD','1m'),'market feed disconnected');
 f.connect();assert.equal(f.cs.scanReadiness('BTCUSD','1m'),'candle repair in progress');
 (f.cs as any).rest.candles=async()=>[{time:f.open/1000,open:100,high:110,low:98,close:109,volume:10}];
 await f.cs.resync('BTCUSD','1m');assert.equal(f.cs.scanReadiness('BTCUSD','1m'),null);
});
