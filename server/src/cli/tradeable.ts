/**
 * Which markets this account can actually take a trade in.
 *
 *   npm run tradeable                       # the live fleet and the incubator's universe
 *   EQUITY=5000 MARKETS=BTCUSD,ETHUSD npm run tradeable
 *
 * `maxStopLossPct` caps the loss at the stop as a share of equity. One contract is indivisible, so
 * when a single contract's loss at a normal stop exceeds that cap, every signal on that market is
 * rejected — the bot looks idle when it is really priced out. This measures the smallest account
 * each market needs, from its contract size and its own volatility.
 */
import { DeltaRest } from '../delta/rest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { lastAtr } from '../data/indicators.ts';
import { Db } from '../db.ts';
import { PaperEngine } from '../paper/engine.ts';

const cfg = new ConfigStore().get();
const db = new Db();
const equity = Number(process.env.EQUITY ?? 0) || new PaperEngine(db, () => cfg).equity();
const cap = cfg.paper.maxStopLossPct;
const tf = process.env.TF ?? cfg.timeframes[0] ?? '15m';
const rest = new DeltaRest();

const fleet = new Map<string, string[]>();
for (const [id, v] of Object.entries(cfg.scanners)) if (v.enabled && !v.hidden) for (const s of (v.symbols ?? cfg.symbols)) {
  const g = fleet.get(s); g ? g.push(id) : fleet.set(s, [id]);
}
const extra = (process.env.MARKETS ?? '').split(',').filter(Boolean);
const shadow = db.all<{ symbol: string }>("SELECT DISTINCT symbol FROM incubator_pairs WHERE stage IN ('shadow','proposed')").map(r => r.symbol);
const markets = [...new Set([...fleet.keys(), ...extra, ...shadow])];

console.log(`equity ${equity.toFixed(0)} · stop-loss cap ${cap}% = ${(equity * cap / 100).toFixed(2)} per trade · stops at ${cfg.paper.fallbackAtrSl}× ATR(14) on ${tf}\n`);
console.log(`${'market'.padEnd(13)} ${'price'.padStart(10)} ${'contract'.padStart(10)} ${'stop'.padStart(8)} ${'risk/contract'.padStart(13)} ${'min equity'.padStart(10)}  status`);
const rows: Array<{ symbol: string; need: number; live: boolean; risk: number }> = [];
for (const symbol of markets.sort()) {
  try {
    const p = await rest.product(symbol);
    const cv = Number(p?.contract_value ?? 0.001);
    const c = await rest.recentCandles(symbol, tf, 200, TF_SECONDS[tf]);
    const bars = c.slice(0, -1).map((x: any) => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    const atr = lastAtr(bars, 14);
    const price = bars.at(-1)!.close;
    if (!atr) { console.log(`${symbol.padEnd(13)} ${'—'.padStart(10)}  no candles`); continue; }
    const stop = atr * cfg.paper.fallbackAtrSl;
    const risk = stop * cv;
    const need = risk / (cap / 100);
    const live = fleet.has(symbol);
    rows.push({ symbol, need, live, risk });
    const ok = risk <= equity * cap / 100;
    console.log(`${symbol.padEnd(13)} ${price.toFixed(4).padStart(10)} ${String(cv).padStart(10)} ${stop.toFixed(4).padStart(8)} ${risk.toFixed(2).padStart(13)} ${need.toFixed(0).padStart(10)}  ${ok ? 'ok' : 'PRICED OUT'}${live ? ' · live fleet' : ''}`);
  } catch (e: any) { console.log(`${symbol.padEnd(13)} error: ${e?.message ?? e}`); }
}
const out = rows.filter(r => r.risk > equity * cap / 100);
console.log(`\n${out.length} of ${rows.length} markets are priced out at ${equity.toFixed(0)} equity${out.length ? `: ${out.map(r => r.symbol).join(', ')}` : ''}`);
if (out.length) {
  const worst = Math.max(...out.map(r => r.need));
  console.log(`the whole set becomes tradeable at about ${Math.ceil(worst / 500) * 500} equity, or by raising maxStopLossPct`);
}
const liveOut = out.filter(r => r.live);
if (liveOut.length) console.log(`\nIN THE LIVE FLEET AND PRICED OUT: ${liveOut.map(r => `${r.symbol} (needs ${r.need.toFixed(0)})`).join(', ')}`);
process.exit(0);
