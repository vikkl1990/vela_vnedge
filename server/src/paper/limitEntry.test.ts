import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';

const H = 3600_000;
function setup(tf = '4h', over: Partial<AppConfig['paper']> = {}) {
  const db = new Db(':memory:');
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0.05, makerFeeRatePct: 0.02, liquidation: false, latencyMs: 0, minRiskFeeRatio: 0, limitFill: 'through', limitEntry: { enabled: true, tfs: ['4h'], atr: 0.3, bars: 2, books: ['account', 'shadow'] } }, over);
  const engine = new PaperEngine(db, () => cfg);
  const at = Math.floor(Date.now() / 60_000) * 60_000 + 1000;   // anchored to now: a restored limit must not have lapsed
  const enter = (side: 'long' | 'short' = 'long') => engine.onEntry({ kind: 'entry', side, price: 100, tp: [], label: 'entry', message: '', source: 'alert', barTime: at - ({ '15m': H / 4, '1h': H, '4h': 4 * H } as Record<string, number>)[tf], barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf, market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both', atr: 2 } as any);
  return { db, cfg, engine, at, enter };
}

test('decision 185: a 4h entry rests as a maker limit 0.3 ATR back, fills when price trades through it, with the stop measured from the fill', () => {
  const { engine, at, enter } = setup();
  const d = enter('long');
  assert.equal(d.action, 'pending'); assert.match(d.reason ?? '', /resting limit at 99.4/);
  assert.equal(engine.openPositions().length, 0);
  engine.onBar('ETHUSD', { time: at + 60_000, high: 100.5, low: 99.4, close: 99.8 }, at + 2 * 60_000);
  assert.equal(engine.openPositions().length, 0, 'a touch is not a fill under limitFill: through');
  engine.onBar('ETHUSD', { time: at + 2 * 60_000, high: 99.9, low: 99.3, close: 99.5 }, at + 3 * 60_000);
  const [p] = engine.openPositions();
  assert.ok(p, 'filled once price traded through');
  assert.equal(p.entryPrice, 99.4, 'at the limit price, no slippage');
  assert.ok(p.fees < 99.4 * p.qty * 0.0005, `a maker fee, under the taker rate: ${p.fees}`);
  assert.ok(Math.abs((p.slOriginal ?? 0) - (99.4 - 1.5 * 2)) < 1e-6, `the ATR stop from the fill: ${p.slOriginal}`);
});

test('decision 185: a limit that price never comes back to lapses after its bars; a short mirrors it', () => {
  const { engine, at, enter, db } = setup();
  const d = enter('short');
  assert.match(d.reason ?? '', /resting limit at 100.6/);
  engine.onBar('ETHUSD', { time: at + 60_000, high: 100.5, low: 99, close: 99.2 }, at + 2 * 60_000);
  assert.equal(engine.openPositions().length, 0);
  engine.housekeeping(at + 8 * H + 1000);
  assert.equal(engine.pendingEntries().length, 0, 'lapsed after two 4h bars');
  assert.equal(db.all("SELECT * FROM positions WHERE status='pending'").length, 0);
});

test('decision 185: a resting limit survives a restart; 15m entries and executor-mirrored books keep the market entry', () => {
  const a = setup();
  a.enter('long');
  const again = new PaperEngine(a.db, () => a.cfg);
  assert.equal(again.pendingEntries().length, 1, 'restored from its row');
  again.onBar('ETHUSD', { time: a.at + 60_000, high: 100, low: 99.3, close: 99.5 }, a.at + 2 * 60_000);
  assert.equal(again.openPositions().length, 1, 'and fills after the restart');

  const h = setup('1h', { limitEntry: { enabled: true, tfs: ['1h', '4h'], atr: 0, atrByTf: { '1h': 0.1 }, bars: 2, books: ['account', 'shadow'] } } as any);
  assert.match(h.enter('long').reason ?? '', /resting limit at 99.8, 0.1 ATR back/, 'the 1h offset from atrByTf');
  const f = setup('4h', { limitEntry: { enabled: true, tfs: ['1h', '4h'], atr: 0, atrByTf: { '1h': 0.1 }, bars: 2, books: ['account', 'shadow'] } } as any);
  assert.match(f.enter('long').reason ?? '', /resting limit at 100, 0 ATR back/, '4h at the signal price');
  const b = setup('15m');
  assert.notEqual(b.enter('long').action, 'pending', '15m is not in limitEntry.tfs: the market entry');
  const c = setup();
  c.engine.limitEntryAllowed = () => false;
  assert.notEqual(c.enter('long').action, 'pending', 'an executor attached: the market entry');
});

test('decision 189: the minute the limit was placed in cannot fill it — its low may have printed before the order existed', () => {
  const { engine, at, enter } = setup();
  enter('long');                                       // placed 1 s into a minute (at = minute + 1 s)
  const placingMinute = at - 1000;
  engine.onBar('ETHUSD', { time: placingMinute, high: 100.2, low: 99.0, close: 99.9 }, placingMinute + 60_000);
  assert.equal(engine.openPositions().length, 0, 'the placing minute traded through the limit, but maybe before the order');
  engine.onBar('ETHUSD', { time: placingMinute + 60_000, high: 99.9, low: 99.3, close: 99.5 }, placingMinute + 2 * 60_000);
  assert.equal(engine.openPositions().length, 1, 'a later minute through the limit fills it');
});

test('decision 190: a limit fill keeps the scanner\'s own stop rule (fallbackAtrSl 3 → stop 3 ATR under the fill)', () => {
  const { engine, at, enter } = setup();
  engine.scannerExit = () => ({ fallbackAtrSl: 3 });
  const d = enter('long');
  assert.equal(d.action, 'pending');
  engine.onBar('ETHUSD', { time: at + 60_000, high: 99.9, low: 99.3, close: 99.5 }, at + 2 * 60_000);
  const [p] = engine.openPositions();
  assert.ok(p, 'filled');
  assert.ok(Math.abs((p.slOriginal ?? 0) - (99.4 - 3 * 2)) < 1e-6, `scanner stop 93.4, got ${p.slOriginal}`);
});

test('decision 190: a lapsed limit cannot fill, even before housekeeping runs, and a fill arriving minutes late is refused', () => {
  const { engine, at, enter } = setup();
  enter('long');
  const expires = engine.pendingEntries()[0].limit!.expiresAt;
  engine.onBar('ETHUSD', { time: expires + 1000, high: 99.9, low: 99.0, close: 99.5 }, expires + 61_000);
  assert.equal(engine.openPositions().length, 0, 'a minute that began after expiry cannot fill');
  const late = setup();
  late.enter('long');
  late.engine.onBar('ETHUSD', { time: late.at + 60_000, high: 99.9, low: 99.0, close: 99.5 }, late.at + 60_000 + 4 * 60_000);
  assert.equal(late.engine.openPositions().length, 0, 'a candle received 4 min after its minute began is history, not a fill');
  // the trade stream: a print through the limit that reaches the engine 4 minutes after it happened is refused
  const tape = setup('4h', { fillSource: 'tape' } as any);
  tape.enter('long');
  tape.engine.onTrade('ETHUSD', 99.3, 1, tape.at + 60_000, tape.at + 60_000 + 4 * 60_000);
  assert.equal(tape.engine.openPositions().length, 0, 'a print delivered 4 min late cannot fill');
  const fresh = setup('4h', { fillSource: 'tape' } as any);
  fresh.enter('long');
  fresh.engine.onTrade('ETHUSD', 99.3, 1, fresh.at + 60_000, fresh.at + 61_000);
  assert.equal(fresh.engine.openPositions().length, 1, 'the same print on time fills');
});

test('maker admission uses the intended limit for fees, levels and depth, rather than the ask', () => {
  const {engine, enter} = setup('4h', {useSpread: true, requireQuote: true, minRiskFeeRatio: 32});
  engine.quotes = {executable: () => 120};
  let request: any;
  engine.entryDepthGate = r => {request = r; return {};};
  const d = enter();
  assert.equal(d.action, 'pending', d.reason);
  assert.equal(request.price, 99.4);
  assert.equal(request.sl, 96.4);
  assert.equal(request.maker, true);
  assert.equal(engine.pendingEntries()[0].limit?.price, 99.4);
});

test('maker planning stays passive after the market moves across the signal and rounds away from crossing', () => {
  for (const side of ['long','short'] as const) {
    const {engine, enter} = setup();
    const quote = side === 'long' ? 98.007 : 102.003;
    engine.quotes = {executable: () => quote};
    assert.equal(enter(side).action, 'pending');
    const limit = engine.pendingEntries()[0].limit!.price;
    assert.equal(limit, side === 'long' ? 97.99 : 102.02);
    assert.ok(side === 'long' ? limit < quote : limit > quote);
  }
});

test('maker planning still requires a fresh quote when configured', () => {
  const {engine, enter} = setup('4h', {useSpread: true, requireQuote: true});
  engine.quotes = {executable: () => null};
  const d = enter();
  assert.equal(d.action, 'rejected');
  assert.match(d.reason!, /no executable/);
  assert.equal(engine.pendingEntries().length, 0);
});

test('a tape print that fills a maker entry beyond its stop must book the gap loss immediately', () => {
  for(const side of ['long','short'] as const){
    const {engine,at,enter,db}=setup('4h',{fillSource:'tape',scalperOffer:{enabled:false,majors:[],majorsMinutes:30,othersMinutes:15,excluded:[]}});
    enter(side);
    const px=side==='long'?95:105;
    engine.onTrade('ETHUSD',px,1,at+1000,at+1100);
    assert.equal(engine.pendingEntries().length,0);
    assert.equal(engine.openPositions().length,0,'the fill print already crossed the stop');
    const row=db.get<{exit_reason:string;exit_price:number;entry_at:number;exit_at:number}>("SELECT exit_reason,exit_price,entry_at,exit_at FROM positions WHERE status='closed'")!;
    assert.equal(row.exit_reason,'sl');assert.equal(row.exit_price,px);
    assert.ok(row.exit_at>=row.entry_at);
    db.db.close();
  }
});

test('a resting candle fill cannot recover from crossing its original stop inside the fill minute', () => {
  for (const side of ['long', 'short'] as const) {
    for (const gap of [false, true]) {
      const {engine, at, enter, db} = setup('4h', {fillSource: 'candles', trailAfterR: 0, floorAtR: 0});
      enter(side);
      const price = engine.pendingEntries()[0].limit!.price;
      const stop = price + (side === 'long' ? -3 : 3);
      const open = gap ? stop + (side === 'long' ? -1 : 1) : 100;
      const minute = {time: at + 60_000, open, high: 110, low: 90, close: 100};
      engine.onBar('ETHUSD', minute, at + 120_000);
      assert.equal(engine.openPositions().length, 0, `${side} gap=${gap}: stop cannot be erased by the recovery`);
      const row = db.get<{exit_reason: string; exit_price: number; entry_at: number; exit_at: number}>("SELECT exit_reason,exit_price,entry_at,exit_at FROM positions WHERE status='closed'")!;
      assert.equal(row.exit_reason, 'sl');
      assert.equal(row.exit_price, gap ? open : stop);
      assert.ok(row.exit_at >= row.entry_at);
      engine.onBar('ETHUSD', minute, at + 120_000);
      assert.equal(db.get<{n:number}>("SELECT count(*) n FROM positions WHERE status='closed'")!.n, 1, 'duplicate delivery cannot close twice');
      db.db.close();
    }
  }
});

test('a resting candle fill does not earn targets or a trail from a possibly pre-fill favourable extreme', () => {
  const {engine, at, enter, db} = setup('4h');
  enter('long');
  engine.onBar('ETHUSD', {time: at + 60_000, high: 120, low: 99.3, close: 99.5}, at + 120_000);
  const [pos] = engine.openPositions();
  assert.ok(pos);
  assert.equal(pos.sl, pos.slOriginal);
  assert.equal(pos.fills.length, 1);
  assert.equal(pos.qtyOpen, pos.qty);
  db.db.close();
});

test('a candle cannot backdate a limit fill across expiry, while a timely partial candle can fill', () => {
  for (const timely of [true, false]) {
    const {engine, at, enter, db} = setup('4h', {limitEntry:{enabled:true,tfs:['4h'],atr:.3,bars:90_000/(4*H),books:['account','shadow']}});
    enter();
    const minute = {time:at+59_000,open:100,high:100,low:99.3,close:99.5};
    engine.onBar('ETHUSD', minute, minute.time+(timely?30_000:60_000));
    assert.equal(engine.openPositions().length, timely?1:0);
    assert.equal(engine.pendingEntries().length, 0);
    db.db.close();
  }
});

test('a failed fill-minute stop write rolls back the entry too and the same candle can retry', () => {
  const {engine, at, enter, db} = setup('4h'); enter();
  const minute = {time:at+60_000,open:100,high:110,low:90,close:100};
  const run = db.run.bind(db); let orderWrites=0, notifications=0;
  engine.on('order',()=>notifications++);
  db.run = ((sql: string, ...args: any[]) => {
    if(sql.includes('INSERT INTO orders') && ++orderWrites === 2) throw Error('injected fill-minute stop write failure');
    return run(sql,...args);
  }) as typeof db.run;
  engine.onBar('ETHUSD',minute,at+120_000);
  assert.equal(engine.openPositions().length,0); assert.equal(engine.pendingEntries().length,1);
  assert.equal(db.all('SELECT * FROM orders').length,0); assert.equal(notifications,0);
  db.run=run;
  engine.onBar('ETHUSD',minute,at+120_000);
  assert.equal(engine.pendingEntries().length,0); assert.equal(engine.openPositions().length,0);
  assert.equal(db.all("SELECT * FROM positions WHERE status='closed' AND exit_reason='sl'").length,1);
  assert.equal(db.all('SELECT * FROM orders').length,2); assert.equal(notifications,2);
  db.db.close();
});

test('failed tape fill and same-print stop retain the pending order and publish no phantom entry',t=>{
  const {engine,at,enter,db}=setup('4h',{fillSource:'tape'});t.after(()=>db.db.close());
  enter();const pending=engine.pendingEntries()[0];let notifications=0;
  engine.on('order',()=>notifications++);engine.on('position',()=>notifications++);
  db.db.exec("CREATE TEMP TRIGGER reject_stop BEFORE INSERT ON orders WHEN NEW.reason='sl' BEGIN SELECT RAISE(ABORT,'injected stop failure'); END");
  assert.doesNotThrow(()=>engine.onTrade('ETHUSD',95,1,at+1000,at+1000));
  assert.equal(engine.openPositions().length,0);assert.equal(engine.pendingEntries()[0],pending);
  assert.equal(db.get<any>('SELECT count(*) n FROM orders')!.n,0);assert.equal(notifications,0);
  assert.equal(db.get<any>('SELECT status FROM positions WHERE id=?',pending.id)!.status,'pending');
  db.db.exec('DROP TRIGGER reject_stop');engine.onTrade('ETHUSD',95,1,at+1001,at+1001);
  assert.equal(engine.pendingEntries().length,0);assert.equal(engine.openPositions().length,0);
  const closed=engine.closedPositions();assert.equal(closed.length,1);assert.equal(closed[0].exitReason,'sl');
  assert.equal(db.get<any>('SELECT count(*) n FROM orders')!.n,2);
});

test('failed cancellation keeps pending state and emits cancellation only after the retry commits',t=>{
  const {engine,enter,db}=setup();t.after(()=>db.db.close());enter();const pe=engine.pendingEntries()[0];let cancellations=0;
  engine.on('pending',()=>cancellations++);
  db.db.exec("CREATE TEMP TRIGGER reject_cancel BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'injected cancellation failure'); END");
  assert.throws(()=>engine.cancelPending(pe.id),/injected/);assert.equal(engine.pendingEntries()[0],pe);assert.equal(cancellations,0);
  db.db.exec('DROP TRIGGER reject_cancel');assert.equal(engine.cancelPending(pe.id),true);assert.equal(engine.pendingEntries().length,0);assert.equal(cancellations,1);
});
