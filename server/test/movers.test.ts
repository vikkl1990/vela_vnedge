import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoverStore } from '../src/markets/movers.ts';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const tick = (s: MoverStore, minute: number, prices: Record<string, number>) =>
  s.record(T0 + minute * MIN, Object.entries(prices).map(([symbol, price]) => ({ symbol, price })));

test('a pump shows in the 5 and 15 minute windows and is ranked first', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 20; m++) tick(s, m, { AAAUSD: 100, BBBUSD: 50 + (m >= 16 ? (m - 15) * 2 : 0) });
  const rows = s.movers(T0 + 20 * MIN);
  assert.equal(rows[0].symbol, 'BBBUSD');
  assert.ok(Math.abs((rows[0].ch5 ?? 0) - 20) < 1e-9, '5 min: 50 at minute 15 to 60 at minute 20');
  assert.ok(Math.abs((rows[0].ch15 ?? 0) - 20) < 1e-9);
  assert.equal(rows[0].ch60, null, 'only 20 minutes of history: no 60 minute figure');
  assert.equal(rows.find((r) => r.symbol === 'AAAUSD')?.ch5, 0);
});

test('a dump is negative, and ranking is by size not sign', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 10; m++) tick(s, m, { DNUSD: m < 6 ? 10 : 8, UPUSD: m < 6 ? 10 : 10.5 });
  const rows = s.movers(T0 + 10 * MIN);
  assert.equal(rows[0].symbol, 'DNUSD');
  assert.ok((rows[0].ch5 ?? 0) < -19);
});

test('a window is reported only when the ring reaches back far enough', () => {
  const s = new MoverStore();
  tick(s, 0, { XUSD: 1 });
  tick(s, 3, { XUSD: 1.1 });
  assert.deepEqual(s.movers(T0 + 3 * MIN), [], 'three minutes of history answers no window');
  assert.equal(s.historyMinutes(T0 + 3 * MIN), 3);
});

test('a market that stopped updating shows no change at all', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 10; m++) tick(s, m, { OLDUSD: 1 + m * 0.01 });
  assert.equal(s.movers(T0 + 10 * MIN).length, 1);
  assert.equal(s.movers(T0 + 20 * MIN).length, 0, 'ten minutes of silence: stale, not a live mover');
});

test('bad prices are skipped and close samples replace each other', () => {
  const s = new MoverStore();
  s.record(T0, [{ symbol: 'ZUSD', price: 0 }, { symbol: 'ZUSD', price: Number.NaN }, { symbol: 'ZUSD', price: -3 }]);
  assert.equal(s.movers(T0 + 10 * MIN).length, 0);
  s.record(T0, [{ symbol: 'ZUSD', price: 1 }]);
  s.record(T0 + 5_000, [{ symbol: 'ZUSD', price: 2 }]); // inside the gap: replaces, not appended
  s.record(T0 + 6 * MIN, [{ symbol: 'ZUSD', price: 3 }]);
  const row = s.movers(T0 + 6 * MIN)[0];
  assert.ok(Math.abs((row.ch5 ?? 0) - 50) < 1e-9, 'base was the replaced sample, 2');
});

test('the ring forgets what is older than the longest window', () => {
  const s = new MoverStore();
  for (let m = 0; m <= 200; m++) tick(s, m, { LUSD: 1 + m * 0.001 });
  const rows = s.movers(T0 + 200 * MIN);
  assert.ok(rows[0].ch60 !== null);
  assert.ok(s.historyMinutes(T0 + 200 * MIN) <= 66);
});

test('late samples cannot turn a fresh gain into a stale loss', () => {
 const s=new MoverStore();tick(s,0,{BTCUSD:100});tick(s,5,{BTCUSD:110});tick(s,4.9,{BTCUSD:80});
 assert.equal(s.movers(T0+5*MIN)[0].price,110);
 assert.ok(Math.abs(s.movers(T0+5*MIN)[0].ch5!-10)<1e-9);
 s.record(NaN,[{symbol:'BTCUSD',price:1}]);assert.equal(s.movers(T0+5*MIN)[0].price,110);
});
test('coalescing never backdates prices or loses history under frequent samples', () => {
 const s=new MoverStore();for(let sec=0;sec<=360;sec++)s.record(T0+sec*1000,[{symbol:'BTCUSD',price:100+sec}]);
 const row=s.movers(T0+360000)[0];assert.ok(row.ch5!==null);assert.ok(s.historyMinutes(T0+360000)>=5);
 assert.equal(s.movers(T0+359000).length,0,'a future sample is not current data after a clock correction');
});
test('an older refresh completing last cannot overwrite newer market data', async t => {
 const {App}=await import('../src/app.ts');let at=T0; t.mock.method(Date,'now',()=>at);
 const replies:Array<(v:any)=>void>=[];
 const app:any={rest:{tickers:()=>new Promise(r=>replies.push(r)),products:async()=>[]},marketCache:null,movers:new MoverStore()};
 const older=App.prototype.markets.call(app);at+=1000;const newer=App.prototype.markets.call(app);
 replies[1]([{symbol:'BTCUSD',mark_price:'110'}]);await newer;
 replies[0]([{symbol:'BTCUSD',mark_price:'80'}]);const result=await older;
 assert.equal(result[0].markPrice,110);assert.equal(app.marketCache.at,T0+1000);
});
test('API supplies every window candidate instead of truncating by the largest other-window move', async () => {
 const {App}=await import('../src/app.ts');let supplied=0;
 const app:any={markets:async()=>[],movers:{historyMinutes:()=>60,movers:(_now:number,limit:number)=>{supplied=limit;return [];}}};
 await App.prototype.moversNow.call(app);assert.equal(supplied,Infinity);
});
