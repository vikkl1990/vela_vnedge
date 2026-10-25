/**
 * One incubator cycle, and the owner's approve/reject actions. Shared by the daily job and the API.
 */
import type { AppConfig, IncubatorConfig, ScannerConfig } from '../config.ts';
import { IncubatorStore, type PairRow, type Stage } from './store.ts';
import { cohortStats, cohortVerdict, deliveryVerdict, demoteVerdict, gateVerdict, overlapPct, pairStats, screenScore, thinMarketRefusal, type CohortStats } from './gate.ts';

export interface ScreenResult {
  pass: boolean; at: number; trades: number; profitFactor: number; netPnl: number; netAtStress: number;
  windowsUp: number; winRatePct: number; avgR: number; bars: number; days: number;
  /** R per trade in the first and second half of the screen history (decision 55). */
  avgR1?: number; avgR2?: number;
  /** The holdout (decision 88): the last share of the history, judged only after the pass was decided on the rest. */
  holdoutTrades?: number; holdoutAvgR?: number; holdoutPf?: number; holdoutPass?: boolean;
  /** Entry signals per bar over the history (decision 88): a script that fires on more than a tenth of all bars is a state read as entries, not a signal. */
  entryDensity?: number;
  /** Decision 114: the same history under exit mode `script` — the strategy's own exits — beside the fleet's exits above. */
  scriptExit?: { trades: number; avgR: number; avgR1: number; avgR2: number; sumR: number };
  /** Decision 134: set on screens whose entries were filled at the signal bar's close; a strategy screen without it was flattered and must be re-run. */
  fill?: 'close';
  /**
   * Decision 201: what this screen measured — the patched source's hash, the reading contract's, the simulation version
   * and the trading policy's (entry model, exits, gates). A screen without it predates decision 201 and is shown as legacy.
   */
  provenance?: { source: string | null; reading: string; sim: number; policy: string };
}

// ---- decision 114: a strategy cohort judged on its own exits ----
export interface VariantResult { trades: number; avgR: number; positiveHalves: boolean; marketsBetter: number; marketsWorse: number; markets: number }
export interface StrategyComparison { preferred: 'script' | 'both'; reason: string; script: VariantResult; both: VariantResult }

/**
 * Prefer the strategy's own exits only when they beat the fleet's on the cell yardstick used everywhere else:
 * higher R per trade, positive in both halves, and not worse on a majority of the markets screened.
 */
export function preferScript(script: VariantResult, both: VariantResult): StrategyComparison {
  const prefer = script.trades > 0 && script.avgR > both.avgR && script.positiveHalves && script.marketsWorse <= script.marketsBetter;
  const reason = prefer
    ? `own exits ${fmtR(script.avgR)} over ${script.trades} trades (both halves positive, better on ${script.marketsBetter} of ${script.markets} markets) beat the fleet's ${fmtR(both.avgR)}: exit mode script`
    : `own exits ${fmtR(script.avgR)} do not beat the fleet's ${fmtR(both.avgR)} (${script.positiveHalves ? 'both halves positive' : 'a losing half'}, better on ${script.marketsBetter}, worse on ${script.marketsWorse} of ${script.markets} markets): keep exit mode both`;
  return { preferred: prefer ? 'script' : 'both', reason, script, both };
}
const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;

/** The comparison for a cohort from its members' screens; null when no member was screened under both modes. */
export function cohortComparison(screens: Array<ScreenResult | null | undefined>): StrategyComparison | null {
  const pairs = screens.filter((s): s is ScreenResult & { scriptExit: NonNullable<ScreenResult['scriptExit']> } => !!s && !!s.scriptExit && s.trades > 0);
  if (!pairs.length) return null;
  const agg = (pick: (s: typeof pairs[number]) => { trades: number; avgR: number; avgR1: number; avgR2: number }) => {
    const t = pairs.reduce((a, s) => a + pick(s).trades, 0);
    const w = (f: (x: ReturnType<typeof pick>) => number) => (t ? pairs.reduce((a, s) => a + f(pick(s)) * pick(s).trades, 0) / t : 0);
    return { trades: t, avgR: w(x => x.avgR), avgR1: w(x => x.avgR1), avgR2: w(x => x.avgR2) };
  };
  const sc = agg(s => s.scriptExit), bo = agg(s => ({ trades: s.trades, avgR: s.avgR, avgR1: s.avgR1 ?? 0, avgR2: s.avgR2 ?? 0 }));
  const better = pairs.filter(s => s.scriptExit.avgR > s.avgR + 0.02).length, worse = pairs.filter(s => s.scriptExit.avgR < s.avgR - 0.02).length;
  const v = (x: typeof sc, b: number, w: number): VariantResult => ({ trades: x.trades, avgR: x.avgR, positiveHalves: x.avgR1 > 0 && x.avgR2 > 0, marketsBetter: b, marketsWorse: w, markets: pairs.length });
  return preferScript(v(sc, better, worse), v(bo, worse, better));
}

export const MAX_ENTRY_DENSITY = 0.10;

export interface ScreenTrade { entryAt: number; pnl: number; rMultiple?: number }

/**
 * The screen's verdict on one cell (decision 88). The pass thresholds — trades, profit factor, windows up,
 * net at stress, both halves — are judged on the TRAINING part of the history (the first 1 − holdoutShare).
 * The holdout, never consulted for that judgement, must then be positive on its own: that is the only part
 * of the number that was not used to pick the cell.
 */
