/**
 * A trade, minute by minute: what it did between the entry and the exit.
 *
 *   npm run forensics                 # the last ten closed trades, summarised
 *   npm run forensics -- 92           # one position, its whole path
 *   SYMBOL=SOLUSD npm run forensics   # the last trades on one market
 *
 * Reads `position_path`, which the engine writes as a trade runs: a sample every minute plus a row
 * for every level event — a target touched, the stop moved by the floor or the trail, the exit.
 */
import { Db } from '../db.ts';

const db = new Db();
const [idArg] = process.argv.slice(2);
const bar = (r: number, w = 28) => {
  const mid = Math.floor(w / 2), n = Math.max(-mid, Math.min(mid, Math.round(r * mid / 3)));
  return n >= 0 ? ' '.repeat(mid) + '█'.repeat(n) : ' '.repeat(mid + n) + '░'.repeat(-n);
};
const t = (x: number) => new Date(x).toISOString().slice(11, 19);

if (idArg) {
  const p = db.get<any>('SELECT * FROM positions WHERE id=?', Number(idArg));
  if (!p) { console.error(`no position ${idArg}`); process.exit(1); }
  const tp: number[] = JSON.parse(p.tp || '[]');
  const risk = Math.abs(p.entry_price - (p.sl_original ?? p.sl));
  console.log(`\n#${p.id} ${p.scanner_id} · ${p.symbol} ${p.tf} ${p.side} · ${p.status}`);
  console.log(`entry ${p.entry_price} at ${t(p.entry_at)} · stop ${p.sl_original ?? p.sl} (1R = ${risk.toFixed(6)}) · targets ${tp.map((x, i) => `${i + 1}:${x} (+${((Math.abs(x - p.entry_price)) / risk).toFixed(1)}R)`).join('  ')}`);
  if (p.exit_at) console.log(`exit  ${Number(p.exit_price).toFixed(6)} at ${t(p.exit_at)} · ${p.exit_reason} · held ${Math.round((p.exit_at - p.entry_at) / 60000)}m · ${((p.realized_pnl - p.fees) / p.risk_amount).toFixed(2)}R`);
  if (p.peak_r != null) console.log(`peak  ${p.peak_r.toFixed(2)}R at ${t(p.peak_at)} (${Math.round((p.peak_at - p.entry_at) / 60000)}m in) · worst ${Number(p.worst_r).toFixed(2)}R`);
  const path = db.all<any>('SELECT * FROM position_path WHERE position_id=? ORDER BY at', p.id);
  if (!path.length) { console.log('\nno path recorded (the trade predates the recorder)'); process.exit(0); }
  console.log(`\n${'time'.padEnd(9)} ${'price'.padStart(12)} ${'R'.padStart(7)} ${'stop'.padStart(12)}  ${'-3R'.padStart(14)}${'+3R'.padEnd(14)} event`);
  for (const s of path) {
    console.log(`${t(s.at).padEnd(9)} ${Number(s.price).toFixed(6).padStart(12)} ${Number(s.r).toFixed(2).padStart(7)} ${(s.sl == null ? '—' : Number(s.sl).toFixed(6)).padStart(12)}  ${bar(s.r)} ${s.event ?? ''}${s.note ? ' · ' + s.note : ''}`);
  }
  process.exit(0);
}

const where = process.env.SYMBOL ? 'AND symbol=?' : '';
const rows = db.all<any>(`SELECT * FROM positions WHERE status='closed' ${where} ORDER BY exit_at DESC LIMIT 12`, ...(process.env.SYMBOL ? [process.env.SYMBOL] : []));
console.log(`\n${'id'.padStart(5)} ${'market'.padEnd(12)} ${'side'.padEnd(5)} ${'held'.padStart(6)} ${'peak'.padStart(7)} ${'when'.padStart(8)} ${'worst'.padStart(7)} ${'result'.padStart(7)}  why`);
for (const p of rows) {
  const held = Math.round((p.exit_at - p.entry_at) / 60000);
  const toPeak = p.peak_at ? Math.round((p.peak_at - p.entry_at) / 60000) + 'm' : '—';
  const r = p.risk_amount > 0 ? (p.realized_pnl - p.fees) / p.risk_amount : 0;
  console.log(`${String(p.id).padStart(5)} ${p.symbol.padEnd(12)} ${p.side.padEnd(5)} ${(held + 'm').padStart(6)} ${(p.peak_r == null ? '—' : p.peak_r.toFixed(2) + 'R').padStart(7)} ${toPeak.padStart(8)} ${(p.worst_r == null ? '—' : Number(p.worst_r).toFixed(2) + 'R').padStart(7)} ${(r.toFixed(2) + 'R').padStart(7)}  ${p.exit_reason}`);
}
console.log(`\nnpm run forensics -- <id> for one trade's whole path`);
process.exit(0);
