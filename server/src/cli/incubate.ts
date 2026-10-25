/**
 * The incubator's daily job: screen one slice of the script library on every liquid market, then
 * judge the shadow book and the live fleet.
 *
 *   npm run incubate                 # today's slice (the library is covered once per `slices` days)
 *   SLICE=3 npm run incubate         # a given slice
 *   SLICE=none npm run incubate      # judge only, no screen
 *   WORKERS=4 LIMIT=20 …             # worker threads; LIMIT caps scripts (for a quick trial)
 *   IDS=ids.txt npm run incubate     # only these scripts, every slice (a fresh import judged tonight)
 *
 * Runs as its own process (a systemd timer on the VM) so screening never competes with the live
 * bot for its worker pool; it shares only the database, which the bot re-reads every few minutes.
 *
 * The screen is deliberately only a filter. Across ~1600 scripts and ~40 markets it makes tens of
 * thousands of comparisons, and hundreds will pass by luck; what it passes merely earns a slot in
 * the shadow book, where the evidence that decides promotion is collected (decision 17).
 */
import fs from 'node:fs';
import { Db } from '../db.ts';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { PinePool, memoryLimitBytes, memoryUsedBytes, processWorker } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ScriptHealth, permanentReason } from '../scanners/health.ts';
import { contractRiskShare } from '../paper/logic.ts';
import { lastAtr } from '../data/indicators.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import { IncubatorStore } from '../incubator/store.ts';
import { tooQuietForTf, evaluate, recordScreen, screenTf, screenVerdict, syncLive, type ScreenResult } from '../incubator/cycle.ts';
import { compareRepaint, repaintReason, REPAINT_CUT } from '../scanners/repaint.ts';
import { sliceOf } from '../incubator/gate.ts';
import { backtestPolicy, entryPolicy } from '../paper/policy.ts';
import { aliasMap, duplicateGroups } from '../scanners/identity.ts';
import { readingOf } from '../scanners/reading.ts';
import { createHash } from 'node:crypto';
import { sourceHash } from '../paper/fingerprint.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { crossingPct } from '../risk/marketGate.ts';
/** Decision 201: the hashes a screen result carries, so a later reader can tell what strategy it measured. */
function screenProvenance(patched: string, read: { extract: Record<string, unknown>; rule: Record<string, unknown> }, policy: Record<string, unknown>) {
  const h = (v: unknown) => createHash('sha1').update(JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x].sort() : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))).digest('hex').slice(0, 12);
  return { source: sourceHash(patched), reading: h(read), sim: SIMULATION_VERSION, policy: h(policy) };
}

const started = Date.now();
const cfg = new ConfigStore().get();
const inc = cfg.incubator;
const db = new Db();
const store = new IncubatorStore(db);
const health = new ScriptHealth(db);
const rest = new DeltaRest();
// Decision 107: the screen walks the library continuously. A cursor over (timeframe, slice, script) is
// kept in the database; every night starts where the last one stopped and goes as far as the time and
// memory budgets allow, so a fast night covers two slices and a slow one half of one, and nothing is
// screened twice before everything is screened once. SLICE=, TF= or IDS= make a hand run that leaves
// the cursor alone.
const TFS = inc.tfs?.length ? inc.tfs : [inc.tf];
const SLICES = inc.screen.slices;
const handRun = Boolean(process.env.SLICE || process.env.TF || process.env.IDS || process.env.MARKETS);
// decision 198: see the screen loop — re-screen the shadow book's own cells; DRY=1 records nothing and skips the judge
const shadowOnly = process.env.RESCREEN_SHADOW === '1';
const dry = process.env.DRY === '1';
const verdicts: Array<{ scannerId: string; symbol: string; tf: string; pass: boolean; reason: string; pf: number; trades: number; avgR: number }> = [];
if (/\blive\b/.test(process.env.RESCREEN_STAGES ?? '') && !dry) { console.error('RESCREEN_STAGES=live only runs with DRY=1: a live pair keeps its original screen'); process.exit(2); }
/** `retry`: the quarantined scripts released for one more screen at the head of this slice (decision 108), kept in the cursor so a resumed slice sees the same list. */
type Cursor = { tfIdx: number; slice: number; scriptIdx: number; retry?: string[] };
let cursor: Cursor = handRun
  ? { tfIdx: Math.max(0, TFS.indexOf(process.env.TF || TFS[0])), slice: Number(process.env.SLICE ?? 0) || 0, scriptIdx: 0 }
  : (db.kvGet<Cursor>('incubator.screenCursor') ?? { tfIdx: TFS.indexOf(screenTf(inc)) >= 0 ? TFS.indexOf(screenTf(inc)) : 0, slice: Math.floor(Date.now() / 86400_000) % SLICES, scriptIdx: 0 });