export function screenVerdict(trades: ScreenTrade[], stressed: ScreenTrade[], bars: Array<{ time: number }>, inc: IncubatorConfig, now = Date.now(), entries?: number): ScreenResult {
  const t0 = bars[0].time, t1 = bars[bars.length - 1].time;
  const share = inc.screen.requireHoldout === false ? 0 : (inc.screen.holdoutShare ?? 0.3);
  const cut = share > 0 ? bars[Math.max(1, Math.floor(bars.length * (1 - share)))].time : t1 + 1;
  const train = trades.filter(t => t.entryAt < cut), hold = trades.filter(t => t.entryAt >= cut);
  const trainStressed = stressed.filter(t => t.entryAt < cut);
  const stats = (ts: ScreenTrade[]) => {
    const gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -ts.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    return { gp, gl, pf: gl > 0 ? gp / gl : gp > 0 ? 99 : 0, avgR: ts.length ? ts.reduce((a, t) => a + (t.rMultiple ?? 0), 0) / ts.length : 0 };
  };
  const tr = stats(train);
  const span = (cut - t0) / 8; const w = new Array(8).fill(0);
  for (const t of train) w[Math.min(7, Math.max(0, Math.floor((t.entryAt - t0) / span)))] += t.pnl;
  const split = bars[Math.floor((bars.length * (1 - share)) / 2)].time;
  const h1 = train.filter(t => t.entryAt < split), h2 = train.filter(t => t.entryAt >= split);
  const r: ScreenResult = {
    pass: false, at: now, trades: train.length, profitFactor: tr.pf, netPnl: tr.gp - tr.gl, netAtStress: trainStressed.reduce((a, t) => a + t.pnl, 0),
    windowsUp: w.filter(x => x > 0).length, winRatePct: train.length ? train.filter(t => t.pnl > 0).length / train.length * 100 : 0,
    avgR: tr.avgR, bars: bars.length, days: (t1 - t0) / 86_400_000,
    avgR1: h1.length ? h1.reduce((a, t) => a + (t.rMultiple ?? 0), 0) / h1.length : 0,
    avgR2: h2.length ? h2.reduce((a, t) => a + (t.rMultiple ?? 0), 0) / h2.length : 0,
  };
  const halvesOk = inc.screen.requireBothHalves === false || (h1.length > 0 && h2.length > 0 && r.avgR1! > 0 && r.avgR2! > 0);
  r.pass = r.trades >= inc.screen.minTrades && r.profitFactor >= inc.screen.minProfitFactor && r.windowsUp >= inc.screen.minWindowsUp && r.netAtStress > 0 && halvesOk;
  if (entries !== undefined && bars.length) { r.entryDensity = entries / bars.length; if (r.entryDensity > MAX_ENTRY_DENSITY) r.pass = false; }
  if (share > 0) {
    const ho = stats(hold);
    r.holdoutTrades = hold.length; r.holdoutAvgR = ho.avgR; r.holdoutPf = ho.pf;
    r.holdoutPass = hold.length >= (inc.screen.minHoldoutTrades ?? 8) && ho.avgR > 0 && ho.pf >= 1;
    if (r.pass && !r.holdoutPass) r.pass = false;
  }
  return r;
}

type PairKey = { scannerId: string; symbol: string; tf: string };

/**
 * Decision 115: on a fast timeframe a market is only worth screening when its bars are big enough for the
 * fallback stop to clear the cost rule — otherwise every signal the cell ever produces is refused as "stop too
 * tight". The market gate reads ATR on 15m; ATR scales roughly with the square root of the bar, so 5m needs
 * √3 times the 15m reading. Returns the 15m ATR% the market needs, or null when nothing is known.
 */
export const TF_ATR_SCALE: Record<string, number> = { '1m': 3.9, '3m': 2.2, '5m': 1.73, '15m': 1, '30m': 0.71, '1h': 0.5, '2h': 0.35, '4h': 0.25 };
export function atrNeededPct(bookCostPct: number | null | undefined, tf: string, paper: { minRiskFeeRatio?: number; fallbackAtrSl: number; feeRatePct: number; feeTaxPct?: number }): number | null {
  const ratio = paper.minRiskFeeRatio ?? 0;
  if (!(ratio > 0) || !(paper.fallbackAtrSl > 0)) return null;
  const cost = bookCostPct ?? paper.feeRatePct * (1 + (paper.feeTaxPct ?? 0) / 100) * 2;
  return cost * ratio / paper.fallbackAtrSl * (TF_ATR_SCALE[tf] ?? 1);
}
export function tooQuietForTf(atrPct: number | null | undefined, bookCostPct: number | null | undefined, tf: string, paper: Parameters<typeof atrNeededPct>[2]): string | null {
  const need = atrNeededPct(bookCostPct, tf, paper);
  if (need === null || atrPct === null || atrPct === undefined) return null;
  return atrPct < need ? `too quiet for ${tf}: 15m ATR ${atrPct.toFixed(2)}% < ${need.toFixed(2)}% needed for a ${paper.fallbackAtrSl}×ATR stop to cover ${paper.minRiskFeeRatio}× the round trip` : null;
}
const DAY = 86400_000;

/** The gate for one timeframe: a 4h pair cannot produce in 45 days what a 15m pair produces in 8. */
export const gateFor = (inc: IncubatorConfig, tf: string) => ({ ...inc.gate, maxDays: inc.gate.maxDaysByTf?.[tf] ?? inc.gate.maxDays, minTrades: inc.gate.minTradesByTf?.[tf] ?? inc.gate.minTrades, minDays: inc.gate.minDaysByTf?.[tf] ?? inc.gate.minDays });
/** How many markets one scanner is admitted on at this timeframe. */
const marketsFor = (inc: IncubatorConfig, tf: string) => inc.admit.cohortMarkets[tf] ?? inc.admit.cohortMarkets.default ?? 5;

/** The live fleet as the config describes it: enabled, not hidden, one row per scanner × market. */
/** The screen's timeframe for a given night (decision 106): the list rotates day by day, so with 7 slices and 3 timeframes every (slice, timeframe) comes round once in 21 nights. */
export function screenTf(inc: AppConfig['incubator'], now = Date.now()): string {
  const tfs = inc.tfs?.length ? inc.tfs : [inc.tf];
  return tfs[Math.floor(now / DAY) % tfs.length];
}

/** Live cells on this market and for this scanner, against the diversity caps (decision 106). */
export function diversityRefusal(cfg: AppConfig, scannerId: string, symbol: string): string | null {
  const inc = cfg.incubator; const live = livePairs(cfg);
  const perMarket = inc.promote.maxPerMarket ?? Infinity, perScanner = inc.promote.maxPerScanner ?? Infinity;
  const onMarket = live.filter(p => p.symbol === symbol).length, forScanner = live.filter(p => p.scannerId === scannerId).length;
  if (onMarket >= perMarket) return `${symbol} already has ${onMarket} live cell${onMarket === 1 ? '' : 's'} (cap ${perMarket}): the fleet spreads across markets`;
  if (forScanner >= perScanner) return `${scannerId} already has ${forScanner} live cells (cap ${perScanner}): the fleet spreads across scanners`;
  return null;
}

