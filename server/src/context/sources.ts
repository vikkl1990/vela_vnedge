/**
 * Flow intelligence from public data (decision 101): what Nansen sells, assembled from the sources
 * it reads. Three of them, none needing a key:
 *   - Delta itself: open interest, its six-hour change and funding per market (the ticker).
 *   - Hyperliquid's public API: per-coin open interest, funding and premium, a leaderboard of every
 *     trader by PnL, and any wallet's open positions. The smart-money cohort is ours to define.
 *   - Binance futures public data: the top traders' long/short ratio, the crowd's, taker buy/sell.
 * The pure parts (cohort selection, aggregation, bias, session) are here and tested; the fetchers
 * are thin and fail soft: a missing source leaves its fields null, never invents them.
 */
import type { DeltaTicker, DeltaCandle } from '../delta/rest.ts';

const UA = 'Mozilla/5.0 (compatible; VNEdge context)';
const HL = 'https://api.hyperliquid.xyz/info';
const HL_BOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const BN = 'https://fapi.binance.com/futures/data';

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<any> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: ac.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Delta's coin for a market symbol: STRKUSD → STRK. */
export const coinOf = (symbol: string) => symbol.replace(/USDT?$/, '');

// ---- Delta ----
export interface DeltaFlow { oiUsd: number | null; oiChange6hUsd: number | null; fundingPct: number | null; change24hPct: number | null; turnoverUsd: number | null }
export function deltaFlow(t: DeltaTicker | undefined): DeltaFlow {
  const n = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { oiUsd: n(t?.oi_value_usd), oiChange6hUsd: n(t?.oi_change_usd_6h), fundingPct: n(t?.funding_rate), change24hPct: n(t?.mark_change_24h), turnoverUsd: n(t?.turnover_usd) };
}

