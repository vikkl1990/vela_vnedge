import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, type SignalRow } from '../src/db.ts';

test('signal side filtering precedes the recent-row cap and preserves stable ordering', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const seed: Omit<SignalRow, 'id'> = { at:1, barTime:1, scannerId:'a', scannerName:'A', symbol:'ETHUSD',tf:'15m',kind:'entry',side:'long',price:1,sl:0.9,tp:[],score:null,label:'Entry',message:'',summary:'',source:'alert',levelsSource:null,action:'opened',positionId:null };
  db.insertSignal(seed);
  db.insertSignal({...seed,at:2,barTime:2,side:'short'});
  db.insertSignal({...seed,at:3,barTime:3,side:'short'});
  assert.equal(db.signals({limit:1})[0].side,'short');
  assert.equal(db.signals({limit:1,side:'long',symbol:'ETHUSD',scanner:'a',kind:'entry',tf:'15m'})[0].at,1);
  assert.deepEqual(db.signals({limit:1,side:'long',since:2}),[]);
  assert.deepEqual(db.signals({limit:1,side:"long' OR 1=1 --"}),[]);
});