export function livePairs(cfg: AppConfig): PairKey[] {
  // decision 79: a scanner is in the fleet only where it was explicitly put — its pairs, or its own symbol
  // list at the incubator timeframe. The global symbol list never puts a scanner anywhere.
  const tf = cfg.incubator.tf;
  return Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden)
    .flatMap(([id, v]) => v.pairs?.length ? v.pairs.map(p => ({ scannerId: id, symbol: p.symbol, tf: p.tf })) : (v.symbols ?? []).map(symbol => ({ scannerId: id, symbol, tf })));
}

/** Make the incubator's `live` rows match the config: the config is the record of what trades. */
export function syncLive(store: IncubatorStore, cfg: AppConfig, now = Date.now()): { added: number; removed: number } {
  const want = new Map(livePairs(cfg).map(p => [`${p.scannerId}|${p.symbol}|${p.tf}`, p]));
  let added = 0, removed = 0;
  for (const p of want.values()) {
    const cur = store.find(p.scannerId, p.symbol, p.tf);
    if (!cur || (cur.stage !== 'live' && cur.stage !== 'demote_proposed')) { store.move(p, 'live', 'config', null, 'in the live fleet', now); added++; }
  }
  for (const r of store.list(['live', 'demote_proposed'])) {
    if (!want.has(`${r.scannerId}|${r.symbol}|${r.tf}`)) { store.move(r, 'retired', 'config', null, 'removed from the live fleet', now); removed++; }
  }
  return { added, removed };
}

/** Record one screen result. Only passing results create candidates; the table stays small. */
export function recordScreen(store: IncubatorStore, p: PairKey, res: ScreenResult, inc: IncubatorConfig, now = Date.now()): 'new' | 'updated' | 'cooldown' | 'skipped' {
  const cur = store.find(p.scannerId, p.symbol, p.tf);
  if (!cur) {
    if (!res.pass) return 'skipped';
    const row = store.move(p, 'candidate', 'screen', res, null, now);
    store.setScreen(row.id, res, now);
    return 'new';
  }
  if (cur.stage === 'retired') {
    if (now - cur.since < inc.cooldownDays * DAY) return 'cooldown';
    if (!res.pass) return 'skipped';
    const row = store.move(p, 'candidate', 'screen', res, 'back after cooldown', now);
    store.setScreen(row.id, res, now);
    return 'new';
  }
  store.setScreen(cur.id, res, now);
  return 'updated';
}

export interface CycleReport { proposed: string[]; retired: string[]; brewing: number; demoteProposed: string[]; admitted: string[]; free: number }
const name = (r: PairKey) => `${r.scannerId} ${r.symbol} ${r.tf}`;

/** Judge every shadow and live pair, then fill free shadow slots with the best recent candidates. */
/** Why the account could not trade this market today, or null when the gate allows it or has not judged it. */
function marketRefusal(markets: Map<string, { allowed: boolean; reasons: string[]; turnoverUsd?: number | null; stale?: boolean }>, symbol: string, minTurnoverUsd?: number): string | null {
  const m = markets.get(symbol);
  // decision 109: a market the gate has verdicts for but none on this symbol is outside its universe — below the turnover floor or unlisted — and is out, not unknown
  if (!m) return markets.size ? `the market gate does not judge ${symbol} today: outside its universe` : null;
  if (m.stale) return `the market gate's verdict on ${symbol} is stale (no refresh for over three hours)`;
  if (!m.allowed) return `the market gate refuses ${symbol} today: ${m.reasons.join('; ') || 'not allowed'}`;
  // decision 177: a fleet slot is not spent on a market where the fills will not exist
  const thin = thinMarketRefusal(minTurnoverUsd, m.turnoverUsd ?? null);
  return thin ? `${symbol} is ${thin}` : null;
}

/** `needsRescreen`: scanners whose screens from before decision 134 cannot be trusted (strategy scripts); their candidates wait for a fresh screen. */
export interface EvaluateOptions {
  needsRescreen?: (scannerId: string) => boolean;
  /** Decision 195: why a scanner cannot run (not in the library, source unavailable, incompatible); null when it can. */
  unavailable?: (scannerId: string) => string | null;
}
/** Decision 200: a failed re-screen retires a shadow pair only once its own record has this many trades and is not positive. */
export const RESCREEN_RETIRE_MIN_TRADES = 3;