const advance = (c: Cursor): Cursor => (c.slice + 1 < SLICES ? { tfIdx: c.tfIdx, slice: c.slice + 1, scriptIdx: 0 } : { tfIdx: (c.tfIdx + 1) % TFS.length, slice: 0, scriptIdx: 0 });
const saveCursor = (c: Cursor) => { if (!handRun) db.kvSet('incubator.screenCursor', c); };
let TF = TFS[cursor.tfIdx % TFS.length], tfMs = TF_SECONDS[TF] * 1000;
const DAY = 86400_000;
const out = (m: string) => console.log(`[incubate ${new Date().toISOString().slice(0, 19)}] ${m}`);

const synced = syncLive(store, cfg);
out(`live fleet synced: +${synced.added} −${synced.removed}`);

// ADD=file.json: record screen results produced elsewhere (e.g. `npm run survey` on another machine),
// [{ scannerId, symbol, tf, result: ScreenResult }], before judging
if (process.env.ADD) {
  let added = 0;
  for (const x of JSON.parse(fs.readFileSync(process.env.ADD, 'utf8'))) {
    const k = recordScreen(store, { scannerId: x.scannerId, symbol: x.symbol, tf: x.tf }, { ...x.result, at: Date.now() }, inc);
    if (k === 'new' || k === 'updated') added++;
  }
  out(`recorded ${added} screen results from ${process.env.ADD}`);
}
const sliceArg = process.env.SLICE ?? 'walk';
const summary: any = { at: started, slice: sliceArg, tf: TF, walked: [] as string[], done: 0, scripts: 0, symbols: 0, runs: 0, silentSkipped: 0, failed: 0, passed: 0, new: 0, updated: 0, cooldown: 0, quarantined: 0, skippedSick: 0, tooCoarse: 0 };
// The job announces itself before it screens: a start with no matching finish is how the dashboard
// tells a killed run from one that never ran (2026-10-11: three nights died unnoticed).
// decision 176: a hand run (IDS=, TF=, SLICE=, MARKETS=) keeps its own marker; the nightly's `lastStart` is what the
// attention line and the screen queue read, and a hand run writing it once made the nightly look dead for a day
db.kvSet(handRun ? 'incubator.lastHandStart' : 'incubator.lastStart', { at: started, slice: sliceArg, pid: process.pid });
// The screen stops launching scripts once this much of the run is spent so the judge always runs
// before the unit's 6 h limit; what is left waits for the slice's next turn.
const BUDGET_MS = (Number(process.env.BUDGET_MIN) || 270) * 60_000;
// The unit's memory cap kills the whole job without a word (2026-10-11: 8.4 GB resident after four
// hours). At 80% of it the screen stops and the judge runs on what it has.
const MEM_STOP = Math.round(memoryLimitBytes() * 0.8);
/** A single run that grows the process by this much names a hog (see the run loop). */
const HOG_BYTES = (Number(process.env.HOG_MB) || 1536) * 1048576;

