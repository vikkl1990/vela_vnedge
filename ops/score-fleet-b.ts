#!/usr/bin/env node
/**
 * Score the parallel list against the rest of the paper account (decision 312). Read-only.
 *
 *   node ops/score-fleet-b.ts            VNEDGE_DB and VNEDGE_CONFIG override the paths; FLEET_ID the fleet (default fleet-b)
 *
 * The comparison is made on excess R: a trade's net R minus the average of same-side, same-timeframe shadow trades opened since
 * the fleet went in, so a list of long-only or short-only cells is not rewarded for the market's drift. Both groups cover the
 * same days. Nothing is called before 14 days and 60 fleet trades; the standard error is clustered by closing day because
 * trades closed on one day move together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { FleetMarker } from './enable-fleet-b.ts';

const DAY = 86_400_000;
export const MIN_DAYS = 14;
export const MIN_FLEET_TRADES = 60;

export interface ScoredTrade { sc: string; sym: string; tf: string; side: string; at: number; exitAt: number; r: number }
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
/** Standard error of the mean with trades clustered by closing day; null with fewer than two days. */
export function clusteredSe(rows: Array<{ x: number; exitAt: number }>): number | null {
  const m = mean(rows.map((r) => r.x));
  const byDay = new Map<number, number>();
  for (const r of rows) { const d = Math.floor(r.exitAt / DAY); byDay.set(d, (byDay.get(d) ?? 0) + r.x - m); }
  if (byDay.size < 2 || !rows.length) return null;
  let ss = 0; for (const v of byDay.values()) ss += v * v;
  return Math.sqrt(ss) / rows.length;
}

export function scoreTrades(account: ScoredTrade[], shadow: ScoredTrade[], cells: Array<{ scannerId: string; symbol: string; tf: string }>, appliedAt: number, now: number) {
  const base = new Map<string, number[]>();
  for (const t of shadow) { const k = `${t.side}|${t.tf}`; (base.get(k) ?? base.set(k, []).get(k)!).push(t.r); }
  const baseline = new Map([...base].map(([k, v]) => [k, mean(v)]));
  const inFleet = new Set(cells.map((c) => `${c.scannerId}|${c.symbol}|${c.tf}`));
  const rows = account.filter((t) => t.at >= appliedAt).map((t) => ({ ...t, x: t.r - (baseline.get(`${t.side}|${t.tf}`) ?? 0), fleet: inFleet.has(`${t.sc}|${t.sym}|${t.tf}`) }));
  const group = (list: typeof rows) => ({ trades: list.length, rawR: mean(list.map((t) => t.r)), excessR: mean(list.map((t) => t.x)), se: clusteredSe(list) });
  const fleet = group(rows.filter((t) => t.fleet)), rest = group(rows.filter((t) => !t.fleet));
  const days = Math.max(0, (now - appliedAt) / DAY);
  const diff = fleet.excessR - rest.excessR;
  const diffSe = fleet.se !== null && rest.se !== null ? Math.sqrt(fleet.se ** 2 + rest.se ** 2) : null;
  let verdict: string;
  if (days < MIN_DAYS || fleet.trades < MIN_FLEET_TRADES) verdict = `too early: ${days.toFixed(1)}/${MIN_DAYS} days, ${fleet.trades}/${MIN_FLEET_TRADES} fleet trades`;
  else if (diffSe === null) verdict = 'no verdict: too few closing days to put an interval on the difference';
  else if (diff - 1.96 * diffSe > 0) verdict = 'the parallel list is ahead of the rest of the account';
  else if (diff + 1.96 * diffSe < 0) verdict = 'the parallel list is behind the rest of the account';
  else verdict = 'no difference detected between the parallel list and the rest of the account';
  const perCell = cells.map((c) => {
    const own = rows.filter((t) => t.sc === c.scannerId && t.sym === c.symbol && t.tf === c.tf);
    return { ...c, trades: own.length, rawR: mean(own.map((t) => t.r)), excessR: mean(own.map((t) => t.x)) };
  }).sort((a, b) => b.trades - a.trades);
  return { days, fleet, rest, difference: diff, differenceSe: diffSe, verdict, perCell };
}

export function scoreFleet(o: { dbFile: string; markerFile: string; now?: number }) {
  const now = o.now ?? Date.now();
  const mark = JSON.parse(fs.readFileSync(o.markerFile, 'utf8')) as FleetMarker;
  const db = new DatabaseSync(o.dbFile, { readOnly: true });
  try {
    const q = (bt: number) => db.prepare("SELECT scanner_id sc, symbol sym, tf, side, entry_at at, exit_at exitAt, (realized_pnl-fees)/risk_amount r FROM positions WHERE bt=? AND status='closed' AND risk_amount>0 AND scanner_id NOT LIKE 'plan:%' AND entry_at>=?").all(bt, mark.appliedAt) as unknown as ScoredTrade[];
    return { fleetId: mark.id, appliedAt: mark.appliedAt, ...scoreTrades(q(0), q(2), mark.added, mark.appliedAt, now) };
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const configFile = process.env.VNEDGE_CONFIG ?? path.join(root, 'data', 'config.json');
  const dbFile = process.env.VNEDGE_DB ?? path.join(path.dirname(configFile), 'vnedge.db');
  const markerFile = path.join(path.dirname(configFile), `${process.env.FLEET_ID ?? 'fleet-b'}.json`);
  const f = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(d));
  const r = scoreFleet({ dbFile, markerFile });
  console.log(`${r.fleetId}: ${r.days.toFixed(1)} days since ${new Date(r.appliedAt).toISOString().slice(0, 16)} UTC`);
  console.log(`parallel list  ${String(r.fleet.trades).padStart(4)} trades  raw ${f(r.fleet.rawR)}R  excess ${f(r.fleet.excessR)}R ±${f(r.fleet.se)}`);
  console.log(`rest of account ${String(r.rest.trades).padStart(3)} trades  raw ${f(r.rest.rawR)}R  excess ${f(r.rest.excessR)}R ±${f(r.rest.se)}`);
  console.log(`difference ${f(r.difference)}R ±${f(r.differenceSe)}  ->  ${r.verdict}`);
  for (const c of r.perCell) console.log(`  ${c.scannerId.slice(0, 40).padEnd(41)}${c.symbol.padEnd(11)}${c.tf.padEnd(4)}${String(c.trades).padStart(3)} trades  raw ${f(c.rawR)}  excess ${f(c.excessR)}`);
}