export function evaluate(store: IncubatorStore, cfg: AppConfig, now = Date.now(), opts: EvaluateOptions = {}): CycleReport {
  const inc = cfg.incubator;
  const rep: CycleReport = { proposed: [], retired: [], brewing: 0, demoteProposed: [], admitted: [], free: 0 };
  // decision 195: a shadow, proposed or tracked pair whose scanner cannot run never trades; it held its slot while its
  // stage said otherwise. It is retired with the library's reason, and returns through the screen if the script does.
  if (opts.unavailable) {
    for (const r of store.list(['shadow', 'proposed', 'tracked'])) {
      const why0 = opts.unavailable(r.scannerId);
      if (!why0) continue;
      const why = `scanner unavailable: ${why0}`;
      store.move(r, 'retired', 'library', { reasons: [why] }, why, now); rep.retired.push(name(r));
    }
  }
  const active = store.list(['shadow', 'proposed']);
  // decision 104: a pair on a market the account's gate refuses today is never proposed; one already proposed goes back to brewing
  const markets = store.marketsToday(now);
  for (const r of active) {
    const why = marketRefusal(markets, r.symbol, inc.gate.minTurnoverUsd);
    if (why && r.stage === 'proposed') { store.move(r, 'shadow', 'gate', { reasons: [why] }, why, now, { keepSince: true }); rep.brewing++; }
  }

  if (inc.gate.pool === 'cohort') judgeCohorts(store, cfg, active, rep, now);
  else for (const r of active) judgePair(store, cfg, r, rep, now);

  // decision 109: a live cell on a market the gate refuses cannot trade; after `marketOutDays` in a row it gives its slot back
  const out = store.marketOut(); const outDays = inc.demote.marketOutDays ?? 0; const liveKeys = new Set<string>();
  for (const r of store.list(['live'])) {
    const trades = store.trades(r.scannerId, r.symbol, r.tf, 0).filter(t => t.entryAt >= r.since);
    const d = demoteVerdict(trades, inc.demote);
    // decision 106: a live cell that has not traded for `silentDays` holds a fleet slot and does nothing
    // decision 179: the cap follows the timeframe, as the shadow stale cap does (decision 108)
    const silentDays = inc.demote.silentDaysByTf?.[r.tf] ?? inc.demote.silentDays ?? 0;
    const lastAt = Math.max(r.since, ...trades.map(t => t.entryAt));
    const silent = silentDays > 0 && now - lastAt > silentDays * DAY;
    const key = `${r.scannerId}|${r.symbol}|${r.tf}`; liveKeys.add(key);
    const why = markets.size ? marketRefusal(markets, r.symbol, inc.gate.minTurnoverUsd) : null;
    if (why) out[key] ??= now; else delete out[key];
    const outFor = why ? (now - out[key]) / DAY : 0;
    const marketOut = outDays > 0 && why !== null && outFor >= outDays;
    // decision 112: a cell whose stops cannot cover the cost rule on its market will never trade; it gives its slot back
    // decision 171: judged on the pair's own live period, and only once that period is a full window long. Counting
    // the 14 days before promotion read the shadow mirror's refusals (decision 116) and demoted a pair within hours.
    const csN = inc.demote.costStarvedRefusals ?? 0, csDays = inc.demote.costStarvedDays ?? 14;
    const liveLongEnough = now - r.since >= csDays * DAY;
    const funnel = csN > 0 && liveLongEnough ? store.signalFunnel(r.scannerId, r.symbol, r.tf, Math.max(r.since, now - csDays * DAY)) : null;
    const costStarved = funnel !== null && funnel.cost >= csN && funnel.opened === 0;
    const reason = marketOut ? `market out: ${why} — ${Math.round(outFor)} days in a row (cap ${outDays})`
      : costStarved ? `cost-starved: ${funnel!.cost} of ${funnel!.entries} signals refused by the cost rule and none opened in ${csDays} days`
      : silent ? `silent: no account trade in ${Math.round((now - lastAt) / DAY)} days (cap ${silentDays})` : d.reason;
    const demote = d.demote || silent || marketOut || costStarved;
    store.setGate(r.id, { at: now, stats: d.stats, reasons: [reason], decision: demote ? 'demote' : 'keep', marketOutDays: why ? outFor : 0 }, now);
    if (demote) { store.move(r, 'demote_proposed', 'gate', { stats: d.stats, reason }, reason, now, { keepSince: true }); rep.demoteProposed.push(name(r)); }
  }
  for (const k of Object.keys(out)) if (!liveKeys.has(k)) delete out[k];
  store.setMarketOut(out);
  // decision 106: a shadow pair with no shadow trade for `gate.staleDays` proves nothing and gives its slot back
  // decision 108: the cap follows the timeframe — 21 days is three weeks of 15m bars and five 4h trades at best
  for (const r of store.list(['shadow'])) {
    const staleDays = inc.gate.staleDaysByTf?.[r.tf] ?? inc.gate.staleDays ?? 0;
    if (!(staleDays > 0)) continue;
    const t = store.trades(r.scannerId, r.symbol, r.tf, 2).filter(x => x.entryAt >= r.since);
    // decision 184: a pair back from the account is given the stale cap from its demotion, not from an admission it has
    // been live since (the shadow runner does not trade a live cell, so its last shadow trade predates the whole stint)
    const lastAt = Math.max(r.since, store.lastDemotion(r.id)?.at ?? 0, ...t.map(x => x.entryAt));
    if (now - lastAt > staleDays * DAY) { const why = `stale: no shadow trade in ${Math.round((now - lastAt) / DAY)} days (cap ${staleDays})`; store.move(r, 'retired', 'gate', { reasons: [why] }, why, now); rep.retired.push(name(r)); }
  }

  // decision 186: a shadow pair re-screened after its admission whose screen no longer passes was admitted on evidence
  // that did not hold; it gives its slot back. Decision 200: only when its own forward record agrees — at least
  // RESCREEN_RETIRE_MIN_TRADES shadow trades since admission and a total of zero R or less. A re-test of pairs chosen for
  // looking best fails most of them by selection alone (519 of 617 on 25 October); 35 of those failures were up 83.8R in
  // the shadow book. A failing pair with too little record yet keeps collecting it; the stale cap retires the silent ones.
  for (const r of store.list(['shadow'])) {
    const sc = r.screen as any;
    if (!sc || sc.pass !== false || !(typeof sc.at === 'number' && sc.at > r.since)) continue;
    const fwd = store.trades(r.scannerId, r.symbol, r.tf, 2).filter(t => t.entryAt >= r.since);
    const fwdR = fwd.reduce((a, t) => a + t.r, 0);
    if (fwd.length < RESCREEN_RETIRE_MIN_TRADES || fwdR > 0) continue;
    const why = `screen no longer passes (re-screened ${new Date(sc.at).toISOString().slice(0, 10)}: ${sc.reason ?? `PF ${Number(sc.profitFactor ?? 0).toFixed(2)}, ${sc.trades ?? 0} trades`}) and the shadow record agrees (${fwd.length} trades, ${fwdR >= 0 ? '+' : ''}${fwdR.toFixed(2)}R)`;
    store.move(r, 'retired', 'screen', { screen: sc, reasons: [why] }, why, now); rep.retired.push(name(r));
  }

  admit(store, cfg, rep, now, opts);
  return rep;
}