while (sliceArg !== 'none') {
  const slice = cursor.slice; TF = TFS[cursor.tfIdx % TFS.length]; tfMs = TF_SECONDS[TF] * 1000;
  summary.walked.push(`${TF} slice ${slice}${cursor.scriptIdx ? ` from ${cursor.scriptIdx}` : ''}`);
  // ---- universe: every market the gate allows today (decision 56b: a book cheap enough to cross,
  //      not dead, not too quiet), most liquid first; the turnover top-N only when the gate has no verdicts ----
  const tickers = await rest.tickers();
  const turnover = new Map(tickers.map((t: any) => [String(t.symbol), Number(t.turnover_usd ?? 0)]));
  const today = db.kvGet<{ enabled: boolean; markets: Array<{ symbol: string; allowed: boolean; bookCostPct?: number | null; atrPct?: number | null }> }>('risk.marketsToday');
  // decision 109: the screen pays each market's measured round-trip book cost, as the account does (decision 96's honest
  // base), so a cell whose stop the live cost rule would refuse is not admitted on a backtest that never paid the book
  const bookCost = new Map((today?.markets ?? []).filter(m => typeof m.bookCostPct === 'number' && m.bookCostPct! > 0).map(m => [m.symbol, m.bookCostPct as number]));
  // decision 202: what the backtest is charged on top of its own fees — the book crossing only
  const crossing = new Map([...bookCost].map(([s, c]) => [s, crossingPct(c, cfg.paper)]));
  const allowed = today?.enabled ? today.markets.filter(m => m.allowed && /USD$/.test(m.symbol)).map(m => m.symbol) : [];
  // MARKETS=BTCUSD,ETHUSD: a hand run on just these markets (a 4h screen of the whole universe pulls a million 1m bars per market)
  const onlyMarkets = process.env.MARKETS ? new Set(process.env.MARKETS.split(',').map(x => x.trim()).filter(Boolean)) : null;
  const universe = (allowed.length
    ? allowed
    : tickers.filter((t: any) => t.contract_type === 'perpetual_futures' && /USD$/.test(t.symbol) && Number(t.turnover_usd ?? 0) >= inc.minTurnoverUsd).map((t: any) => String(t.symbol)))
    .filter(sym => !onlyMarkets || onlyMarkets.has(sym))
    .sort((a, b) => (turnover.get(b) ?? 0) - (turnover.get(a) ?? 0))
    .slice(0, inc.universeTop);
  // decision 115: on a fast timeframe a quiet market is not screened — its cells could never clear the cost rule
  const quietTfs = new Set(inc.screen.quietFilterTfs ?? ['5m', '15m']);
  const verdictOf = new Map((today?.markets ?? []).map(m => [m.symbol, m]));
  const quiet = quietTfs.has(TF) && !onlyMarkets ? universe.filter(sym => { const v = verdictOf.get(sym); return v ? tooQuietForTf(v.atrPct, v.bookCostPct, TF, cfg.paper, { maker: !!entryPolicy(cfg, TF, 'shadow') }) !== null : false; }) : [];
  for (const sym of quiet) universe.splice(universe.indexOf(sym), 1);
  summary.quiet = quiet.length;
  if (quiet.length) out(`${TF}: ${quiet.length} markets too quiet for this timeframe's cost floor, not screened: ${quiet.slice(0, 12).join(', ')}${quiet.length > 12 ? ', …' : ''}`);
  summary.symbols = universe.length;
  out(allowed.length ? `universe: ${universe.length} of the ${allowed.length} markets the gate allows today (cap ${inc.universeTop})` : `universe: ${universe.length} perpetuals over $${(inc.minTurnoverUsd / 1e6).toFixed(1)}M 24h turnover (no gate verdicts yet)`);

  const registry = new ScannerRegistry();
  // IDS=file: screen just these scripts, whatever slice they fall in (a fresh import, judged on every market tonight)
  const only = process.env.IDS ? new Set(fs.readFileSync(process.env.IDS, 'utf8').split(/\s+/).filter(Boolean)) : null;
  let scripts = registry.all().filter(s => s.status === 'ok' && (only ? only.has(s.id) : sliceOf(s.id, inc.screen.slices) === slice));
  // decision 194: a byte-identical copy of another script, read the same way, is the same strategy under another id —
  // screen it once, under its canonical id (an explicit IDS list still screens what it names)
  if (!only) {
    const withPairs = new Set(store.list().map(p => p.scannerId));
    const aliases = aliasMap(duplicateGroups(registry.all(), cfg, id => withPairs.has(id)));
    const copies = scripts.filter(s => aliases.has(s.id));
    if (copies.length) {
      scripts = scripts.filter(s => !aliases.has(s.id));
      out(`${copies.length} script(s) skipped as copies: ${copies.slice(0, 8).map(s => `${s.id} = ${aliases.get(s.id)}`).join(', ')}${copies.length > 8 ? ', …' : ''}`);
    }
  }
  if (Number(process.env.LIMIT) > 0) scripts = scripts.slice(0, Number(process.env.LIMIT));
  // decision 108: a slice starts with one more screen for scripts quarantined by a runtime verdict a week or more ago
  // (a timeout, a hang, a runtime gap, memory) — the process workers and the budgets changed under them. A script that
  // fails again is marked and never retried; one that works clears its record like any healthy script.
  const retryN = handRun ? 0 : inc.screen.retryPerNight ?? 20;
  if (retryN > 0 && cursor.scriptIdx === 0 && !cursor.retry) {
    const due = health.dueForRetry(7 * DAY).slice(0, retryN).map(r => r.scannerId).filter(id => registry.get(id)?.status === 'ok');
    for (const id of due) health.releaseOne(id);
    cursor = { ...cursor, retry: due }; saveCursor(cursor);
  }
  const retrying = new Set(cursor.retry ?? []);
  if (retrying.size) {
    const head = [...retrying].map(id => registry.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    scripts = [...head, ...scripts.filter(x => !retrying.has(x.id))];
    summary.retried = head.length;
    out(`retrying ${head.length} quarantined scripts first: ${head.map(x => x.id).join(', ')}`);
  }
  summary.scripts = scripts.length;
  out(only ? `IDS: ${scripts.length} of ${only.size} listed scripts × ${universe.length} markets` : `slice ${slice}/${inc.screen.slices}: ${scripts.length} scripts × ${universe.length} markets`);

  // ---- candles, fetched once per market ----
  const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
  const data = new Map<string, { bars: Bar[]; m1: Bar[]; market: ReturnType<typeof marketSpec> }>();
  for (const symbol of universe) {
    try {
      const p = await rest.product(symbol);
      const bars = toBars(await rest.recentCandles(symbol, TF, inc.screen.bars, TF_SECONDS[TF]));
      if (bars.length < 500) { out(`  ${symbol}: only ${bars.length} bars, skipped`); continue; }
      // decision 186: one request returns at most 80,000 one-minute bars (55.6 days); a 1h window is 167 days and a 4h
      // window 667, and the bars before the 1m history were resolved on the signal bar itself — optimistic for a trail
      // that ratchets at a bar's close. The older part of the window is resolved on 15m bars instead.
      let m1 = toBars(await rest.recentCandles(symbol, '1m', Math.ceil((bars.length + 2) * tfMs / 60_000), 60));
      if (tfMs > 900_000 && bars.length && (!m1.length || m1[0].time > bars[0].time)) {
        const m15 = toBars(await rest.recentCandles(symbol, '15m', Math.ceil((bars.length + 2) * tfMs / 900_000), 900));
        const cut = m1.length ? m1[0].time : Infinity;
        m1 = [...m15.filter(b => b.time + 900_000 <= cut), ...m1];
      }
      data.set(symbol, { bars, m1, market: marketSpec(p) });
    } catch (e: any) { out(`  ${symbol}: no candles (${e?.message ?? e})`); }
  }
  out(`candles loaded for ${data.size} markets; book cost known for ${[...data.keys()].filter(s => bookCost.has(s)).length} of them`);

  // markets this account cannot size a position in, measured from contract size and volatility
  const equity = new PaperEngine(db, () => cfg).equity();
  const coarse = new Set<string>();
  for (const [symbol, d] of data) {
    const atr = lastAtr(d.bars, 14);
    if (!atr) continue;
    const share = contractRiskShare(atr * cfg.paper.fallbackAtrSl, d.market.contractValue, equity, cfg.paper);
    if (share > (inc.maxContractRiskShare ?? 0.5)) { coarse.add(symbol); out(`  ${symbol}: one contract is ${(share * 100).toFixed(0)}% of the risk budget — too coarse to size, skipped`); }
  }

  // ---- screen ----
  // workers as processes (decision 98): a recycled one gives its memory back, a runaway one dies at once
  const pool = new PinePool(Number(process.env.WORKERS) || 4, 120_000, processWorker);
  // decision 198: RESCREEN_SHADOW=1 re-screens the pairs already in the shadow book (and proposed) on their own markets,
  // nothing else — the ordinary screen skips them, so a re-screen under a corrected policy never reached them and the
  // decision-186 rule (a re-screen that no longer passes retires the pair) had nothing to act on. DRY=1 records nothing
  // and skips the judge: it prints each pair's verdict so the retirements can be read before they happen.
  // decision 201: RESCREEN_STAGES=live (with RESCREEN_SHADOW=1 and DRY=1) revalidates the live pairs under today's policy
  const rescreenStages = new Set((process.env.RESCREEN_STAGES ?? 'shadow,proposed').split(',').map(x => x.trim()));
  const skipStages = new Set(shadowOnly ? ['live', 'demote_proposed', 'tracked', 'candidate', 'retired', 'shadow', 'proposed'].filter(x => !rescreenStages.has(x)) : ['live', 'demote_proposed', 'shadow', 'proposed', 'tracked']);
  const markets = [...data.keys()];
  let stopped = false;
  for (const [idx, s] of scripts.entries()) {
    if (idx < cursor.scriptIdx) continue;   // already screened on an earlier night
    if (idx % 10 === 0) saveCursor({ ...cursor, scriptIdx: idx });
    if (Date.now() - started > BUDGET_MS) { stopped = true; saveCursor({ ...cursor, scriptIdx: idx }); summary.truncated = scripts.length - idx; out(`time budget spent after ${idx} of ${scripts.length} scripts: ${summary.truncated} wait for this slice's next turn`); break; }
    const mu = process.memoryUsage(); const rss = memoryUsedBytes();
    const MB = (n: number) => Math.round(n / 1048576);
    // MEMLOG=1 prints the breakdown every script (where the memory goes: V8 heap, native buffers, or the worker threads outside both)
    if (idx % 25 === 0 || process.env.MEMLOG) out(`  ${idx}/${scripts.length} scripts · ${MB(rss)} MB resident · heap ${MB(mu.heapUsed)}/${MB(mu.heapTotal)} · external ${MB(mu.external)} · arrayBuffers ${MB(mu.arrayBuffers)} · runs ${summary.runs} · pool recycled ${pool.stats?.recycled ?? '?'}`);
    if (rss > MEM_STOP) {
      stopped = true; saveCursor({ ...cursor, scriptIdx: idx }); summary.truncated = scripts.length - idx; summary.memoryStop = rss;
      out(`memory at ${Math.round(rss / 1048576)} MB, ${Math.round(MEM_STOP / 1048576)} MB is the line: ${summary.truncated} scripts wait for this slice's next turn`);
      // The script that was running when the line was crossed is the likely cause (Wyckoff Range Engine
      // needs more than 6 GB for one market at 4,000 bars). Quarantined with that reason so the slice
      // gets past it tomorrow; the Release button lifts a wrong guess.
      const culprit = scripts[idx - 1];
      if (culprit && !cfg.scanners[culprit.id]?.enabled) { health.quarantine(culprit.id, `memory: the screen crossed its line (${Math.round(rss / 1048576)} MB) while running it`); summary.quarantined++; out(`  ${culprit.id}: quarantined — ${Math.round(rss / 1048576)} MB resident after it ran`); }
      break;
    }
    if (health.isQuarantined(s.id)) { summary.skippedSick++; continue; }
    let probed = 0, sawEntry = false;
    for (const symbol of markets) {
      // a script that produced no entry on its first three markets is not going to on the rest
      if (!shadowOnly && probed >= 3 && !sawEntry) { summary.silentSkipped += markets.length - probed; break; }
      const cur = store.find(s.id, symbol, TF);
      if (cur && skipStages.has(cur.stage)) continue;
      if (shadowOnly && !cur) continue;   // only the book's own cells
      if (cur?.stage === 'retired' && Date.now() - cur.since < inc.cooldownDays * DAY) { summary.cooldown++; continue; }
      probed++; // counts markets actually run, not ones skipped above
      const d = data.get(symbol)!;
      summary.runs++;
      try {
        const inputs = cfg.scanners[s.id]?.inputs;
        const rssBefore = memoryUsedBytes();
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf: TF, tickSize: d.market.tickSize, bars: d.bars, tailBars: 'all', plotTail: d.bars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined });
        // One run that takes more than a gigabyte and a half is a memory hog (Wyckoff Range Engine needs 6 GB for
        // one market): quarantine it at once, drop the workers that hold its memory, and go on with the slice.
        // Waiting for the memory line (decision 93) cost a whole night per hog.
        const took = memoryUsedBytes() - rssBefore;
        if (took > HOG_BYTES) {
          summary.quarantined++; summary.hogs = (summary.hogs ?? 0) + 1;
          if (!cfg.scanners[s.id]?.enabled) health.quarantine(s.id, `memory: one run on ${symbol} took ${Math.round(took / 1048576)} MB`);
          out(`  ${s.id}: ${cfg.scanners[s.id]?.enabled ? 'skipped for the screen' : 'quarantined'} — one run on ${symbol} took ${Math.round(took / 1048576)} MB`);
          pool.recycleAll();
          break;
        }
        if (!res.ok) {
          summary.failed++;
          if (/^memory:/.test(res.error ?? '')) {
            // the pool's watchdog retired the worker mid-run (decision 98): the script is the verdict, the slice goes on
            if (cfg.scanners[s.id]?.enabled) { summary.slowLive = (summary.slowLive ?? 0) + 1; out(`  ${s.id}: ${res.error} — skipped for the screen, it trades in the account`); }
            else { summary.quarantined++; summary.hogs = (summary.hogs ?? 0) + 1; health.quarantine(s.id, res.error!); out(`  ${s.id}: quarantined — ${res.error}`); }
            pool.recycleAll();
            break;
          }
          if (/timeout after \d+ms/i.test(res.error ?? '')) {
            // One timeout over the full history is the screen's verdict: trying two more markets only
            // costs two more workers, and three strikes per slow script stretched a slice past its 6 h
            // limit for three nights running. A script that trades in the account is judged by its live
            // runs (fewer bars, its own timeout), never by the screen.
            if (cfg.scanners[s.id]?.enabled) { summary.slowLive = (summary.slowLive ?? 0) + 1; out(`  ${s.id}: too slow for the screen, left alone — it trades in the account`); }
            else { summary.quarantined++; health.quarantine(s.id, `timed out in the daily screen (${pool.timeoutMs / 1000} s over ${d.bars.length} bars)`); out(`  ${s.id}: quarantined — timed out in the screen`); }
            break;
          }
          if (health.record(s.id, res.error)) { summary.quarantined++; out(`  ${s.id}: quarantined (${health.row(s.id)?.reason ?? permanentReason(res.error) ?? res.error})`); break; }
          continue;
        }
        health.clear(s.id);
        const READ = readingOf(cfg.scanners[s.id], s.id, (TF_SECONDS[TF] ?? 0) * 1000, s.patched, s.variantOf);   // decision 195
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars: d.bars, mode: 'backtest', ...READ.rule });
        // decision 110: the screen reads a script the way the shadow book and the account would (its sources, edge, labels, inversion)
        const rd = cfg.scanners[s.id] ?? {};
        const events = extractEvents(res.alerts, res.shapes, { barMs: (TF_SECONDS[TF] ?? 0) * 1000, drawn: res.labels, scannerId: s.id, derived, ...READ.extract });
        if (!events.some(e => e.kind === 'entry')) continue;
        sawEntry = true;
        // decision 191: the screen trades the scanner the way the shadow book it admits to will — the entry model (a maker
        // limit on 1h/4h), the scanner's exit rules with the script-exit protection, its trend gate and the regime's chop gate
        const policy = backtestPolicy(cfg, s.id, TF, 'shadow');
        const base = { scannerId: s.id, scannerName: s.name, symbol, tf: TF, bars: d.bars, events, ...policy, contractValue: d.market.contractValue, tickSize: d.market.tickSize, maintenanceMarginPct: d.market.maintenanceMarginPct, maxLeverage: d.market.maxLeverage, subBars: d.m1, spreadPct: crossing.get(symbol) } as const;
        const bt = runBacktest(base);
        const stressed = runBacktest({ ...base, cfg: { ...policy.cfg, slippageBps: inc.screen.stressBps, quotedSlippageBps: inc.screen.stressBps } });
        const r = screenVerdict(bt.trades as any[], stressed.trades as any[], d.bars, inc, Date.now(), events.filter(e => e.kind === 'entry').length);
        // decision 114: a strategy is also screened on its own exits, so the gate can say which exit mode its evidence prefers
        if (s.scriptType === 'strategy') {
          const asScript = backtestPolicy({ ...cfg, scanners: { ...cfg.scanners, [s.id]: { ...(cfg.scanners[s.id] ?? { enabled: false, symbols: null, timeframes: null }), exitMode: 'script' } as any } }, s.id, TF, 'shadow');
          const sc = runBacktest({ ...base, ...asScript });
          const rs = screenVerdict(sc.trades as any[], sc.trades as any[], d.bars, inc, Date.now());
          r.scriptExit = { trades: rs.trades, avgR: rs.avgR, avgR1: rs.avgR1 ?? 0, avgR2: rs.avgR2 ?? 0, sumR: rs.avgR * rs.trades };
        }
        if ((r.entryDensity ?? 0) > 0.10) out(`  ${s.id} ${symbol}: fires on ${((r.entryDensity ?? 0) * 100).toFixed(0)}% of bars — a state read as entries, not screened`);
        // a market whose one contract eats the risk budget cannot be sized: the stop cap, not the
        // strategy, decides whether each signal becomes a trade (decision 31)
        if (r.pass && coarse.has(symbol)) { r.pass = false; summary.tooCoarse++; }
        // decision 87: a screen pass is only as good as the script's honesty — run it again with the last bars hidden
        if (r.pass && REPAINT_CUT > 0 && d.bars.length > REPAINT_CUT + 200) {
          const cutBars = d.bars.slice(0, d.bars.length - REPAINT_CUT);
          const r2 = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf: TF, tickSize: d.market.tickSize, bars: cutBars, tailBars: 'all', plotTail: cutBars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined, timezone: cfg.scanners[s.id]?.timezone });
          if (r2.ok) {
            const rc = compareRepaint(res, d.bars, r2, cutBars, s.id, cfg.scanners[s.id] ?? {});
            if (rc.repaints) { r.pass = false; summary.repaint = (summary.repaint ?? 0) + 1; health.quarantine(s.id, repaintReason(rc)); out(`  ${s.id}: quarantined — ${repaintReason(rc)}`); if (!dry) recordScreen(store, { scannerId: s.id, symbol, tf: TF }, r, inc); else verdicts.push({ scannerId: s.id, symbol, tf: TF, pass: false, reason: repaintReason(rc), pf: r.profitFactor, trades: r.trades, avgR: r.avgR }); break; }
          }
        }
        if (r.pass) summary.passed++;
        r.fill = 'close';   // decision 134: entries filled at the signal bar's close
        r.provenance = screenProvenance(s.patched, READ, policy);
        if (shadowOnly) verdicts.push({ scannerId: s.id, symbol, tf: TF, pass: r.pass, reason: `PF ${r.profitFactor.toFixed(2)}, ${r.trades} trades, ${r.avgR.toFixed(2)}R, ${r.windowsUp}/8 windows up, at stress ${r.netAtStress.toFixed(0)}${r.holdoutPass === false ? ', holdout failed' : ''}${coarse.has(symbol) ? ', too coarse to size' : ''}`, pf: r.profitFactor, trades: r.trades, avgR: r.avgR });
        if (dry) continue;
        const k = recordScreen(store, { scannerId: s.id, symbol, tf: TF }, r, inc);
        if (k === 'new' || k === 'updated' || k === 'cooldown') summary[k]++;
      } catch (e: any) { summary.failed++; }
    }
    if (retrying.has(s.id)) {
      if (health.isQuarantined(s.id)) { health.markRetried(s.id); summary.retryFailed = (summary.retryFailed ?? 0) + 1; out(`  ${s.id}: failed its retry — ${health.row(s.id)?.reason ?? 'quarantined'}`); }
      else { summary.retryOk = (summary.retryOk ?? 0) + 1; out(`  ${s.id}: back in the library after its retry`); }
    }
    if (++summary.done % 25 === 0 || summary.done === scripts.length) out(`  ${summary.done}/${scripts.length} scripts · ${summary.runs} runs · ${summary.passed} passed`);
  }
  await pool.stop();
  if (stopped || handRun) break;
  // this slice is done: the cursor moves on, and so does the night while there is budget for another pass
  cursor = advance(cursor); saveCursor(cursor);
  if (Date.now() - started > BUDGET_MS - 25 * 60_000) { out(`budget nearly spent: the next pass (${TFS[cursor.tfIdx]} slice ${cursor.slice}) waits for tomorrow`); break; }
  out(`slice done with budget left: continuing with ${TFS[cursor.tfIdx]} slice ${cursor.slice}`);
}

