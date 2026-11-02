import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { aggregateFlow, OrderFlowStore, type FlowMinute } from './store.ts';
import { flowQuery } from './query.ts';
import { DeltaPineProvider } from '../pine/provider.ts';
import { PineTS } from 'pinets';
import { fundamentalsToNa } from '../pine/compat.ts';
import { normalizePublicMessage, parseTrade } from '../delta/ws.ts';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR } from '../config.ts';
import { applyPatches } from '../pine/patches.ts';
import { Indicator } from 'pinets';

const T = 1800000000000, M = 60000;
const print = (timeMs: number, aggressor: 'buy' | 'sell' | null, qty = 2) => ({ symbol: 'BTCUSD', price: 100, timeMs, aggressor, qty });
const minute = (openTime: number, buy = 2, covered = true): FlowMinute => ({ openTime, buy, sell: 1, unknown: 0, trades: 2, covered, levels: [{ price: 100, buyVolume: buy, sellVolume: 1 }] });

test('unknown compact roles and publication-only timestamps cannot fabricate signed flow', () => {
  const [raw] = normalizePublicMessage({type:'trades',sy:'BTCUSD',p:'100',s:2,r:'?',ts:T*1000});
  const trade = parseTrade(raw.symbol,raw)!;
  assert.equal(trade.aggressor,null); assert.equal(trade.timeKnown,false);
  const db = new Db(':memory:');
  try {
    const flow = new OrderFlowStore(db,['BTCUSD']); flow.connection(true,T);
    flow.onTrade(print(T+1,'buy'),T+1); flow.onTrade(trade,T+2); flow.flush(T+M+10000);
    assert.equal(flow.minutes('BTCUSD',T,T+M)[0].covered,false);
  } finally {db.db.close();}
});

test('real aggressors, supplied ID dedup and legitimate identical anonymous prints', () => {
  const db = new Db(':memory:'), flow = new OrderFlowStore(db, ['BTCUSD']);
  try {
    flow.connection(true, T);
    flow.onTrade({ ...print(T + 10, 'buy'), id: '1' }, T + 10);
    flow.onTrade({ ...print(T + 10, 'buy'), id: '1' }, T + 11);
    flow.onTrade(print(T + 20, 'sell'), T + 20); flow.onTrade(print(T + 20, 'sell'), T + 20);
    flow.flush(T + M + 10000);
    const [b] = flow.view('BTCUSD', M, T, T + M, T + M + 10000).bars;
    assert.equal(b.trades, 3); assert.equal(b.buy, 2); assert.equal(b.sell, 4); assert.equal(b.delta, -2);
    assert.equal(b.covered, true);
  } finally { db.db.close(); }
});

test('startup, reconnect, unknown side and late trade expose missing coverage', () => {
  const db = new Db(':memory:'), flow = new OrderFlowStore(db, ['BTCUSD']);
  try {
    flow.connection(true, T + 1000); flow.onTrade(print(T + 2000, 'buy'), T + 2000);
    flow.flush(T + M + 10000);
    assert.equal(flow.minutes('BTCUSD', T, T + M)[0].covered, false);
    flow.onTrade(print(T + M + 11000, null), T + M + 11000);
    flow.flush(T + 2 * M + 10000);
    assert.equal(flow.minutes('BTCUSD', T + M, T + 2 * M)[0].covered, false);
    flow.flush(T + 3 * M + 10000);
    assert.equal(flow.minutes('BTCUSD', T + 2 * M, T + 3 * M)[0].covered, true);
    flow.onTrade(print(T + 2 * M + 5, 'buy'), T + 3 * M + 20000);
    assert.equal(flow.minutes('BTCUSD', T + 2 * M, T + 3 * M)[0].covered, false);
    flow.connection(false, T + 3 * M + 21000); flow.connection(true, T + 4 * M + 1000);
    flow.flush(T + 5 * M + 10000);
    assert.equal(flow.minutes('BTCUSD', T + 4 * M, T + 5 * M)[0].covered, false);
  } finally { db.db.close(); }
});

test('HTF footprints require every minute; CVD restarts after gaps and never uses future minutes', () => {
  const rows = Array.from({ length: 10 }, (_, i) => minute(T + i * M));
  const bars = aggregateFlow(rows, 5 * M, T, T + 10 * M);
  assert.deepEqual(bars.map(b => b.delta), [5, 5]); assert.equal(bars[1].cvd, 10);
  rows[2].covered = false;
  const gap = aggregateFlow(rows, 5 * M, T, T + 10 * M);
  assert.equal(gap[0].delta, null); assert.equal(gap[1].cvd, 5); assert.equal(gap[1].cvdStart, T + 5 * M);
  assert.equal(aggregateFlow(rows, 5 * M, T, T + 9 * M).length, 1);
});

