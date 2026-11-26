import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { JournalConsumer } from './journalConsumer.ts';
import { MlService } from '../ml/service.ts';

test('independent journal consumers commit derived writes and cursors together, including late closes of older positions', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const a = new JournalConsumer(db, 'a'),
    b = new JournalConsumer(db, 'b');
  db.run('CREATE TABLE derived(event_id INTEGER PRIMARY KEY)');
  const event = () =>
    db.run(
      "INSERT INTO decision_trace(at,book,scanner_id,symbol,tf,stage) VALUES(1,0,'s','BTCUSD','15m','closed')",
    );
  event();
  assert.throws(() =>
    a.consume((e) => {
      db.run('INSERT INTO derived VALUES(?)', e.id);
      throw Error('kill boundary');
    }),
  );
  assert.equal(db.get<any>('SELECT count(*) n FROM derived')!.n, 0);
  a.consume((e) => db.run('INSERT INTO derived VALUES(?)', e.id));
  assert.equal(
    a.consume(() => assert.fail('already consumed')),
    0,
  );
  let seen = 0;
  b.consume(() => seen++);
  assert.equal(seen, 1, 'one consumer cannot advance another');
  event();
  a.consume((e) => db.run('INSERT INTO derived VALUES(?)', e.id));
  assert.equal(db.get<any>('SELECT count(*) n FROM derived')!.n, 2);
});

test('a lost close callback recovers its exact saved ML features and outcome once; shadow is never training evidence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const ml = new MlService(db, () => ({}));
  for (const book of [0, 2]) {
    const id = db.run(
      "INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt,fills,risk_amount) VALUES('open','s','S','BTCUSD','15m','long',1,1,1,100,10,?,?,2)",
      book,
      JSON.stringify({ features: { saved: 7 }, fills: [] }),
    ).lastInsertRowid;
    db.run(
      "UPDATE positions SET status='closed',qty_open=0,exit_at=20,realized_pnl=3,fees=1,exit_reason='manual' WHERE id=?",
      id,
    );
  }
  const recovered = new MlService(db, () => ({}));
  recovered.recoverClosedSamples();
  recovered.recoverClosedSamples();
  assert.equal(recovered.count().live, 1);
  const sample = recovered.samples()[0];
  assert.deepEqual(sample.features, { saved: 7 });
  assert.equal(sample.r, 1);
  assert.equal(sample.pnl, 2);
  assert.equal(sample.resolvedAt, 20);
});
