/**
 * Decision 187: the paper fills against the tape. Every fill either book makes is set beside the real prints Delta's
 * `all_trades` channel carried at that moment, without placing an order:
 *
 *  - a stop (`sl`, `trail`, `be`): where a stop-market order would have filled — the volume-weighted price of the prints
 *    in the 3 s after the first print through the stop level (looking back 3 s, since the paper reads minute updates);
 *  - a market fill (entries, reversals, script and manual exits): the volume-weighted price of the prints in the 3 s
 *    after the fill;
 *  - a resting limit (decision 185): from placement to fill or lapse, the volume traded at the limit's own price before
 *    the first print through it — the queue a real order at the back would have had to wait behind — and whether price
 *    ever went through.
 *
 * Slippage is signed so that positive is worse than paper: in basis points of price and in R of the trade's own stop.
 */
import type { Db } from '../db.ts';
import type { PaperEngine } from '../paper/engine.ts';
import type { WsTrade } from '../delta/ws.ts';
import { logger } from '../log.ts';

const log = logger.scoped('tape-audit');
// thin alts on Delta India often go minutes without a trade (STRK, PEPE: a median 13–21 s between prints, gaps up to
// 7 min), so a fill waits up to 2 min for its first print; a price that late is drift, not slippage, and stays out of the averages
const BEFORE_MS = 3000, AFTER_MS = 3000, GRACE_MS = 120_000, KEEP_MS = 15_000, LATE_MS = 10_000;
const STOP_REASONS = new Set(['sl', 'trail', 'be']);

type Print = { t: number; p: number; q: number };
type Fill = { at: number; positionId: number; symbol: string; side: 'buy' | 'sell'; qty: number; price: number; reason: string };
type Open = { book: number; fill: Fill; kind: string; level: number; riskUnit: number | null; tf: string; due: number; giveUpAt: number };
type Limit = { book: number; id: number; symbol: string; tf: string; side: 'long' | 'short'; price: number; since: number; tick: number; volAt: number; volBeforeThrough: number | null; throughAt: number | null; touchAt: number | null };

export interface TapeAuditSummary {
  since: number | null;
  fills: Array<{ book: string; kind: string; n: number; noPrints: number; late: number; medianBps: number | null; meanBps: number | null; p90Bps: number | null; meanR: number | null }>;
  limits: Array<{ book: string; n: number; filled: number; touched: number; through: number; medianVolBeforeThrough: number | null }>;
  recent: Array<Record<string, unknown>>;
}

export class TapeAudit {
  private prints = new Map<string, Print[]>();
  private open: Open[] = [];
  private limits = new Map<string, Limit>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: Db;
  private books: Array<{ engine: PaperEngine; book: number }>;

