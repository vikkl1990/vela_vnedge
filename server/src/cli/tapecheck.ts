/**
 * Is the tape dense enough for `fillSource: tape` to mean anything?
 *
 *   MINUTES=5 MARKETS=BTCUSD,SOLUSD npm run tapecheck
 *
 * Tape mode fills from actual prints and falls back to 1m candles whenever the tape has been silent
 * for `tapeFallbackMs`. On a market that prints every few seconds that is a real improvement in
 * timing; on one that prints twice a minute it is the candle path wearing a different name. This
 * counts prints per market — rate, the gaps between them, and the share of seconds with no print at
 * all — so the question is answered before anything is rebuilt around it.
 */
import { DeltaFeed, type WsTrade } from '../delta/ws.ts';
import { ConfigStore } from '../config.ts';

const cfg = new ConfigStore().get();
const fleet = [...new Set(Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden)
  .flatMap(([, v]) => v.symbols ?? cfg.symbols))];
const MARKETS = (process.env.MARKETS ?? fleet.join(',')).split(',').filter(Boolean);
const MINUTES = Number(process.env.MINUTES ?? 5);
const fallbackMs = cfg.paper.tapeFallbackMs ?? 5000;

const seen = new Map<string, { n: number; qty: number; last: number; gaps: number[]; first: number }>();
const feed = new DeltaFeed();
feed.on('trade', (t: WsTrade) => {
  const s = seen.get(t.symbol) ?? { n: 0, qty: 0, last: 0, gaps: [], first: Date.now() };
  if (s.last) s.gaps.push(Date.now() - s.last);
  s.n++; s.qty += t.qty; s.last = Date.now();
  seen.set(t.symbol, s);
});
feed.start();
feed.subscribe('all_trades', MARKETS);
console.error(`listening to ${MARKETS.length} markets for ${MINUTES} minute(s)…`);

const started = Date.now();
await new Promise(r => setTimeout(r, MINUTES * 60_000));
const elapsedMin = (Date.now() - started) / 60_000;

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] : 0);
console.log(`\n${'market'.padEnd(13)} ${'prints/min'.padStart(10)} ${'median gap'.padStart(11)} ${'p90 gap'.padStart(8)} ${'longest'.padStart(8)}   verdict`);
const rows = MARKETS.map(m => {
  const s = seen.get(m);
  const rate = s ? s.n / elapsedMin : 0;
  const med = s ? pct(s.gaps, 0.5) : 0, p90 = s ? pct(s.gaps, 0.9) : 0, max = s ? Math.max(0, ...s.gaps) : 0;
  return { m, rate, med, p90, max };
});
for (const r of rows.sort((a, b) => b.rate - a.rate)) {
  // a gap longer than the fallback window is a stretch where tape mode is the candle path anyway
  const verdict = r.rate === 0 ? 'silent — candles only'
    : r.p90 > fallbackMs ? `thin — 10% of gaps exceed the ${fallbackMs / 1000}s fallback`
      : r.med < 2000 ? 'dense — tape would drive fills' : 'usable';
  console.log(`${r.m.padEnd(13)} ${r.rate.toFixed(1).padStart(10)} ${(r.med ? (r.med / 1000).toFixed(1) + 's' : '—').padStart(11)} ${(r.p90 ? (r.p90 / 1000).toFixed(1) + 's' : '—').padStart(8)} ${(r.max ? (r.max / 1000).toFixed(0) + 's' : '—').padStart(8)}   ${verdict}`);
}
const dense = rows.filter(r => r.rate > 0 && r.p90 <= fallbackMs).length;
console.log(`\n${dense} of ${rows.length} markets print densely enough for tape fills; the rest fall back to 1m candles`);
process.exit(0);