/**
 * Decision 171: a demoted pair is proposed again only on evidence gathered since the demotion that answers the reason it
 * was demoted for. The shadow record alone cannot see that reason: a pair demoted as cost-starved or silent was
 * re-proposed and re-promoted at the next hunt, thirteen times in two days for one pair.
 *  - cost-starved or silent: the account must have opened one of the pair's mirrored signals since (decision 116), or,
 *    for cost-starved, the cost rule must now pass at least half of a window's worth of them;
 *  - a record below the floor, or the operator's own demotion: the shadow record since the demotion must pass the gate
 *    by itself;
 *  - market out: nothing beyond the market gate, which already holds a proposal while the market is refused.
 */
function demotionAnswered(store: IncubatorStore, cfg: AppConfig, r: PairRow, now: number): string | null {
  const d = store.lastDemotion(r.id);
  if (!d) return null;
  const inc = cfg.incubator; const reason = d.reason ?? '';
  if (reason.startsWith('market out')) return null;
  if ((reason.startsWith('cost-starved') || reason.startsWith('silent')) && inc.mirror?.enabled) {
    const f = store.signalFunnel(r.scannerId, r.symbol, r.tf, d.at);
    if (f.opened > 0) return null;
    const csN = inc.demote.costStarvedRefusals ?? 5;
    if (reason.startsWith('cost-starved') && f.entries >= csN && f.cost * 2 <= f.entries) return null;
    return `${reason.split(':')[0]} when demoted; since then ${f.entries} signal(s), ${f.cost} refused by the cost rule, none opened`;
  }
  const stats = pairStats(store.trades(r.scannerId, r.symbol, r.tf, 2), d.at, now);
  const v = gateVerdict(stats, gateFor(inc, r.tf), 0);
  return v.decision === 'propose' ? null : `demoted on its live record; since then ${stats.trades} shadow trade(s) in ${Math.round(stats.days)} day(s): ${v.reasons[0] ?? 'not yet a passing record'}`;
}

/**
 * Decision 184: a pair back from the account keeps its evidence window (decision 132) but not the time it spent live
 * against it: the `maxDays` horizon moves out by the live stint, so the pair is not retired as "not proven" the hunt
 * after its demotion. `minDays` is untouched — an answered demotion (decision 171) returns as soon as it is answered.
 */
function returningGate(store: IncubatorStore, g: ReturnType<typeof gateFor>, rows: PairRow[]): ReturnType<typeof gateFor> {
  let extra = 0;
  for (const r of rows) { const d = store.lastDemotion(r.id); if (d && d.at > r.since) extra = Math.max(extra, (d.at - r.since) / DAY); }
  return extra > 0 ? { ...g, maxDays: g.maxDays + extra } : g;
}

/** One market judged on its own: the original gate, kept for `gate.pool: 'pair'`. */
function judgePair(store: IncubatorStore, cfg: AppConfig, r: PairRow, rep: CycleReport, now: number): void {
  const trades = store.trades(r.scannerId, r.symbol, r.tf, 2);
  const stats = pairStats(trades, r.since, now);
  const dv = deliveryVerdict(r.screen, stats);
  if (dv.retire && r.stage === 'shadow') { store.move(r, 'retired', 'gate', { stats, reasons: [dv.reason] }, dv.reason!, now); rep.retired.push(name(r)); return; }
  const overlap = overlapPct(trades.filter(t => t.entryAt >= r.since), store.liveTradesOn(r.symbol, r.scannerId));
  const v = gateVerdict(stats, returningGate(store, gateFor(cfg.incubator, r.tf), [r]), overlap);
  store.setGate(r.id, { at: now, stats, overlapPct: overlap, ...v }, now);
  if (v.decision === 'propose' && r.stage === 'shadow' && marketRefusal(store.marketsToday(now), r.symbol, cfg.incubator.gate.minTurnoverUsd)) { store.setGate(r.id, { at: now, stats, overlapPct: overlap, ...v, decision: 'brewing', reasons: [marketRefusal(store.marketsToday(now), r.symbol, cfg.incubator.gate.minTurnoverUsd)!] }, now); rep.brewing++; }
  else if (v.decision === 'propose' && r.stage === 'shadow' && demotionAnswered(store, cfg, r, now)) { store.setGate(r.id, { at: now, stats, overlapPct: overlap, ...v, decision: 'brewing', reasons: [demotionAnswered(store, cfg, r, now)!] }, now); rep.brewing++; }
  else if (v.decision === 'propose' && r.stage === 'shadow') { store.move(r, 'proposed', 'gate', { stats, overlap, reasons: v.reasons }, 'passed the promotion gate', now, { keepSince: true }); rep.proposed.push(name(r)); }
  else if (v.decision === 'brewing' && r.stage === 'proposed') { store.move(r, 'shadow', 'gate', { stats, reasons: v.reasons }, 'no longer passes the gate', now, { keepSince: true }); rep.brewing++; }
  else if (v.decision === 'retire') { store.move(r, 'retired', 'gate', { stats, reasons: v.reasons }, v.reasons[0], now); rep.retired.push(name(r)); }
  else if (v.decision === 'brewing') rep.brewing++;
}

/**
 * One scanner on one timeframe judged across all of its shadow markets at once.
 *
 * The cohort passes or fails together, because what is being judged is the scanner. Only the best of
 * its markets are proposed for the fleet — at most `promote.maxPerWeek`, since nothing more than that
 * can be approved in a week anyway — and the rest keep trading in the shadow book as evidence.
 */
