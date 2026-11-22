// Read-only export of every resting-limit entry the account and the shadow book placed on 1h and 4h, filled or not.
// Run on the VM with a memory cap, as the research rules require, and write the result to a file:
//   systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0 nice -n 19 node --no-warnings export-cases.mjs > cases.json
// It reads /opt/vnedge/data/vnedge.db read-only and the `paper` section of config.json (no secrets live there). Set-based
// queries only: a correlated subquery over the trace made a first version run for minutes.
//
// What each book keeps, which decides what can be exported:
//  - the trace row at placement says "resting limit at X, 0.1 ATR back, for 2 1h bars": the exact price and the placement time
//  - the account's signals table has the side and bar time (its price column is null: the engine used the bar close)
//  - the shadow book keeps no signal id. A filled order has its position (side, fill); an order that lapsed has only its
//    gated_signals row, found by scanner, market, timeframe and signal bar. A lapsed shadow order with no such row has no
//    recoverable side and is counted, not guessed.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const dir = process.env.DATA_DIR ?? '/opt/vnedge/data';
const db = new DatabaseSync(`${dir}/vnedge.db`, { readOnly: true });
const q = (s, ...a) => db.prepare(s).all(...a);
const days = Number(process.env.DAYS ?? 40), from = Date.now() - days * 86_400_000;
const TF = { '1h': 3_600_000, '4h': 14_400_000 };
const paper = JSON.parse(fs.readFileSync(`${dir}/config.json`, 'utf8')).paper;
const signals = new Map(q("SELECT id, at, bar_time, side FROM signals WHERE tf IN ('1h','4h') AND at>=?", from).map((s) => [s.id, s]));
const pending = q("SELECT book, signal_id, position_id, scanner_id, symbol, tf, at, reason FROM decision_trace WHERE stage='pending' AND tf IN ('1h','4h') AND at>=? AND position_id IS NOT NULL", from);
const filled = new Set(q("SELECT book||':'||position_id k FROM decision_trace WHERE stage='filled' AND at>=?", from).map((x) => x.k));
const positions = new Map(q("SELECT id, bt, side, entry_at, entry_price, status, realized_pnl, fees, risk_amount FROM positions WHERE bt IN (0,2) AND tf IN ('1h','4h') AND entry_at>=?", from).map((p) => [`${p.bt}:${p.id}`, p]));
const gatedSide = new Map(q("SELECT scanner_id, symbol, tf, bar_time, side FROM gated_signals WHERE book=2 AND tf IN ('1h','4h') AND at>=? AND side IS NOT NULL", from).map((g) => [`${g.scanner_id}|${g.symbol}|${g.tf}|${g.bar_time}`, g.side]));
const seen = new Set(), cases = [], skipped = { duplicate: 0, noSide: 0, noLimitPrice: 0, noSignal: 0 };
for (const t of pending) {
  const key = `${t.book}:${t.position_id}`;
  if (seen.has(key) || ![0, 2].includes(t.book)) { skipped.duplicate++; continue; }
  seen.add(key);
  const limitPrice = Number(/resting limit at ([0-9.eE+-]+)/.exec(t.reason ?? '')?.[1]);
  if (!(limitPrice > 0)) { skipped.noLimitPrice++; continue; }
  const tfMs = TF[t.tf], p = positions.get(key);
  let signalAt = t.at, barTime = Math.floor(t.at / tfMs) * tfMs - tfMs, side = p?.side ?? null;
  if (t.book === 0) {
    const s = signals.get(t.signal_id);
    if (!s) { skipped.noSignal++; continue; }
    signalAt = s.at; barTime = s.bar_time; side = s.side;
  } else if (!side) side = gatedSide.get(`${t.scanner_id}|${t.symbol}|${t.tf}|${barTime}`) ?? null;
  if (side !== 'long' && side !== 'short') { skipped.noSide++; continue; }
  const done = p && p.status === 'closed' && p.risk_amount > 0;
  cases.push({ key, book: t.book, scannerId: t.scanner_id, symbol: t.symbol, tf: t.tf, side, signalAt, barTime, reference: 0, atr: 0, limitPrice,
    actual: filled.has(key) && p ? { entryAt: p.entry_at, entryPrice: p.entry_price, netR: done ? (p.realized_pnl - p.fees) / p.risk_amount : null } : null });
}
console.log(JSON.stringify({ exportedAt: new Date().toISOString(), windowDays: days, skipped, paper, cases }));
