import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlert, extractEvents, shapeSide, describeEvent, directionalTitle } from './extractor.ts';

const A = (message: string, time = 1_000) => ({ barIndex: 10, time, type: 'alert' as const, message });

test('parses a full LONG entry with SL and TP1-3', () => {
  const ev = parseAlert(A('🟢 LONG | DELTA:BTCUSD | TF: 15 | Price: 78777.5 | SL: 78402 | TP1: 79152.2 | TP2: 79527 | TP3: 79901 | R:R: 1 | Score: 77'));
  assert.equal(ev?.kind, 'entry'); assert.equal(ev?.side, 'long');
  assert.equal(ev?.price, 78777.5); assert.equal(ev?.sl, 78402);
  assert.deepEqual(ev?.tp, [79152.2, 79527, 79901]); assert.equal(ev?.score, 77);
});

test('parses SELL variants and graded labels', () => {
  const ev = parseAlert(A('🔴 SELL [Medium] | DELTA:BTCUSD | 15 | Entry: 79727.5 | SL: 80100 | TP1: 79683.5 | TP2: 79500 | TP3: 79200'));
  assert.equal(ev?.kind, 'entry'); assert.equal(ev?.side, 'short'); assert.equal(ev?.price, 79727.5); assert.equal(ev?.sl, 80100);
  const ev2 = parseAlert(A('🔴 BEAR BREAKOUT | DELTA:BTCUSD | TF: 15 | Price: 76801.0 | SL: 77200 | TP1: 76500 | TP2: 76200 | TP3: 75900'));
  assert.equal(ev2?.kind, 'entry'); assert.equal(ev2?.side, 'short');
  const ev3 = parseAlert(A('🟢 SWEEP BUY | DELTA:BTCUSD | ID: 2 | TF: 15 | Price: 77980.5 | Pool: 1/3 | SL: 77670 | TP1: 78200 | TP2: 78400 | TP3: 78600 | R:R: 2'));
  assert.equal(ev3?.side, 'long'); assert.equal(ev3?.tp.length, 3);
  const ev4 = parseAlert(A('🟢 LONG | DELTA:BTCUSD | 15 | $78373.5 | ML:48.5 | SL:77459.0'));
  assert.equal(ev4?.kind, 'entry'); assert.equal(ev4?.price, 78373.5); assert.equal(ev4?.sl, 77459);
  const ev5 = parseAlert(A('🔴 SHORT ABCD | DELTA:BTCUSD | TF: 15 | Entry: 77233.0 | TP: 76800 | SL: 77500 | Score: 80'));
  assert.equal(ev5?.side, 'short'); assert.deepEqual(ev5?.tp, [76800]);
});

test('classifies exits', () => {
  assert.equal(parseAlert(A('🛑 SL HIT | DELTA:BTCUSD | Long | Entry: 78777.5 | SL: 78402'))?.exitType, 'sl');
  assert.equal(parseAlert(A('🎯🎯 TP2 HIT | DELTA:BTCUSD | TP2: 78171.7'))?.exitType, 'tp2');
  assert.equal(parseAlert(A('🏆 TP3_HIT | DELTA:BTCUSD | 78906.5'))?.exitType, 'tp3');
  assert.equal(parseAlert(A('🛡️ BE STOP-OUT | DELTA:BTCUSD | Long | Entry: 78777.5 | SL: 78777.5'))?.exitType, 'be');
  assert.equal(parseAlert(A('⚖️ BE_EXIT | DELTA:BTCUSD | 79698.0'))?.exitType, 'be');
  const rev = parseAlert(A('🔄 REVERSAL → LONG | DELTA:BTCUSD | TF: 15 | Closed before TP1 (loss)'));
  assert.equal(rev?.kind, 'exit'); assert.equal(rev?.exitType, 'flip'); assert.equal(rev?.side, 'short');
  const be = parseAlert(A('🛡️ BREAK-EVEN | DELTA:BTCUSD | SL moved to entry: 78777.5'));
  assert.equal(be?.kind, 'info');
  const slc = parseAlert(A('❌ SL HIT — TRADE CLOSED | DELTA:BTCUSD | TF: 15 | Level: 79300 | P&L: -1.2'));
  assert.equal(slc?.kind, 'exit'); assert.equal(slc?.exitType, 'sl');
});

test('info-only alerts are not entries', () => {
  for (const m of ['🟡 PATTERN DETECTED | DELTA:BTCUSD | TF: 15 | Price: 77294.0', '🟡 ENTRY ZONE | DELTA:BTCUSD | TF: 15 | Price: 78196.0', '🟢 NFE Volume Inflow | DELTA:BTCUSD | TF: 15 | Price: 77803', '🟢 FVG Retest | DELTA:BTCUSD | 78675.5', '🟢 BOS | DELTA:BTCUSD | 78675.5', '⬆ VA BREAKOUT UP | DELTA:BTCUSD | TF: 15 | Closed above VAH 78000 @ 78100']) {
    assert.equal(parseAlert(A(m))?.kind, 'info', m);
  }
  assert.equal(parseAlert(A('🟢 OTE Entry | DELTA:BTCUSD | 78675.5'))?.kind, 'entry');
});

test('parses SATS machine format', () => {
  const e1 = parseAlert(A('SATS DELTA:BTCUSD 15 | flip_exit LONG @ 78000 (FLIP) | trade_closed LONG @ 78000 (FLIP) | sell SHORT @ 78000 (Price band break)'));
  assert.equal(e1?.kind, 'entry'); assert.equal(e1?.side, 'short'); assert.equal(e1?.price, 78000);
  const e2 = parseAlert(A('SATS DELTA:BTCUSD 15 | tp1_hit LONG @ 79000 (Partial limit fill)'));
  assert.equal(e2?.kind, 'exit'); assert.equal(e2?.exitType, 'tp1'); assert.equal(e2?.side, 'long');
  const e3 = parseAlert(A('SATS DELTA:BTCUSD 15 | sl_hit SHORT @ 79000 (Stop) | trade_closed SHORT @ 79000 (SL)'));
  assert.equal(e3?.exitType, 'sl');
});

