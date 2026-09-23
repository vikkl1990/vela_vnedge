/**
 * The state of the system, read from the machine that trades it.
 *
 *   npm run state                 # prints markdown
 *   npm run state > ../docs/STATE.md
 *
 * Never hand-edit the output. Everything here is read from the live config and database, so if this
 * disagrees with any document, this is right and the document is stale. `docs/SYSTEM.md` holds the
 * rules and why they exist; `docs/DECISIONS.md` holds the history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../db.ts';
import { ConfigStore, DATA_DIR } from '../config.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { pairStats } from '../incubator/gate.ts';
import { IncubatorStore } from '../incubator/store.ts';

const cfg = new ConfigStore().get();
const db = new Db();
const store = new IncubatorStore(db);
const now = Date.now();
const p = cfg.paper;
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const days = (t: number) => (now - t) / 86_400_000;
const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');

console.log(`# State\n`);
console.log(`Generated ${iso(now)} from \`${DATA_DIR}\`. Do not edit: run \`npm run state\`.\n`);

// ---- what it trades ----
const fleet = Object.entries(cfg.scanners)
  .filter(([, v]) => v.enabled && !v.hidden)
  .flatMap(([id, v]) => (v.symbols ?? cfg.symbols).map(s => ({ id, symbol: s, tf: (v.timeframes ?? cfg.timeframes)[0] })));
const registry = new ScannerRegistry();
console.log(`## Live fleet — ${fleet.length} pairs\n`);
console.log('| scanner | market | tf | live trades | net $ | last trade |');
console.log('|---|---|---|---:|---:|---|');
for (const f of fleet) {
  const t = db.all<any>("SELECT realized_pnl, fees, exit_at FROM positions WHERE bt=0 AND status='closed' AND scanner_id=? AND symbol=?", f.id, f.symbol);
  const net = t.reduce((a, x) => a + x.realized_pnl - x.fees, 0);
  console.log(`| ${registry.get(f.id)?.name ?? f.id} | ${f.symbol} | ${f.tf} | ${t.length} | ${r2(net)} | ${iso(Math.max(0, ...t.map(x => x.exit_at ?? 0)))} |`);
}

// ---- how it trades ----
const te = p.trendExit;
console.log(`\n## Trading rules in force\n`);
console.log('| rule | value |');
console.log('|---|---|');
console.log(`| stop when the script gives none | ${p.fallbackAtrSl} × ATR(14) |`);
console.log(`| targets when the script gives none | ${p.fallbackRR.join(' / ')} R, split ${p.tpSplit.map(x => `${Math.round(x * 100)}%`).join(' / ')} |`);
console.log(`| profit floor | at +${p.floorAtR}R the stop moves to +${p.floorKeepR}R |`);
console.log(`| trail | from +${p.trailAfterR}R keep ${100 - (p.trailGiveBackPct ?? 0)}% of the peak${(p.trailAtrMult ?? 0) > 0 ? ` (ATR ${p.trailAtrMult}×)` : ''} |`);
console.log(`| reversal on opposite signal | ${p.allowReversal ? `yes, above ${p.reversalMinR}R` : 'no'} |`);
console.log(`| trend exit | ${te?.enabled ? `on: EMA ${te.emaLen}, above ${te.minR}R` : 'off'} |`);
console.log(`| sizing | ${p.sizingMode}, risk ${p.riskPerTradePct}% of equity, stop loss capped at ${p.maxStopLossPct}% |`);
console.log(`| entry filter | stop ≥ ${p.minRiskFeeRatio}× round-trip fee; signal younger than ${p.maxSignalAgeSec}s |`);
console.log(`| fees | ${p.feeRatePct}% taker + ${p.feeTaxPct ?? 0}% GST; Scalper Offer ${p.scalperOffer?.enabled ? `on (${p.scalperOffer.majorsMinutes}m majors / ${p.scalperOffer.othersMinutes}m others)` : 'off'} |`);
console.log(`| fills | ${p.fillSource}${p.useSpread ? ', crossing the quoted spread' : ''}, slippage ${p.slippageBps} bps |`);
console.log(`| open positions | max ${p.maxOpenPositions} |`);
console.log(`| exchange mirroring | ${cfg.execution.mode}${cfg.execution.mode === 'paper' ? ' (nothing is sent to an exchange)' : ''} |`);
console.log(`| auto-tune | ${cfg.autoTune.enabled ? 'on' : 'off'} |`);

// ---- the account ----
const closed = db.all<any>("SELECT realized_pnl, fees, risk_amount, exit_reason, entry_at FROM positions WHERE bt=0 AND status='closed'");
const open = db.get<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE bt=0 AND status='open'")?.n ?? 0;
const net = closed.reduce((a, x) => a + x.realized_pnl - x.fees, 0);
const wins = closed.filter(x => x.realized_pnl - x.fees > 0).length;
const resetAt = db.kvGet<number>('paper.resetAt');
console.log(`\n## Paper account\n`);
console.log(`- ${closed.length} closed trades, ${open} open${resetAt ? `, since the reset on ${iso(resetAt)}` : ''}`);
console.log(`- net ${r2(net)} on ${p.initialEquity} starting equity · ${closed.length ? Math.round(wins / closed.length * 100) : 0}% winners`);
const fleetKey = new Set(fleet.map(f => `${f.id}|${f.symbol}`));
const orphan = db.all<any>("SELECT scanner_id, symbol, COUNT(*) n, SUM(realized_pnl-fees) net FROM positions WHERE bt=0 AND status='closed' GROUP BY 1,2")
  .filter(x => !fleetKey.has(`${x.scanner_id}|${x.symbol}`));
if (orphan.length) console.log(`- ${orphan.reduce((a, x) => a + x.n, 0)} of them came from pairs no longer in the fleet: ${orphan.map(x => `${x.symbol} ${r2(x.net)}`).join(', ')}`);
if (closed.length) {
  const byReason = closed.reduce((m: Record<string, number>, x) => ({ ...m, [x.exit_reason ?? '?']: (m[x.exit_reason ?? '?'] ?? 0) + 1 }), {});
  console.log(`- exits: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

// ---- the incubator ----
const counts = store.counts();
const shadow = store.list(['shadow', 'proposed']);
const shadowTrades = db.all<any>("SELECT scanner_id, symbol, tf, realized_pnl, fees, risk_amount FROM positions WHERE bt=2 AND status='closed' AND risk_amount>0");
const pairDays = shadow.reduce((a, s) => a + days(s.since), 0);
const rate = pairDays > 0 ? shadowTrades.length / pairDays : 0;
console.log(`\n## Incubator\n`);
console.log(`- stages: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`- shadow book: ${shadow.length}/${cfg.incubator.maxShadow} slots, oldest ${r2(Math.max(0, ...shadow.map(s => days(s.since))))} days`);
console.log(`- shadow trades: ${shadowTrades.length} closed at ${r2(rate)} per market-day`);
const g = cfg.incubator.gate;
console.log(`- gate (${g.pool === 'cohort' ? 'pooled per scanner × timeframe' : 'per market'}): ≥${g.minTrades} trades over ≥${g.minDays} days, PF ≥ ${g.minPfR}, ≥${g.minPositiveWeeksPct}% of weeks positive, ≥${g.minAvgR}R per trade, ≥${g.minPositiveMarketsPct}% of judgeable markets positive`);
console.log(`- retired unproven after ${g.maxDays} days (${Object.entries(g.maxDaysByTf ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'all timeframes'}); cohorts of ${Object.entries(cfg.incubator.admit.cohortMarkets).map(([k, v]) => `${k} ${v}`).join(', ')} markets`);
console.log(`- promotion: at most ${cfg.incubator.promote.maxPerWeek} per week, fleet capped at ${cfg.incubator.promote.maxFleet} pairs, owner approves each one`);
const byTf: Record<string, { n: number; d: number; t: number; c: Set<string> }> = {};
for (const s of shadow) { const b = byTf[s.tf] ??= { n: 0, d: 0, t: 0, c: new Set() }; b.n++; b.d += days(s.since); b.c.add(s.scannerId); }
for (const t of shadowTrades) { const b = byTf[t.tf]; if (b) b.t++; }
console.log(`\n| timeframe | shadow pairs | cohorts | trades | per market-day | days to a pooled sample |`);
console.log('|---|---:|---:|---:|---:|---:|');
for (const [tf, b] of Object.entries(byTf)) {
  const rr = b.d > 0 ? b.t / b.d : 0;
  const size = cfg.incubator.admit.cohortMarkets[tf] ?? cfg.incubator.admit.cohortMarkets.default ?? 5;
  console.log(`| ${tf} | ${b.n} | ${b.c.size} | ${b.t} | ${r2(rr)} | ${rr > 0 ? Math.round(g.minTrades / (rr * size)) : 'no trades yet'} |`);
}
const lastRun: any = db.kvGet('incubator.lastRun');
if (lastRun) console.log(`\n- last screen: ${iso(lastRun.at)}, slice ${lastRun.slice}, ${lastRun.scripts} scripts × ${lastRun.symbols} markets, ${lastRun.runs} runs, ${lastRun.passed} passed, ${Math.round((lastRun.ms ?? 0) / 60000)} min`);

// ---- the library ----
const all = registry.all();
console.log(`\n## Library\n`);
console.log(`- ${all.length} scripts, ${all.filter(s => s.status === 'ok').length} runnable, ${all.filter(s => s.status !== 'ok').length} not`);
console.log(`- proposals waiting for you: ${counts.proposed ?? 0} promotion, ${counts.demote_proposed ?? 0} demotion`);