function judgeCohorts(store: IncubatorStore, cfg: AppConfig, active: PairRow[], rep: CycleReport, now: number): void {
  const inc = cfg.incubator;
  const groups = new Map<string, PairRow[]>();
  for (const r of active) { const k = `${r.scannerId}|${r.tf}`; const g = groups.get(k); g ? g.push(r) : groups.set(k, [r]); }

  for (const rowsAll of groups.values()) {
    // promise versus delivery per market first (decision 90): a member retired by its own record leaves the cohort
    const rows = rowsAll.filter(r => {
      if (r.stage !== 'shadow') return true;
      const dv = deliveryVerdict(r.screen, pairStats(store.trades(r.scannerId, r.symbol, r.tf, 2), r.since, now));
      if (!dv.retire) return true;
      store.move(r, 'retired', 'gate', { reasons: [dv.reason] }, dv.reason!, now); rep.retired.push(name(r)); return false;
    });
    if (!rows.length) continue;
    const members = rows.map(r => ({ row: r, symbol: r.symbol, since: r.since, trades: store.trades(r.scannerId, r.symbol, r.tf, 2) }));
    const stats = cohortStats(members, now, inc.gate.minMarketTrades);
    let hit = 0, n = 0;
    for (const m of members) {
      const t = m.trades.filter(x => x.entryAt >= m.since);
      n += t.length; hit += overlapPct(t, store.liveTradesOn(m.symbol, m.row.scannerId)) / 100 * t.length;
    }
    const overlap = n ? hit / n * 100 : 0;
    const v = cohortVerdict(stats, returningGate(store, gateFor(inc, rows[0].tf), rows), overlap);
    const cohort = `${rows[0].scannerId} ${rows[0].tf} across ${rows.length} market${rows.length === 1 ? '' : 's'}`;
    // decision 114: a strategy cohort carries the verdict on its own exits, advisory, beside the gate's
    const strategyComparison = cohortComparison(rows.map(r => r.screen));
    for (const m of members) store.setGate(m.row.id, { at: now, cohort, stats, overlapPct: overlap, market: stats.perMarket.find(p => p.symbol === m.symbol) ?? null, ...v, ...(strategyComparison ? { strategyComparison } : {}) }, now);

    if (v.decision === 'retire') {
      for (const m of members) { store.move(m.row, 'retired', 'gate', { cohort, stats, reasons: v.reasons }, `${cohort}: ${v.reasons[0]}`, now); rep.retired.push(name(m.row)); }
      continue;
    }
    // only markets the account can trade today are picked for the fleet (decision 104); the rest keep brewing as evidence
    const markets = store.marketsToday(now);
    const pick = v.decision === 'propose'
      ? new Set(stats.perMarket.filter(p => p.trades >= inc.gate.minMarketTrades && p.avgR > 0 && !marketRefusal(markets, p.symbol, inc.gate.minTurnoverUsd) && !diversityRefusal(cfg, rows[0].scannerId, p.symbol)).slice(0, inc.promote.maxPerWeek).map(p => p.symbol))
      : new Set<string>();
    for (const m of members) {
      const wanted = pick.has(m.symbol);
      const cooling = v.decision === 'propose' && wanted ? demotionAnswered(store, cfg, m.row, now) : null;
      if (cooling) { pick.delete(m.symbol); store.setGate(m.row.id, { at: now, cohort, stats, overlapPct: overlap, ...v, decision: 'brewing', reasons: [cooling] }, now); rep.brewing++; continue; }
      const why = v.decision === 'propose' && !wanted ? marketRefusal(markets, m.symbol) : null;
      if (why) store.setGate(m.row.id, { at: now, cohort, stats, overlapPct: overlap, ...v, decision: 'brewing', reasons: [why] }, now);
      if (wanted && m.row.stage === 'shadow') { store.move(m.row, 'proposed', 'gate', { cohort, stats, reasons: v.reasons }, `${cohort} passed the gate`, now, { keepSince: true }); rep.proposed.push(name(m.row)); }
      else if (!wanted && m.row.stage === 'proposed') { store.move(m.row, 'shadow', 'gate', { cohort, stats, reasons: v.reasons }, 'no longer proposed', now, { keepSince: true }); rep.brewing++; }
      else if (!wanted) rep.brewing++;
    }
  }
}

/**
 * Fill the free shadow slots. Under cohort gating a scanner is admitted on several markets at once,
 * because one market alone cannot produce a judgeable sample inside `gate.maxDays`; cohorts already
 * running are topped up first, and a new cohort is only started when enough of its markets passed
 * the screen to fill `admit.minCohortMarkets` slots.
 */
function admit(store: IncubatorStore, cfg: AppConfig, rep: CycleReport, now: number, opts: EvaluateOptions = {}): void {
  const inc = cfg.incubator;
  const active = store.list(['shadow', 'proposed']);
  const markets = store.marketsToday(now);
  // a candidate on a market the gate refuses today would hold a shadow slot the account can never use (decision 104)
  const maxAge = (inc.admit.candidateMaxAgeDays ?? 30) * DAY;
  let fresh = store.list(['candidate']).filter(r => r.screen?.pass && now - (r.screen?.at ?? 0) <= maxAge && !marketRefusal(markets, r.symbol, inc.gate.minTurnoverUsd)
    && !(opts.needsRescreen?.(r.scannerId) && r.screen?.fill !== 'close'));
  const admitted = new Set<number>();
  const take = (r: PairRow) => { store.move(r, 'shadow', 'screen', { screen: r.screen, score: screenScore(r.screen) }, 'admitted to the shadow book', now); rep.admitted.push(name(r)); admitted.add(r.id); slots--; };

  // decision 182: the reservations first — capacity over and above `maxShadow` for what the score starves (4h, the
  // majors), each filled from its own matching candidates by score, under the same per-scanner caps
  const held = new Map<string, number>();
  for (const r of active) { const k = `${r.scannerId}|${r.tf}`; held.set(k, (held.get(k) ?? 0) + 1); }
  const capFor = (tf: string) => inc.admit.maxPerScannerTf?.[tf] ?? marketsFor(inc, tf);
  const reserves = (inc.admit.reserve ?? []).filter(res => res.slots > 0).map(res => ({ res, matches: (r: PairRow) => (!res.tfs?.length || res.tfs.includes(r.tf)) && (!res.markets?.length || res.markets.includes(r.symbol)), n: 0 }));
  // an active pair counts against the first reservation it matches, while that reservation has room; the rest are the book's
  const counted = new Set<number>();
  for (const r of active) for (const x of reserves) if (!counted.has(r.id) && x.matches(r) && x.n < x.res.slots) { counted.add(r.id); x.n++; break; }
  let slots = Math.max(0, inc.maxShadow - (active.length - counted.size));
  for (const x of reserves) {
    for (const r of fresh.filter(c => !admitted.has(c.id) && x.matches(c)).sort((a, b) => screenScore(b.screen) - screenScore(a.screen))) {
      if (x.n >= x.res.slots) break;
      const k = `${r.scannerId}|${r.tf}`;
      if ((held.get(k) ?? 0) >= capFor(r.tf)) continue;
      take(r); slots++;   // `take` spends a book slot; a reserved admission gives it back
      held.set(k, (held.get(k) ?? 0) + 1); x.n++;
    }
  }
  fresh = fresh.filter(r => !admitted.has(r.id));

  if (inc.gate.pool !== 'cohort') {
    // decision 132: each pair is admitted on its own score, but one scanner may not fill the book at a timeframe
    for (const r of fresh.sort((a, b) => screenScore(b.screen) - screenScore(a.screen))) {
      if (slots <= 0) break;
      const k = `${r.scannerId}|${r.tf}`;
      if ((held.get(k) ?? 0) >= capFor(r.tf)) continue;
      take(r); held.set(k, (held.get(k) ?? 0) + 1);
    }
    rep.free = slots;
    return;
  }

  const byCohort = new Map<string, PairRow[]>();
  for (const r of fresh) { const k = `${r.scannerId}|${r.tf}`; const g = byCohort.get(k); g ? g.push(r) : byCohort.set(k, [r]); }

  const cohorts = [...byCohort.entries()].map(([k, rows]) => ({
    k, rows: rows.sort((a, b) => screenScore(b.screen) - screenScore(a.screen)),
    score: Math.max(...rows.map(r => screenScore(r.screen))), running: held.get(k) ?? 0,
  }));
  // top up what is already brewing before starting anything new: those markets are already earning days
  const fillable = (c: { rows: PairRow[] }) => Number(c.rows.length >= inc.admit.minCohortMarkets);
  cohorts.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || fillable(b) - fillable(a) || b.score - a.score);

  for (const c of cohorts) {
    if (slots <= 0) break;
    const room = Math.min(marketsFor(inc, c.rows[0].tf) - c.running, c.rows.length, slots);
    if (room <= 0) continue;
    if (!c.running && room < Math.min(inc.admit.minCohortMarkets, c.rows.length)) continue;
    for (const r of c.rows.slice(0, room)) take(r);
  }
  rep.free = slots;
}

