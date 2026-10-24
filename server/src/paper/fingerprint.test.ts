import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { Db } from '../db.ts';
import { PaperEngine } from './engine.ts';
import { configFingerprint, SIM_VERSION } from './fingerprint.ts';

test('decision 190: the fingerprint moves with the limit entry, fees, margin sizing, the size rule, the source and the book', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  const fp = (c = base, o: { source?: string | null; book?: number } = {}) => configFingerprint(c, 's', '1h', o).fp;
  const ref = fp();
  const change = (f: (c: typeof base) => void) => { const c = structuredClone(base); f(c); return fp(c); };
  assert.notEqual(change(c => { c.paper.limitEntry = { ...c.paper.limitEntry!, atr: 9 }; }), ref, 'limit offset');
  assert.notEqual(change(c => { c.paper.feeRatePct = 9; }), ref, 'fee rate');
  assert.notEqual(change(c => { (c.paper as any).marginPerTrade = 999; }), ref, 'margin per trade');
  assert.notEqual(change(c => { c.risk.ddScale = [{ ddPct: 30, leverageMult: 0.1 }]; }), ref, 'drawdown size rule');
  assert.notEqual(fp(base, { source: 'abc' }), ref, 'scanner source');
  assert.notEqual(fp(base, { book: 2 }), fp(base, { book: 0 }), 'book');
  assert.equal(fp(), ref, 'stable for the same settings');
  assert.equal(configFingerprint(base, 's', '1h').parts.sim, SIM_VERSION);
});

test('decision 190: an opened trade stores its fingerprint\'s full settings once', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0 });
  const engine = new PaperEngine(db, () => cfg);
  engine.sourceHashFor = () => 'feedbeef0000';
  const open = () => engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  const p = open();
  const rows = db.all<any>('SELECT * FROM config_fingerprints');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fp, p.configFp);
  const parts = JSON.parse(rows[0].parts);
  assert.equal(parts.source, 'feedbeef0000');
  assert.equal(parts.paper.feeRatePct, 0);
});
