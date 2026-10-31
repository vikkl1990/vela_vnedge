/** Production-contract behavior probes. SAVE=0 writes only OUT/JSON_OUT, never the bot database.
 * IDS=ids.txt MARKETS=BTCUSD,ETHUSD,SOLUSD TFS=15m,1h BARS=800 CONCURRENCY=2 SAVE=0 npm run profile
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool, processWorker } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { Db } from '../db.ts';
import { ProfileStore, brokenRun, observeHistoricalRun, profileSignature, type ProfileRow } from '../scanners/profile.ts';
const cfg = new ConfigStore(process.env.PROFILE_CONFIG).get();
if (!process.env.IDS) throw new Error('IDS file is required');
const ids = [...new Set(fs.readFileSync(process.env.IDS, 'utf8').split(/\s+/).filter(Boolean))];
const markets = (process.env.MARKETS ?? process.env.MARKET ?? 'ETHUSD').split(',');
const tfs = (process.env.TFS ?? '15m,1h,4h').split(',');
for (const tf of tfs) if (!TF_SECONDS[tf]) throw new Error(`Invalid timeframe ${tf}`);
const defaults: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
const registry = new ScannerRegistry(), rest = new DeltaRest();
for (const id of ids) if (!registry.get(id)) throw new Error(`Unknown scanner ${id}`);
const series = new Map<string, { bars: Bar[]; tickSize: number }>();
for (const market of markets) {
  const product = await rest.product(market);
  for (const tf of tfs) {
    const candles = await rest.recentCandles(market, tf, Number(process.env.BARS) || defaults[tf] || 3000, TF_SECONDS[tf]);
    const bars = candles.slice(0, -1).map(c => ({time:c.time*1000,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume}));
    if (!bars.length) throw new Error(`No closed candles for ${market} ${tf}`);
    series.set(`${market}|${tf}`, {bars,tickSize:Number(product?.tick_size ?? .5)});
  }
}
const concurrency = Math.max(1, Math.min(4, Number(process.env.CONCURRENCY) || 2));
const pool = new PinePool(concurrency, 120_000, processWorker), rows: ProfileRow[] = [];
const db = process.env.SAVE === '0' ? null : new Db(), store = db ? new ProfileStore(db) : null;
const tasks = ids.flatMap(id => markets.flatMap(market => tfs.map(tf => ({id,market,tf}))));
try {
  await Promise.all(Array.from({length:concurrency}, async () => {
    for (;;) {
      const t = tasks.shift(); if (!t) return;
      const s = registry.get(t.id)!, sc = cfg.scanners[t.id], {bars,tickSize} = series.get(`${t.market}|${t.tf}`)!;
      const at = Date.now(); let row: ProfileRow;
      if (s.status !== 'ok') row = {scannerId:s.id,market:t.market,tf:t.tf,at,...brokenRun(s.reason ?? s.status),signature:profileSignature(s,sc,t.tf),bars:bars.length,windowStart:bars[0].time,windowEnd:bars.at(-1)!.time,origin:'profile'};
      else {
        const res = await pool.run({scannerId:s.id,source:s.patched,symbol:t.market,tf:t.tf,tickSize,bars,tailBars:'all',plotTail:bars.length,inputs:sc?.inputs,timezone:sc?.timezone});
        row = observeHistoricalRun(s,sc,t.market,t.tf,bars,res,'profile',at).profile;
      }
      rows.push(row); store?.save(row);
      console.log(`${rows.length}: ${s.id} ${t.market} ${t.tf} ${row.kind} · ${row.entries} entries · ${row.ms} ms${row.error ? ` · ${row.error}` : ''}`);
      if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows, null, 2));
    }
  }));
} finally { await pool.stop(); db?.db.close(); }
rows.sort((a,b)=>a.scannerId.localeCompare(b.scannerId)||a.market.localeCompare(b.market)||tfs.indexOf(a.tf)-tfs.indexOf(b.tf));
const fields = ['scannerId','market','tf','kind','bars','ms','entries','withSl','withTp','exits','info','alertconds','shapes','labels','plots','signature','error'] as const;
fs.writeFileSync(process.env.OUT ?? '/tmp/profile.tsv', fields.join('\t')+'\n'+rows.map(r=>fields.map(k=>String(r[k] ?? '').replace(/[\t\n]/g,' ')).join('\t')).join('\n')+'\n');
if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT,JSON.stringify(rows,null,2));