/**
 * Decision 157: admission on its own, outside the nightly hunt. Judging, promotion and demotion keep their daily pace;
 * this only fills free shadow slots with candidates whose blocker has cleared (the market gate allows the market again,
 * a re-screen landed, a slot was freed). Returns the pairs admitted.
 */
export function admitOnly(store: IncubatorStore, cfg: AppConfig, now = Date.now(), opts: EvaluateOptions = {}): string[] {
  if (!cfg.incubator?.enabled) return [];
  const rep: CycleReport = { proposed: [], retired: [], brewing: 0, demoteProposed: [], admitted: [], free: 0 };
  admit(store, cfg, rep, now, opts);
  return rep.admitted;
}

export type CandidateBlocker = 'expired' | 'stale' | 'outside' | 'refused' | 'rescreen' | 'capped' | 'noSlot' | 'cohort' | 'admissible';
/**
 * Decision 157: why each candidate that passed its screen is not in the shadow book, by the rules `admit` applies and in
 * its order: a screen expired by an engine change, a screen past its age, the market gate (outside its universe, or
 * refusing the market today), a strategy screened before decision 134, then room — its scanner's cap on that timeframe
 * or the book's. What is left would be admitted by the next admission.
 */
export function candidateBlockers(store: IncubatorStore, cfg: AppConfig, now = Date.now(), opts: EvaluateOptions = {}): { passed: number; free: number; counts: Record<CandidateBlocker, number> } {
  const inc = cfg.incubator;
  const counts: Record<CandidateBlocker, number> = { expired: 0, stale: 0, outside: 0, refused: 0, rescreen: 0, capped: 0, noSlot: 0, cohort: 0, admissible: 0 };
  const active = store.list(['shadow', 'proposed']);
  // decision 186: the reservations as `admit` counts them — an active pair fills the first reservation it matches while
  // that has room, and only the rest consume the book's own slots
  const reserves = (inc.admit.reserve ?? []).filter(res => res.slots > 0).map(res => ({ matches: (r: PairRow) => (!res.tfs?.length || res.tfs.includes(r.tf)) && (!res.markets?.length || res.markets.includes(r.symbol)), room: res.slots }));
  let inReserve = 0;
  for (const r of active) for (const x of reserves) if (x.matches(r) && x.room > 0) { x.room--; inReserve++; break; }
  let slots = Math.max(0, inc.maxShadow - (active.length - inReserve));
  const free = slots + reserves.reduce((a, x) => a + x.room, 0);
  const markets = store.marketsToday(now);
  const maxAge = (inc.admit.candidateMaxAgeDays ?? 30) * DAY;
  const passed = store.list(['candidate']).filter(r => r.screen?.pass);
  const fresh: PairRow[] = [];
  for (const r of passed) {
    const why = marketRefusal(markets, r.symbol, inc.gate.minTurnoverUsd);
    if (r.screen?.expiredAt) counts.expired++;
    else if (now - (r.screen?.at ?? 0) > maxAge) counts.stale++;
    else if (why) (markets.get(r.symbol) ? counts.refused++ : counts.outside++);
    else if (opts.needsRescreen?.(r.scannerId) && r.screen?.fill !== 'close') counts.rescreen++;
    else fresh.push(r);
  }
  if (inc.gate.pool === 'cohort') { counts.cohort = fresh.length; return { passed: passed.length, free, counts }; }
  const held = new Map<string, number>();
  for (const r of active) { const k = `${r.scannerId}|${r.tf}`; held.set(k, (held.get(k) ?? 0) + 1); }
  for (const r of fresh.sort((a, b) => screenScore(b.screen) - screenScore(a.screen))) {
    const k = `${r.scannerId}|${r.tf}`; const cap = inc.admit.maxPerScannerTf?.[r.tf] ?? marketsFor(inc, r.tf);
    if ((held.get(k) ?? 0) >= cap) { counts.capped++; continue; }
    const res = reserves.find(x => x.matches(r) && x.room > 0);
    if (res) { res.room--; counts.admissible++; held.set(k, (held.get(k) ?? 0) + 1); continue; }
    if (slots <= 0) { counts.noSlot++; continue; }
    counts.admissible++; slots--; held.set(k, (held.get(k) ?? 0) + 1);
  }
  return { passed: passed.length, free, counts };
}