test('bounded queries reject invalid durations, symbols and NaN', () => {
  for (const tf of ['1m','5m','15m','1h','4h','1d']) assert.equal(flowQuery(new URLSearchParams(`tf=${tf}`), T).tf, tf);
  assert.throws(() => flowQuery(new URLSearchParams('tf=1M'), T));
  assert.throws(() => flowQuery(new URLSearchParams('symbol=binance:BTCUSDT'), T));
  assert.throws(() => flowQuery(new URLSearchParams('from=NaN'), T));
  const q = flowQuery(new URLSearchParams('tf=60&limit=999999&from=0'), T);
  assert.equal(q.duration, 3600000); assert.equal(q.limit, 500); assert.equal(q.from, T - 3 * 86400000);
});

test('Pine reads measured footprint delta and preserves missing bars; no cross-venue or future data', async () => {
  const footprints = [minute(T, 4), minute(T + M, 9, false), minute(T + 2 * M, 99)];
  const bars = [0, 1].map(i => ({ time: T + i * M, open: 100, high: 101, low: 99, close: 100, volume: 5 }));
  const p = new DeltaPineProvider({ symbol: 'BTCUSD', tf: '1m', tickSize: .5, bars, footprints });
  const src = '//@version=6\nindicator("Footprint test")\nfootprint fp = request.footprint(1)\nplot(na(fp) ? na : fp.delta(), "Delta")';
  assert.equal(fundamentalsToNa(src), src);
  const result = await new PineTS(p as any, 'BTCUSD', '1', 2).run(src);
  assert.equal(result.plots.Delta.data[0].value, 3);
  assert.ok(Number.isNaN(result.plots.Delta.data[1].value));
  assert.equal((await p.getFootprintData('BTCUSD', '1')).length, 1);
  assert.deepEqual(await p.getFootprintData('BINANCE:BTCUSDT', '1'), []);
  assert.deepEqual(await p.getFootprintData('BTCUSD', '5'), []);
});

test('upgraded runtime named argument calculations match positional calls', async () => {
  const bars = Array.from({length: 10}, (_, i) => ({openTime: T + i * M, closeTime: T + (i + 1) * M, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10}));
  const ctx = await new PineTS(bars as any).run('//@version=5\nindicator("Parity")\nplot(ta.sma(source=close, length=3), "named")\nplot(ta.sma(close, 3), "positional")');
  assert.deepEqual(ctx.plots.named.data.map((v:any) => v.value), ctx.plots.positional.data.map((v:any) => v.value));
  assert.equal(ctx.plots.named.data.at(-1)!.value, 109);
});

test('an unobserved symbol is unavailable; restart preserves records but cannot bridge its gap', () => {
  const db = new Db(':memory:');
  try {
    const flow = new OrderFlowStore(db, ['BTCUSD','ETHUSD']);
    flow.connection(true, T); flow.onTrade(print(T + 1, 'buy'), T + 1); flow.flush(T + M + 10000);
    assert.equal(flow.minutes('BTCUSD',T,T+M)[0].covered,true);
    assert.equal(flow.minutes('ETHUSD',T,T+M)[0].covered,false);
    const restarted = new OrderFlowStore(db, ['BTCUSD']);
    restarted.connection(true,T+2*M+1000); restarted.onTrade(print(T+2*M+2000,'sell'),T+2*M+2000);
    restarted.flush(T+3*M+10000);
    const rows = restarted.minutes('BTCUSD',T,T+3*M);
    assert.equal(rows.length,2); assert.equal(rows[0].covered,true); assert.equal(rows[1].covered,false);
    assert.equal(aggregateFlow(rows,3*M,T,T+3*M)[0].covered,false);
  } finally {db.db.close();}
});

test('CME Lens runs native footprints and retains its labelled proxy, while unavailable intrabar mode fails explicitly', async () => {
  const file = 'EYNNWCWE-CME-Institutional-Order-Flow-AMT-Lens.pine';
  const original = fs.readFileSync(path.join(SCRIPTS_DIR,'pine',file),'utf8');
  const patched = applyPatches(original,file);
  assert.ok(patched.applied.includes('cme-native-footprint-without-intrabar-library'));
  assert.ok(original.includes('import TradingView/ta/14 as tvta'), 'vendored original stays unchanged');
  const bars = Array.from({length:80},(_,i)=>({time:T+i*M,open:100,high:101,low:99,close:100,volume:5}));
  const run = async (native: boolean, intrabar = false) => {
    const provider = new DeltaPineProvider({symbol:'BTCUSD',tf:'1m',tickSize:.5,bars,footprints:bars.map(b=>minute(b.time,4))});
    const pine = new PineTS(provider as any,'BTCUSD','1',bars.length); pine.setMaxLoops(200000);
    const ind = new Indicator(patched.source+'\nplot(engBuy,"probeBuy")\nplot(engSell,"probeSell")');
    ind.input.replayOptimized = !native;
    if(intrabar) ind.input.engineInput = 'Intrabar (1m Low Memory)';
    return pine.run(ind);
  };
  const native = await run(true), proxy = await run(false);
  assert.equal(native.plots.probeBuy.data.at(-1)!.value,4);
  assert.equal(native.plots.probeSell.data.at(-1)!.value,1);
  assert.equal(proxy.plots.probeBuy.data.at(-1)!.value,2.5);
  await assert.rejects(run(true,true),/intrabar proxy is unavailable/);
});
