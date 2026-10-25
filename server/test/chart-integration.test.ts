import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandleStream } from '../../dashboard/src/chart/candleStream.ts';
import { decisionMarks } from '../../dashboard/src/chart/decisionMarks.ts';
import { scriptInputs } from '../../dashboard/src/chart/scriptInputs.ts';
import { Db } from '../src/db.ts';

const t = Date.UTC(2026, 9, 25, 14, 45);
const bar = { time: t, open: 100, high: 101, low: 99, close: 100, volume: 10 };
test('ticks cannot alter a completed candle or cross a timeframe boundary', () => {
  const out: any[] = []; const s = new CandleStream(900_000, b => out.push(b));
  s.candle(bar, false); s.tick(102, t + 1000); assert.equal(out.at(-1).high, 102);
  const n = out.length; s.tick(120, t + 900_001); assert.equal(out.length, n);
  s.candle({ ...bar, time: t + 900_000 }, false); s.tick(120, t + 900_002);
  assert.equal(out.at(-1).time, t + 900_000); assert.equal(out.at(-1).high, 120);
  s.candle({ ...bar, time: t + 900_000 }, true); const closed = out.length;
  s.tick(130, t + 900_003); s.candle({ ...bar, time: t + 900_000 }, false);
  assert.equal(out.length, closed);
});
test('older ticks/candles and invalid prices cannot corrupt the current bar', () => {
  const out: any[] = []; const s = new CandleStream(900_000, b => out.push(b));
  s.tick(200, t); assert.equal(out.length, 0, 'no synthetic candle without authoritative OHLCV');
  s.candle(bar, false); s.tick(102, t + 2000); const n = out.length;
  s.tick(80, t + 1000); s.tick(-1, t + 3000); s.tick(90, NaN);
  s.candle({ ...bar, time: t - 900_000 }, false); s.candle({ ...bar, low: -1 }, false);
  assert.equal(out.length, n); assert.equal(out.at(-1).close, 102);
});
test('signal filtering applies timeframe and position before LIMIT, preserving old entry lookup', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const put = (tf: string, at: number, id: number) => db.insertSignal({at, barTime: at, scannerId:'s', scannerName:'S', symbol:'XUSD', tf, kind:'entry',side:'long',price:100,sl:98,tp:[],score:null,label:'L',message:'',summary:'',source:'alert',levelsSource:'script',action:'opened',positionId:id});
  put('1h',1,7); put('15m',2,8); put('15m',3,9);
  assert.deepEqual(db.signals({tf:'1h',limit:1}).map(s=>s.positionId),[7]);
  assert.deepEqual(db.signals({positionId:7,kind:'entry',limit:1}).map(s=>s.at),[1]);
  assert.equal(db.signals({tf:'1h',since:2}).length,0);
});
test('decision marks retain actual journal action and use escaped text content', () => {
  const marks = decisionMarks([{id:7,kind:'entry',at:t+900100,barTime:t,scannerName:'S',symbol:'XUSD',tf:'15m',side:'long',action:'rejected:cost',message:'<script>bad</script>',tp:[]} as any]);
  assert.equal(marks[0].time,t+900100); assert.equal(marks[0].glyph.letter,'×');
  const c = marks[0].content as {text:string}; assert.match(c.text,/rejected:cost/); assert.match(c.text,/<script>/); assert.equal('html' in c,false);
});

test('bot input titles resolve to Vela keys, explicit keys win, and removed overrides restore defaults', () => {
  const schema = [{key:'len',title:'Length',defval:3},{key:'on',title:'Enabled',defval:true}];
  assert.deepEqual(scriptInputs(schema,{Length:6,Enabled:false}),{len:6,on:false});
  assert.deepEqual(scriptInputs(schema,{len:8,Length:6}),{len:8,on:true});
  assert.deepEqual(scriptInputs(schema,{}),{len:3,on:true});
});