// ---- Hyperliquid ----
export interface HlCoinCtx { oi: number | null; oiUsd: number | null; fundingHourly: number | null; premium: number | null; markPx: number | null; dayVolumeUsd: number | null }
export async function hyperliquidContexts(): Promise<Map<string, HlCoinCtx>> {
  const [meta, ctxs] = await getJson(HL, { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
  const out = new Map<string, HlCoinCtx>();
  const n = (v: unknown) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  (meta?.universe ?? []).forEach((u: any, i: number) => {
    const c = ctxs?.[i] ?? {};
    const oi = n(c.openInterest), px = n(c.markPx);
    out.set(String(u.name), { oi, oiUsd: oi !== null && px !== null ? oi * px : null, fundingHourly: n(c.funding), premium: n(c.premium), markPx: px, dayVolumeUsd: n(c.dayNtlVlm) });
  });
  return out;
}

export interface BoardRow { address: string; accountValue: number; dayPnl: number; weekPnl: number; monthPnl: number; monthRoi: number; monthVolume: number }
export function parseBoard(raw: any): BoardRow[] {
  const rows: any[] = raw?.leaderboardRows ?? (Array.isArray(raw) ? raw : []);
  const out: BoardRow[] = [];
  for (const r of rows) {
    const w = Object.fromEntries(((r.windowPerformances ?? []) as any[]).map((x: any) => (Array.isArray(x) ? [x[0], x[1]] : [x.window, x])));
    const f = (o: any, k: string) => Number(o?.[k] ?? 0);
    out.push({ address: String(r.ethAddress ?? ''), accountValue: Number(r.accountValue ?? 0), dayPnl: f(w.day, 'pnl'), weekPnl: f(w.week, 'pnl'), monthPnl: f(w.month, 'pnl'), monthRoi: f(w.month, 'roi'), monthVolume: f(w.month, 'vlm') });
  }
  return out;
}
export interface CohortRule { size: number; minAccountUsd: number; minMonthVolumeUsd: number }
export const COHORT: CohortRule = { size: 300, minAccountUsd: 100_000, minMonthVolumeUsd: 5_000_000 };
/**
 * Our smart-money cohort: wallets that are profitable this month *and* this week (one lucky day
 * does not qualify), with a real account and real turnover, ranked by the month's PnL. The rule
 * is deliberately simple and public; a label nobody can audit is not an edge.
 */
export function selectCohort(rows: BoardRow[], rule: CohortRule = COHORT): BoardRow[] {
  return rows
    .filter(r => r.address && r.accountValue >= rule.minAccountUsd && r.monthVolume >= rule.minMonthVolumeUsd && r.monthPnl > 0 && r.weekPnl > 0 && r.monthRoi > 0)
    .sort((a, b) => b.monthPnl - a.monthPnl)
    .slice(0, rule.size);
}
export async function hyperliquidBoard(): Promise<BoardRow[]> { return parseBoard(await getJson(HL_BOARD, {}, 30_000)); }

export interface WalletPosition { coin: string; sizeUsd: number; side: 'long' | 'short'; leverage: number | null }
export async function hyperliquidPositions(address: string): Promise<WalletPosition[]> {
  const d = await getJson(HL, { method: 'POST', body: JSON.stringify({ type: 'clearinghouseState', user: address }) });
  const out: WalletPosition[] = [];
  for (const ap of d?.assetPositions ?? []) {
    const p = ap?.position ?? {}; const sz = Number(p.szi ?? 0); const px = Number(p.entryPx ?? 0); const val = Number(p.positionValue ?? Math.abs(sz) * px);
    if (!sz || !Number.isFinite(val)) continue;
    out.push({ coin: String(p.coin ?? ''), sizeUsd: Math.abs(val), side: sz > 0 ? 'long' : 'short', leverage: p.leverage?.value != null ? Number(p.leverage.value) : null });
  }
  return out;
}
export interface SmartMoney { longUsd: number; shortUsd: number; netUsd: number; longs: number; shorts: number; wallets: number }
/** The cohort's book per coin: USD long and short, wallet counts, net (long minus short). */
export function aggregatePositions(books: Array<WalletPosition[]>): Map<string, SmartMoney> {
  const out = new Map<string, SmartMoney>();
  for (const book of books) for (const p of book) {
    const o = out.get(p.coin) ?? { longUsd: 0, shortUsd: 0, netUsd: 0, longs: 0, shorts: 0, wallets: books.length };
    if (p.side === 'long') { o.longUsd += p.sizeUsd; o.longs++; } else { o.shortUsd += p.sizeUsd; o.shorts++; }
    o.netUsd = o.longUsd - o.shortUsd; out.set(p.coin, o);
  }
  return out;
}

// ---- Binance ----
export interface BinanceRatios { topTraderLongShort: number | null; globalLongShort: number | null; takerBuySell: number | null; oiUsd: number | null }
export async function binanceRatios(coin: string): Promise<BinanceRatios> {
  const sym = `${coin}USDT`;
  const one = async (path: string, field: string) => { try { const d = await getJson(`${BN}/${path}?symbol=${sym}&period=1h&limit=1`); const v = Number(d?.[0]?.[field]); return Number.isFinite(v) ? v : null; } catch { return null; } };
  const [top, global, taker, oi] = await Promise.all([one('topLongShortPositionRatio', 'longShortRatio'), one('globalLongShortAccountRatio', 'longShortRatio'), one('takerlongshortRatio', 'buySellRatio'), one('openInterestHist', 'sumOpenInterestValue')]);
  return { topTraderLongShort: top, globalLongShort: global, takerBuySell: taker, oiUsd: oi };
}

// ---- bias and session (pure) ----
/** Trend bias from closed bars: above a 50-bar EMA that is rising → +1, below a falling one → −1, else 0. */
export function biasOf(bars: Array<Pick<DeltaCandle, 'close'>>, len = 50): 1 | 0 | -1 {
  if (bars.length < len + 5) return 0;
  const k = 2 / (len + 1); let ema = bars[0].close; const emas: number[] = [];
  for (const b of bars) { ema = b.close * k + ema * (1 - k); emas.push(ema); }
  const last = bars.at(-1)!.close, e = emas.at(-1)!, e5 = emas.at(-6)!;
  if (last > e && e > e5) return 1;
  if (last < e && e < e5) return -1;
  return 0;
}
export type Session = 'asia' | 'london' | 'new-york' | 'off';
/** The session by UTC hour: Asia 00–07, London 07–13, New York 13–21, off-hours otherwise. */
export function sessionAt(at: number): Session {
  const h = new Date(at).getUTCHours();
  return h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'new-york' : 'off';
}