test('shape fallback and dedupe against alerts', () => {
  assert.equal(shapeSide('Buy Signal'), 'long'); assert.equal(shapeSide('Short'), 'short'); assert.equal(shapeSide('Bull Cross'), 'long'); assert.equal(shapeSide('Trend Up'), 'long');
  const evs = extractEvents([A('🟢 BUY | DELTA:BTCUSD | TF: 15 | Price: 100 | Score: 50', 5000)], [{ title: 'Buy Signal', times: [5000, 6000] }, { title: 'Sell Signal', times: [7000] }]);
  assert.equal(evs.length, 3);
  assert.equal(evs[0].source, 'alert'); assert.equal(evs[1].source, 'shape'); assert.equal(evs[2].side, 'short');
  const since = extractEvents([], [{ title: 'Buy', times: [1, 2, 3] }], { sinceBarTime: 3 });
  assert.equal(since.length, 1);
});

test('parses STRAT JSON webhook alerts', () => {
  const e = parseAlert(A('{"ind":"STRAT","v":"1.9.0","sym":"BTCUSD","tf":"15","action":"trigger_bull","pattern":"2-1-2","price":80432.5,"entry":80474.5,"sl":80347,"tp1":80600,"tp2":80700,"tp3":80800,"regime":2}'));
  assert.equal(e?.kind, 'entry'); assert.equal(e?.side, 'long'); assert.equal(e?.price, 80474.5); assert.equal(e?.sl, 80347); assert.deepEqual(e?.tp, [80600, 80700, 80800]);
  const s = parseAlert(A('{"ind":"STRAT","action":"setup_bull","pattern":"3-1-2","price":80432.5,"trig":80474.5,"stop":80347}'));
  assert.equal(s?.kind, 'info');
  const bare = parseAlert(A('{"ind":"STRAT","action":"trigger_bear","pattern":"2-1-2","price":80432.5}'));
  assert.equal(bare?.kind, 'info');
  const x = parseAlert(A('{"ind":"STRAT","action":"sl_hit","entry":80474.5,"sl":80347,"dir":"long","be_stop":false}'));
  assert.equal(x?.kind, 'exit'); assert.equal(x?.exitType, 'sl'); assert.equal(x?.side, 'long');
  const t3 = parseAlert(A('{"ind":"STRAT","action":"tp3_close","entry":1,"level":2,"dir":"short","result":"win"}'));
  assert.equal(t3?.exitType, 'tp3'); assert.equal(t3?.price, 2);
});

test('describeEvent produces readable summaries', () => {
  const e = parseAlert(A('🟢 LONG | DELTA:BTCUSD | TF: 15 | Price: 78777.5 | SL: 78402 | TP1: 79152.2 | TP2: 79527 | TP3: 79901 | R:R: 1 | Score: 77'))!;
  assert.equal(describeEvent(e), 'LONG entry at 78,777.5 · stop 78,402 · targets 79,152.2 / 79,527 / 79,901 · score 77');
  const x = parseAlert(A('🎯🎯 TP2 HIT | DELTA:BTCUSD | TP2: 78171.7'))!;
  assert.equal(describeEvent(x), 'Take-profit 2 hit at 78,171.7');
  const j = parseAlert(A('{"ind":"STRAT","v":"1.9.0","sym":"ETHUSD","tf":"15","action":"setup_bull","pattern":"2-1-2 Rev","price":2574.7,"trig":2577.05,"stop":2571.35,"ftc":"30+1H-4H-D+W-M+"}'))!;
  assert.equal(describeEvent(j), 'STRAT: setup bull · pattern 2-1-2 Rev · price 2,574.7 · trigger 2,577.05 · stop 2,571.35 · HTF continuity 30+1H-4H-D+W-M+');
  const i = parseAlert(A('🟢 POC CROSS UP | DELTA:BTCUSD | TF: 15 | Price: 80432.5'))!;
  assert.equal(describeEvent(i), 'POC CROSS UP · price 80432.5');
  const sh = extractEvents([], [{ title: 'Bull Cross', times: [1] }])[0];
  assert.equal(describeEvent(sh), 'LONG entry · (Bull Cross marker drawn by the script; stop/targets from ATR)');
});

test('alertcondition titles and directional shapes become entries (LuxAlgo style)', () => {
  assert.equal(directionalTitle('Bullish Internal OB Breakout'), 'long');
  assert.equal(directionalTitle('Downward Breakout'), 'short');
  assert.equal(directionalTitle('Equal Highs'), undefined);
  assert.equal(directionalTitle('Bullish Divergence'), undefined);
  assert.equal(shapeSide('Upper Break'), 'long'); assert.equal(shapeSide('Lower Break'), 'short'); assert.equal(shapeSide('plot'), undefined);
  const ac = (title: string, time: number) => ({ barIndex: 1, time, type: 'alertcondition' as const, title, message: title });
  const evs = extractEvents([ac('Internal Bullish CHoCH', 10), ac('Equal Lows', 10), ac('Internal Bearish BOS', 20), A('🟢 LONG | DELTA:BTCUSD | TF: 15 | Price: 100 | SL: 90', 30), ac('Bullish OB', 30)], []);
  assert.deepEqual(evs.map(e => [e.source, e.side, e.barTime]), [['alertcondition', 'long', 10], ['alertcondition', 'short', 20], ['alert', 'long', 30]]);
  assert.match(describeEvent(evs[0]), /script condition/);
});
