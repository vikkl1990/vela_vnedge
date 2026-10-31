import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkStore } from './marks.ts';
import { parseQuote } from '../delta/ws.ts';

test('the top of book comes from the ticker channel and survives a mark update', () => {
  const m = new MarkStore();
  // Delta India sends no quotes on `mark_price`; the quote must not be wiped by one
  m.onWsTicker({ symbol: 'BTCUSD', price: 100, markPrice: 100, timeMs: Date.now(), bestBid: 99.5, bestAsk: 100.5 });
  m.setMark('BTCUSD', 100.2, Date.now(), null, null);
  assert.equal(m.executable('BTCUSD', 'buy', 10_000), 100.5);
  assert.equal(m.executable('BTCUSD', 'sell', 10_000), 99.5);
  assert.equal(m.markState('BTCUSD')?.bestBid, 99.5);
  assert.ok((m.spreadBps('BTCUSD') ?? 0) > 0);
});

test('crossed, missing and stale quotes are not executable', () => {
  const m = new MarkStore();
  assert.equal(m.executable('BTCUSD', 'buy', 10_000), null, 'no quote at all');
  m.onWsTicker({ symbol: 'BTCUSD', price: 100, markPrice: 100, timeMs: 1, bestBid: 101, bestAsk: 100 });
  assert.equal(m.executable('BTCUSD', 'buy', 10_000), null, 'crossed book rejected');
  m.setQuotes('BTCUSD', 99, 100, 1_000);
  assert.equal(m.executable('BTCUSD', 'buy', 10_000, 1_500), 100);
  assert.equal(m.executable('BTCUSD', 'buy', 10_000, 20_000), null, 'stale quote rejected');
  assert.deepEqual(m.quotedSymbols(10_000, 1_500), ['BTCUSD']);
  assert.deepEqual(m.quotedSymbols(10_000, 20_000), []);
});

test('the snapshot exposes the top of book (omitting it once hid a working quote feed)', () => {
  const m = new MarkStore();
  m.onWsMark({ symbol: 'BTCUSD', markPrice: 100, timeMs: 1, bestBid: 99.5, bestAsk: 100.5 });
  const snap = m.snapshot().BTCUSD;
  assert.equal(snap.bestBid, 99.5);
  assert.equal(snap.bestAsk, 100.5);
  assert.ok((snap.spreadBps ?? 0) > 0);
  assert.equal(m.executable('BTCUSD', 'buy', 0), 100.5, 'mark_price alone is enough to price a fill');
});

test('a quote must be fresh by the exchange clock as well as on receipt', () => {
  const m = new MarkStore();
  const now = Date.now();
  m.onWsTicker({ symbol: 'BTCUSD', price: 100, markPrice: 100, timeMs: now - 3600_000, bestBid: 99, bestAsk: 101 } as any);
  assert.equal(m.executable('BTCUSD', 'buy', 2000), null, 'an hour-old quote is stale however recently it arrived');
  m.onWsTicker({ symbol: 'BTCUSD', price: 100, markPrice: 100, timeMs: now, bestBid: 99.5, bestAsk: 100.5 } as any);
  assert.equal(m.executable('BTCUSD', 'buy', 2000), 100.5);
  // a late-delivered older quote does not replace a newer one
  m.onWsTicker({ symbol: 'BTCUSD', price: 100, markPrice: 100, timeMs: now - 500, bestBid: 90, bestAsk: 110 } as any);
  assert.equal(m.executable('BTCUSD', 'buy', 2000), 100.5);
  // a quote seen only on the ticker channel is still reported, with its own timestamps
  const st = m.markState('BTCUSD')!;
  assert.equal(st.bestAsk, 100.5);
  assert.equal(st.quoteExchangeAt, now);
  assert.ok(typeof st.quoteAt === 'number');
});

test('L1 wins over ticker until stale, preserves sizes, and reveals fallback provenance',t=>{
  const m=new MarkStore(),now=1792950480000;t.mock.method(Date,'now',()=>now);
  const q=parseQuote({sy:'BTCUSD',bp:'100',ap:'101',bs:10,as:20,ts:now*1000,lts:(now-60000)*1000},now)!;
  m.onWsQuote(q);
  m.onWsTicker({symbol:'BTCUSD',price:100,markPrice:100,timeMs:now+100,bestBid:90,bestAsk:110});
  assert.equal(m.executable('BTCUSD','buy',2000,now+500),101);
  assert.equal(m.markState('BTCUSD')!.quoteSource,'ob_l1');assert.equal(m.markState('BTCUSD')!.askSize,20);
  assert.equal(m.quoteSummary(2000,now+500).l1,1);
  t.mock.method(Date,'now',()=>now+15000);
  m.onWsTicker({symbol:'BTCUSD',price:100,markPrice:100,timeMs:now+15000,bestBid:99,bestAsk:102});
  assert.equal(m.executable('BTCUSD','buy',2000,now+15000),102);
  assert.equal(m.quoteSummary(2000,now+15000).fallback,1);
});
test('future timestamps cannot poison ordering, and a quote gap invalidates only affected symbols',()=>{
  const m=new MarkStore(),now=1792950480000;
  m.setQuotes('BTCUSD',99,101,now,now);m.setQuotes('ETHUSD',9,11,now,now);
  m.setQuotes('BTCUSD',1,999,now,now+86400000);
  m.setQuotes('BTCUSD',100,102,now+1,now+1);
  assert.equal(m.executable('BTCUSD','buy',2000,now+1),102);
  m.invalidateQuotes(['BTCUSD']);assert.equal(m.executable('BTCUSD','buy',2000,now+1),null);
  assert.equal(m.executable('ETHUSD','buy',2000,now+1),11);
  m.invalidateQuotes();assert.equal(m.quoteSummary(2000,now+1).total,0);
});