export class IncubatorError extends Error { status = 409; }

/** Take one (market, timeframe) off a scanner: from its explicit pairs when it has them, else from its symbol list; the scanner is switched off when it was the last. */
function removePair(sc: ScannerConfig | undefined, r: { scannerId: string; symbol: string; tf: string }, setScanner: (id: string, patch: Partial<ScannerConfig>) => void) {
  if (sc?.pairs?.length) {
    const rest = sc.pairs.filter(p => !(p.symbol === r.symbol && p.tf === r.tf));
    setScanner(r.scannerId, rest.length ? { pairs: rest } : { enabled: false });
    return;
  }
  // a legacy scanner listed by symbols: take the market off its own list (never the global one)
  const rest = (sc?.symbols ?? []).filter(s => s !== r.symbol);
  setScanner(r.scannerId, rest.length ? { symbols: rest } : { enabled: false });
}

/**
 * Approve a proposal. Promotion puts the market into the scanner's live symbol list; approving a
 * demotion takes it out and sends the pair back to prove itself in the shadow book.
 */
export function approve(store: IncubatorStore, cfg: AppConfig, id: number, actor: string, setScanner: (id: string, patch: Partial<ScannerConfig>) => void, now = Date.now()): PairRow {
  const r = store.get(id);
  if (!r) throw Object.assign(new IncubatorError('unknown incubator pair'), { status: 404 });
  const inc = cfg.incubator;
  const sc = cfg.scanners[r.scannerId];
  if (r.stage === 'proposed') {
    const week = store.promotionsSince(now - 7 * DAY);
    if (week >= inc.promote.maxPerWeek) throw new IncubatorError(`weekly promotion limit reached (${week}/${inc.promote.maxPerWeek}); try again later or raise incubator.promote.maxPerWeek`);
    const fleet = livePairs(cfg).length;
    if (fleet >= inc.promote.maxFleet) throw new IncubatorError(`the live fleet is full (${fleet}/${inc.promote.maxFleet} pairs); demote one first or raise incubator.promote.maxFleet`);
    const crowded = diversityRefusal(cfg, r.scannerId, r.symbol);
    if (crowded) throw new IncubatorError(crowded);
    const stats = pairStats(store.trades(r.scannerId, r.symbol, r.tf, 2), r.since, now);
    setScanner(r.scannerId, { enabled: true, hidden: false, pairs: [...(sc?.pairs ?? []).filter(p => !(p.symbol === r.symbol && p.tf === r.tf)), { symbol: r.symbol, tf: r.tf }] });
    return store.move(r, 'live', actor, { shadow: stats, gate: r.gate }, 'promoted from the shadow book', now);
  }
  if (r.stage === 'demote_proposed') {
    removePair(sc, r, setScanner);
    return store.move(r, 'shadow', actor, { live: r.gate?.stats ?? null, reason: r.gate?.reason ?? 'demoted' }, 'demoted: back to the shadow book', now, { since: store.admittedAt(r.id) ?? undefined });
  }
  throw new IncubatorError(`nothing to approve: the pair is ${r.stage}`);
}

/**
 * The operator's own demotion: a live pair goes back to the shadow book without waiting for the gate
 * to propose it. The market leaves the scanner's live list (the scanner is disabled when it was its
 * last), open positions keep running their exits, and the pair keeps being measured in shadow.
 */
export function demote(store: IncubatorStore, cfg: AppConfig, id: number, actor: string, setScanner: (id: string, patch: Partial<ScannerConfig>) => void, note: string | null = null, now = Date.now()): PairRow {
  const r = store.get(id);
  if (!r) throw Object.assign(new IncubatorError('unknown incubator pair'), { status: 404 });
  if (r.stage !== 'live' && r.stage !== 'demote_proposed') throw new IncubatorError(`nothing to demote: the pair is ${r.stage}`);
  const sc = cfg.scanners[r.scannerId];
  removePair(sc, r, setScanner);
  // decision 132: a cell that comes back from the account keeps the shadow evidence it earned before promotion
  // decision 132: a cell that comes back from the account keeps the shadow evidence it earned before promotion; the
  // demotion's own reason rides in the event (decision 184), so it is never read off an older, rejected proposal
  return store.move(r, 'shadow', actor, { live: r.gate?.stats ?? null, reason: note ?? 'demoted by the operator' }, note ?? 'demoted by the operator: back to the shadow book', now, { since: store.admittedAt(r.id) ?? undefined });
}

/** Reject a proposal: a promotion is retired (cooldown applies); a demotion is dismissed and the pair stays live. */
/**
 * The hunter's last step: every pair the gate proposed is promoted without a click, in gate order,
 * until the weekly or fleet limit says stop. Everything the gate did not propose stays where it is.
 */
export function autoPromote(store: IncubatorStore, cfg: AppConfig, setScanner: (id: string, patch: Partial<ScannerConfig>) => void, now = Date.now()): { promoted: string[]; blocked: string[] } {
  const promoted: string[] = [], blocked: string[] = [];
  for (const r of store.list(['proposed'])) {
    try { approve(store, cfg, r.id, 'auto', setScanner, now); promoted.push(name(r)); }
    catch (e: any) { blocked.push(`${name(r)}: ${e?.message ?? e}`); }
  }
  return { promoted, blocked };
}

export function reject(store: IncubatorStore, id: number, actor: string, note: string | null = null, now = Date.now()): PairRow {
  const r = store.get(id);
  if (!r) throw Object.assign(new IncubatorError('unknown incubator pair'), { status: 404 });
  if (r.stage === 'proposed') return store.move(r, 'retired', actor, { gate: r.gate }, note ?? 'promotion rejected', now);
  if (r.stage === 'demote_proposed') return store.move(r, 'live', actor, { gate: r.gate }, note ?? 'kept live', now, { keepSince: true });
  throw new IncubatorError(`nothing to reject: the pair is ${r.stage}`);
}

export const ACTIVE_STAGES: Stage[] = ['shadow', 'proposed'];
