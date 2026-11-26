import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { AlertManager } from './alerts.ts';
import { TradeNotifications } from './tradeNotifications.ts';

test('trade notification intent survives a missed callback and failed delivery, without resending adopted historical closes', async (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  let attempts = 0,
    fail = true;
  const texts: string[] = [];
  const alerts = new AlertManager({
    repeatMinutes: 1,
    maxPerHour: 20,
    transport: async (text) => {
      attempts++;
      if (fail) throw Error('transport unavailable');
      texts.push(text);
    },
  });
  const open = () =>
    Number(
      db.run(
        "INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at) VALUES('open','s','S','BTCUSD','15m','long',1,1,1,100,1)",
      ).lastInsertRowid,
    );
  const close = (id: number) =>
    db.run(
      "UPDATE positions SET status='closed',exit_at=2,realized_pnl=2,fees=.5,risk_amount=1 WHERE id=?",
      id,
    );
  close(open());
  const n = new TradeNotifications(db, alerts, () => true);
  await n.tick(10);
  assert.equal(attempts, 0, 'first installation adopts old alerts quietly');
  close(open());
  await n.tick(100);
  assert.equal(attempts, 1);
  await n.stop();
  const restarted = new TradeNotifications(db, alerts, () => true);
  fail = false;
  await restarted.tick(60101);
  await restarted.tick(120200);
  assert.equal(attempts, 2);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /1.50R/);
  assert.equal(db.get<any>("SELECT count(*) n FROM trade_notifications WHERE state='delivered'")!.n, 1);
  await restarted.stop();
});

test('notification shutdown awaits an acknowledged in-flight send', async (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  let release!: () => void;
  const alerts = new AlertManager({
    repeatMinutes: 1,
    maxPerHour: 20,
    transport: () =>
      new Promise<void>((r) => {
        release = r;
      }),
  });
  const n = new TradeNotifications(db, alerts, () => true);
  db.run("INSERT INTO trade_notifications(event_id,text,target,state) VALUES(1,'x','custom','pending')");
  const sending = n.tick();
  let stopped = false;
  const stop = n.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([sending, stop]);
  assert.equal(stopped, true);
  assert.equal(db.get<any>('SELECT state FROM trade_notifications')!.state, 'delivered');
});