if (shadowOnly) {
  const fail = verdicts.filter(v => !v.pass);
  out(`re-screen of the shadow book: ${verdicts.length} pairs, ${verdicts.length - fail.length} pass, ${fail.length} fail${dry ? ' (dry run: nothing recorded)' : ''}`);
  for (const v of fail) out(`  fails: ${v.scannerId} ${v.symbol} ${v.tf} — ${v.reason || `PF ${v.pf.toFixed(2)}, ${v.trades} trades, ${v.avgR.toFixed(2)}R`}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(verdicts, null, 1));
}
if (dry) { out('dry run: no screen recorded, no judge'); process.exit(0); }
// ---- judge ----
const judgeRegistry = new ScannerRegistry();
const report = evaluate(store, cfg, Date.now(), {
  needsRescreen: id => judgeRegistry.get(id)?.scriptType === 'strategy',
  // decision 195: pairs on scripts that cannot run give their slot back
  unavailable: id => { const s = judgeRegistry.get(id); return !s ? 'not in the library' : s.status !== 'ok' ? `${s.status}${s.reason ? ` (${s.reason})` : ''}` : null; },
});
summary.report = report;
summary.ms = Date.now() - started;
// decision 184: the nightly's finish marker is the nightly's; a hand run (decision 176) keeps its own, so the died check,
// the queue's "is the nightly running" and the bot's hunt trigger read only the nightly
db.kvSet(handRun ? 'incubator.lastHandRun' : 'incubator.lastRun', { ...(summary), finishedAt: Date.now() });
out(`screen: ${summary.runs} runs, ${summary.passed} passed (${summary.new} new candidates), ${summary.silentSkipped} skipped as silent, ${summary.failed} failed${summary.truncated ? `, ${summary.truncated} scripts not reached (time budget)` : ''}`);
out(`judge: ${report.admitted.length} admitted to shadow, ${report.proposed.length} proposed, ${report.retired.length} retired, ${report.demoteProposed.length} proposed for demotion, ${report.brewing} brewing, ${report.free} free slots`);
for (const p of report.proposed) out(`  PROPOSED ${p}`);
for (const p of report.demoteProposed) out(`  DEMOTION PROPOSED ${p}`);
out(`done in ${(summary.ms / 60000).toFixed(1)} min`);
// a wedged worker thread must not keep the job alive past its last line
process.exit(0);
