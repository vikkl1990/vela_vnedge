/**
 * Replay the account's own closed trades under different exit rules — through the real engine.
 *
 *   LIVE=positions.json npm run replay
 *
 * Every other exit test used backtest entries. This uses the trades the account actually took: their
 * real fill, stop, targets and size, walked forward on 1m candles by `applyBar` itself, so the rules
 * measured here are the rules that trade. The tool it replaces hand-rolled a copy of the policy and
 * had quietly gone stale — it still modelled the trail as 60% of the peak from 1.5R, two decisions
 * out of date.
 *
 * Manual closes are replaced by the rule, which is the point: it shows what each policy would have
 * done with the position rather than what was done by hand.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { ConfigStore, type ExitOverride } from '../config.ts';
import { applyBar, openPosition, type Position } from '../paper/logic.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const HOURS = Number(process.env.HOURS ?? 24);
const rows = JSON.parse(fs.readFileSync(process.env.LIVE!, 'utf8')).filter((p: any) => p.exit_at && p.risk_amount > 0);
const rest = new DeltaRest();

type Over = ExitOverride & { barOrder?: 'stop-first' | 'target-first' };
const POLICIES: Array<{ name: string; over: Over }> = [
  { name: 'before 24 Sep (floor 1/0.5, trail 60% from 1.5R)', over: { floorAtR: 1, floorKeepR: 0.5, trailAfterR: 1.5, trailGiveBackPct: 40, trailSteps: [], trailStall: { minutes: 0, factor: 1 } } },
  { name: 'trail from 1R (decision 34)', over: { floorAtR: 1, floorKeepR: 0.5, trailAfterR: 1, trailGiveBackPct: 40, trailSteps: [], trailStall: { minutes: 0, factor: 1 } } },
  // spelled out rather than inherited: a policy that depends on whichever config file is loaded is
  // how this comparison first came out with two identical rows
  { name: 'deployed now (steps + stall, decision 36)', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 } } },
  { name: 'deployed, read optimistically', over: { trailAfterR: 1, trailSteps: [[2, 30], [4, 20]], trailStall: { minutes: 45, factor: 0.6 }, barOrder: 'target-first' } },
];

const bars = new Map<string, any[]>();
for (const s of new Set<string>(rows.map((r: any) => r.symbol))) {
  const es = rows.filter((r: any) => r.symbol === s);
  const from = Math.floor(Math.min(...es.map((e: any) => e.entry_at)) / 1000) - 120;
  const to = Math.floor((Math.max(...es.map((e: any) => e.entry_at)) + HOURS * 3600_000) / 1000);
  bars.set(s, await rest.candles(s, '1m', from, to, 60_000));
}

/** One trade under one policy, through the engine that trades it. */
function replay(t: any, over: Over): { r: number; why: string; mins: number } {
  const paper = { ...cfg.paper, ...over };
  const pos: Position = openPosition({
    id: t.id, scannerId: t.scanner_id, scannerName: t.scanner_name, symbol: t.symbol, tf: t.tf, side: t.side,
    qty: t.qty, contractValue: t.contract_value, entryPrice: t.entry_price, at: t.entry_at,
    sl: t.sl_original ?? t.sl, tp: JSON.parse(t.tp || '[]'), riskAmount: t.risk_amount,
    levelsSource: t.levels_source ?? 'script', signalId: null, cfg: paper, bt: true,
  });
  const path = (bars.get(t.symbol) ?? []).filter(b => b.time * 1000 >= t.entry_at && b.time * 1000 <= t.entry_at + HOURS * 3600_000);
  for (const b of path) {
    applyBar(pos, { time: b.time * 1000, high: b.high, low: b.low, close: b.close }, paper);
    if (pos.status === 'closed') break;
  }
  const mins = Math.round(((pos.exitAt ?? t.entry_at) - t.entry_at) / 60_000);
  const r = (pos.realizedPnl - pos.fees) / t.risk_amount;
  return { r, why: pos.exitReason ?? 'open at the horizon', mins };
}