  constructor(db: Db, books: Array<{ engine: PaperEngine; book: number }>) {
    this.db = db; this.books = books;
    db.run(`CREATE TABLE IF NOT EXISTS tape_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, book INTEGER NOT NULL, position_id INTEGER, symbol TEXT NOT NULL, tf TEXT,
      kind TEXT NOT NULL, side TEXT, paper_price REAL, tape_price REAL, first_print REAL, worst_print REAL, prints INTEGER,
      risk_unit REAL, slip_bps REAL, slip_r REAL, extra TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS idx_tape_audit_at ON tape_audit(at DESC)');
    for (const { engine, book } of books) engine.on('order', (o: Fill) => this.onFill(book, engine, o));
  }

  start() { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One print from the tape. */
  onTrade(t: WsTrade) {
    if (!(t.price > 0)) return;
    const arr = this.prints.get(t.symbol) ?? [];
    arr.push({ t: t.timeMs, p: t.price, q: t.qty });
    const cut = t.timeMs - KEEP_MS - GRACE_MS;
    while (arr.length && arr[0].t < cut) arr.shift();
    this.prints.set(t.symbol, arr);
    for (const L of this.limits.values()) {
      if (L.symbol !== t.symbol || t.timeMs < L.since) continue;
      const at = Math.abs(t.price - L.price) <= L.tick / 2;
      const through = L.side === 'long' ? t.price < L.price - L.tick / 2 : t.price > L.price + L.tick / 2;
      if (at && L.throughAt === null) { L.volAt += t.qty; L.touchAt ??= t.timeMs; }
      if (through && L.throughAt === null) { L.throughAt = t.timeMs; L.volBeforeThrough = L.volAt; }
    }
  }

  private onFill(book: number, engine: PaperEngine, o: Fill) {
    try {
      const pos = engine.position(o.positionId);
      const riskUnit = pos && pos.slOriginal != null ? Math.abs(pos.entryPrice - pos.slOriginal) : null;
      const key = `${book}:${o.positionId}`;
      const lim = this.limits.get(key);
      if (o.reason === 'entry' && lim) {
        this.finishLimit(lim, true, o.at);
        this.limits.delete(key);
        return;   // a maker fill at its own price: the queue is the question, recorded with the limit
      }
      const kind = o.reason === 'entry' ? 'market entry' : STOP_REASONS.has(o.reason) ? `stop (${o.reason})` : /^tp\d$/.test(o.reason) ? 'target' : `market exit (${o.reason})`;
      if (kind === 'target') return;   // a resting take-profit fills at its level or not at all; nothing to compare
      this.open.push({ book, fill: o, kind, level: o.price, riskUnit, tf: pos?.tf ?? '', due: o.at + AFTER_MS + 500, giveUpAt: o.at + GRACE_MS });
    } catch (e: any) { log.warn(`fill not audited: ${e?.message ?? e}`); }
  }

  private tick(now = Date.now()) {
    // the books' resting limits: start tracking new ones, close the ones that went away without a fill
    const seen = new Set<string>();
    for (const { engine, book } of this.books) {
      for (const pe of engine.pendingEntries()) {
        if (!pe.limit) continue;
        const key = `${book}:${pe.id}`; seen.add(key);
        if (!this.limits.has(key)) this.limits.set(key, { book, id: pe.id, symbol: pe.symbol, tf: pe.tf, side: pe.side, price: pe.limit.price, since: pe.at, tick: pe.market.tickSize || 0, volAt: 0, volBeforeThrough: null, throughAt: null, touchAt: null });
      }
    }
    for (const [key, L] of this.limits) if (!seen.has(key)) { this.finishLimit(L, false, now); this.limits.delete(key); }
    // fills whose window has passed
    const keep: Open[] = [];
    for (const o of this.open) {
      if (now < o.due) { keep.push(o); continue; }
      // one write per fill: priced if prints have come, recorded as print-less once the grace is out, else retried
      if (!this.finishFill(o, now >= o.giveUpAt)) keep.push(o);
    }
    this.open = keep;
  }

  /** Price the fill against the tape. Returns false while no print has arrived yet (and the grace has not run out). */
  private finishFill(o: Open, final = false): boolean {
    const f = o.fill, arr = this.prints.get(f.symbol) ?? [];
    const sell = f.side === 'sell';
    let from = f.at;
    if (o.kind.startsWith('stop')) {
      // the first print through the stop level, looking back over the minute update that triggered the paper
      const trig = arr.find(x => x.t >= f.at - BEFORE_MS && (sell ? x.p <= o.level : x.p >= o.level));
      if (trig) from = trig.t;
    }
    const win = arr.filter(x => x.t >= from && x.t <= from + AFTER_MS);
    const after = win.length ? win : arr.filter(x => x.t >= from).slice(0, 5);
    if (!after.length) {
      if (!final) return false;
      this.insert(o, null, null, null, 0, { note: 'no print within 2 min' });
      return true;
    }
    const vol = after.reduce((a, x) => a + x.q, 0) || after.length;
    const vwap = after.reduce((a, x) => a + x.p * (x.q || 1), 0) / vol;
    const worst = sell ? Math.min(...after.map(x => x.p)) : Math.max(...after.map(x => x.p));
    const lateSec = win.length ? 0 : Math.round((after[0].t - from) / 1000);
    this.insert(o, vwap, after[0].p, worst, after.length, win.length ? undefined : { note: `first print ${lateSec} s after`, lateSec });
    return true;
  }

  private insert(o: Open, tape: number | null, first: number | null, worst: number | null, prints: number, extra?: Record<string, unknown>) {
    const f = o.fill, sell = f.side === 'sell';
    const diff = tape === null ? null : sell ? f.price - tape : tape - f.price;   // positive: the tape was worse than paper
    const bps = diff === null ? null : (diff / f.price) * 1e4;
    const r = diff === null || !o.riskUnit ? null : diff / o.riskUnit;
    try {
      this.db.run('INSERT INTO tape_audit(at, book, position_id, symbol, tf, kind, side, paper_price, tape_price, first_print, worst_print, prints, risk_unit, slip_bps, slip_r, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        f.at, o.book, f.positionId, f.symbol, o.tf, o.kind, f.side, f.price, tape, first, worst, prints, o.riskUnit, bps, r, extra ? JSON.stringify(extra) : null);
    } catch (e: any) { log.warn(`tape audit row not written: ${e?.message ?? e}`); }
  }

  private finishLimit(L: Limit, filled: boolean, at: number) {
    try {
      this.db.run('INSERT INTO tape_audit(at, book, position_id, symbol, tf, kind, side, paper_price, tape_price, first_print, worst_print, prints, risk_unit, slip_bps, slip_r, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        at, L.book, L.id, L.symbol, L.tf, 'resting limit', L.side === 'long' ? 'buy' : 'sell', L.price, null, null, null, null, null, null, null,
        JSON.stringify({ filled, touched: L.touchAt !== null, through: L.throughAt !== null, volAtLimit: L.volAt, volBeforeThrough: L.volBeforeThrough, restedMin: Math.round((at - L.since) / 60_000), touchToThroughSec: L.touchAt !== null && L.throughAt !== null ? Math.round((L.throughAt - L.touchAt) / 1000) : null }));
    } catch (e: any) { log.warn(`limit audit row not written: ${e?.message ?? e}`); }
  }

  summary(since = Date.now() - 14 * 86_400_000): TapeAuditSummary {
    const rows = this.db.all<any>('SELECT * FROM tape_audit WHERE at >= ? ORDER BY at DESC', since);
    const bookName = (b: number) => (b === 0 ? 'account' : 'shadow');
    const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);
    const groups = new Map<string, any[]>();
    const lateOf = (r: any) => { try { return (r.extra ? JSON.parse(r.extra).lateSec : 0) ?? 0; } catch { return 0; } };
    for (const r of rows.filter(r => r.kind !== 'resting limit')) { const k = `${r.book}|${r.kind}`; const g = groups.get(k) ?? []; g.push(r); groups.set(k, g); }
    const fills = [...groups].map(([k, g0]) => {
      let g = g0;
      const [b, kind] = k.split('|');
      const late = g.filter(r => r.slip_bps !== null && lateOf(r) * 1000 > LATE_MS).length;
      g = g.filter(r => !(lateOf(r) * 1000 > LATE_MS));   // the averages read only prints within 10 s of the fill
      const bps = g.map(r => r.slip_bps).filter((x): x is number => typeof x === 'number').sort((a, c) => a - c);
      const rs = g.map(r => r.slip_r).filter((x): x is number => typeof x === 'number');
      return { book: bookName(Number(b)), kind, n: g.length + late, noPrints: g.filter(r => r.slip_bps === null).length, late, medianBps: q(bps, 0.5), meanBps: bps.length ? bps.reduce((a, c) => a + c, 0) / bps.length : null, p90Bps: q(bps, 0.9), meanR: rs.length ? rs.reduce((a, c) => a + c, 0) / rs.length : null };
    }).sort((a, c) => c.n - a.n);
    const limits = [0, 2].map(b => {
      const g = rows.filter(r => r.kind === 'resting limit' && r.book === b).map(r => { try { return JSON.parse(r.extra ?? '{}'); } catch { return {}; } });
      const v = g.map(x => x.volBeforeThrough).filter((x): x is number => typeof x === 'number').sort((a, c) => a - c);
      return { book: bookName(b), n: g.length, filled: g.filter(x => x.filled).length, touched: g.filter(x => x.touched).length, through: g.filter(x => x.through).length, medianVolBeforeThrough: q(v, 0.5) };
    }).filter(x => x.n > 0);
    return { since: rows.length ? rows[rows.length - 1].at : null, fills, limits, recent: rows.slice(0, 40).map(r => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null })) };
  }
}