console.log(`${rows.length} real trades, replayed on 1m candles for up to ${HOURS}h\n`);
const actual = rows.reduce((a: number, t: any) => a + (t.realized_pnl - t.fees) / t.risk_amount, 0);
console.log(`as they actually ended (including manual closes): ${actual >= 0 ? '+' : ''}${actual.toFixed(2)}R\n`);
console.log(`${'policy'.padEnd(48)} ${'total'.padStart(8)} ${'per trade'.padStart(10)} ${'win'.padStart(5)} ${'median hold'.padStart(12)}`);
const per = new Map<string, Array<{ t: any; r: number; why: string; mins: number }>>();
for (const p of POLICIES) {
  const out: Array<{ t: any; r: number; why: string; mins: number }> = rows.map((t: any) => ({ t, ...replay(t, p.over) }));
  per.set(p.name, out);
  const tot = out.reduce((a, x) => a + x.r, 0);
  const wins = out.filter(x => x.r > 0).length;
  const holds = out.map(x => x.mins).sort((a, b) => a - b);
  console.log(`${p.name.padEnd(48)} ${(tot >= 0 ? '+' : '') + tot.toFixed(2) + 'R'} ${((tot / out.length >= 0 ? '+' : '') + (tot / out.length).toFixed(3) + 'R').padStart(10)} ${(Math.round(100 * wins / out.length) + '%').padStart(5)} ${(holds[Math.floor(holds.length / 2)] + 'm').padStart(12)}`);
}

// where the deployed policy differs from the one these trades were actually taken under
const before = per.get(POLICIES[0].name)!, now = per.get(POLICIES[2].name)!;
const moved = before.map((b, i) => ({ sym: b.t.symbol, scanner: b.t.scanner_id, before: b.r, after: now[i].r, whyB: b.why, whyA: now[i].why }))
  .filter(x => Math.abs(x.after - x.before) > 0.05)
  .sort((a, b) => (b.after - b.before) - (a.after - a.before));
if (moved.length) {
  console.log(`\n${moved.length} of ${rows.length} trades end differently under the deployed policy:\n`);
  console.log(`${'market'.padEnd(12)} ${'scanner'.padEnd(28)} ${'before'.padStart(8)} ${'after'.padStart(8)} ${'change'.padStart(8)}   ${'was'.padEnd(12)} now`);
  for (const m of moved) console.log(`${m.sym.padEnd(12)} ${m.scanner.slice(0, 28).padEnd(28)} ${(m.before.toFixed(2) + 'R').padStart(8)} ${(m.after.toFixed(2) + 'R').padStart(8)} ${((m.after - m.before >= 0 ? '+' : '') + (m.after - m.before).toFixed(2) + 'R').padStart(8)}   ${m.whyB.padEnd(12)} ${m.whyA}`);
}
// DETAIL=path writes every trade, as it happened and as each policy would have ended it
if (process.env.DETAIL) {
  const cols = POLICIES.map(p => p.name);
  const lines: string[] = [];
  lines.push(`# Trades reconstructed — ${new Date().toISOString().slice(0, 10)}`, '');
  lines.push(`${rows.length} closed trades, replayed on 1m candles through the live exit engine. "actual" is what the`);
  lines.push('account did, manual closes included; every other column replaces those with the rule.', '');
  lines.push('| # | opened | market | scanner | side | entry | stop | peak | actual | why | ' + cols.map(c => c.split(' (')[0]).join(' | ') + ' |');
  lines.push('|---|---|---|---|---|---:|---:|---:|---:|---|' + cols.map(() => '---:').join('|') + '|');
  rows.forEach((t: any, i: number) => {
    const actual = (t.realized_pnl - t.fees) / t.risk_amount;
    const cells = cols.map(c => {
      const x = per.get(c)![i];
      return `${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R`;
    });
    lines.push(`| ${i + 1} | ${new Date(t.entry_at).toISOString().slice(11, 16)} | ${t.symbol} | ${t.scanner_id} | ${t.side} | ${t.entry_price} | ${t.sl_original ?? t.sl} | ${t.peak_r == null ? '—' : (t.peak_r >= 0 ? '+' : '') + Number(t.peak_r).toFixed(2) + 'R'} | ${actual >= 0 ? '+' : ''}${actual.toFixed(2)}R | ${t.exit_reason} | ${cells.join(' | ')} |`);
  });
  const sum = (f: (x: any) => number) => rows.reduce((a: number, t: any, i: number) => a + f({ t, i }), 0);
  lines.push('', `**Totals** — actual ${sum(({ t }) => (t.realized_pnl - t.fees) / t.risk_amount).toFixed(2)}R · ` +
    cols.map(c => `${c.split(' (')[0]} ${per.get(c)!.reduce((a, x) => a + x.r, 0).toFixed(2)}R`).join(' · '));
  fs.writeFileSync(process.env.DETAIL, lines.join('\n') + '\n');
  console.log(`\nwrote ${rows.length} reconstructed trades to ${process.env.DETAIL}`);
}
process.exit(0);
