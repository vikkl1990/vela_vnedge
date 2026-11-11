import type { Db } from '../db.ts';
import type { WsTrade } from '../delta/ws.ts';

const MINUTE = 60_000;
export const FLOW_SETTLE_MS = 10_000;
const SETTLE = FLOW_SETTLE_MS;
const KEEP = 3 * 86400_000, MAX_LEVELS = 1000;
export const FLOW_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD'];
export interface FlowLevel { price: number; buyVolume: number; sellVolume: number }
export interface FlowMinute {
  openTime: number; levels: FlowLevel[]; buy: number; sell: number; unknown: number;
  trades: number; covered: boolean;
}
export interface FlowBar extends FlowMinute {
  observedMinutes: number; expectedMinutes: number; delta: number | null;
  cvd: number | null; cvdStart: number | null;
}
export interface FootprintBar { openTime: number; levels: FlowLevel[] }

/** Only full, continuously observed intervals can supply signed volume to Pine.
 * Volumes are Delta contracts, not dollars or estimated buy/sell candle volume. */
export function aggregateFlow(minutes: FlowMinute[], duration: number, from: number, to: number): FlowBar[] {
  if (!Number.isSafeInteger(duration) || duration < MINUTE || duration % MINUTE) throw new Error('Unsupported order-flow timeframe');
  const groups = new Map<number, FlowMinute[]>();
  for (const m of minutes) {
    const at = Math.floor(m.openTime / duration) * duration;
    if (at < from || at + duration > to) continue;
    const group = groups.get(at) ?? []; group.push(m); groups.set(at, group);
  }
  let cvd = 0, start: number | null = null, previous: number | null = null;
  return [...groups].sort((a, b) => a[0] - b[0]).map(([openTime, rows]) => {
    const levels = new Map<number, FlowLevel>();
    let buy = 0, sell = 0, unknown = 0, trades = 0;
    for (const m of rows) {
      buy += m.buy; sell += m.sell; unknown += m.unknown; trades += m.trades;
      for (const l of m.levels) {
        const v = levels.get(l.price) ?? { price: l.price, buyVolume: 0, sellVolume: 0 };
        v.buyVolume += l.buyVolume; v.sellVolume += l.sellVolume; levels.set(l.price, v);
      }
    }
    const expectedMinutes = duration / MINUTE;
    const covered = rows.length === expectedMinutes && new Set(rows.map(m => m.openTime)).size === expectedMinutes && rows.every(m => m.covered) && unknown === 0;
    if (!covered || previous === null || previous + duration !== openTime) { cvd = 0; start = covered ? openTime : null; }
    const delta = covered ? buy - sell : null;
    if (delta !== null) cvd += delta;
    previous = covered ? openTime : null;
    return { openTime, buy, sell, unknown, trades, covered, observedMinutes: rows.length, expectedMinutes,
      delta, cvd: covered ? cvd : null, cvdStart: start, levels: [...levels.values()].sort((a, b) => a.price - b.price) };
  });
}

/** Bounded, restart-safe minute footprints from the existing public tape.
 * Coverage means continuous local socket observation, not exchange-certified delivery.
 * Snapshot messages are intentionally never passed here. No invented historical backfill. */
export class OrderFlowStore {
  private db: Db;
  readonly symbols: string[];
  private observed = new Map<string, number>();
  private pending = new Map<string, FlowMinute>();
  private since: number | null = null;
  private cursor: number | null = null;
  private lastPrune = 0;
  private lastTrade = new Map<string, number>();
  private firstPrint = new Map<string, number>();
  private ids = new Map<string, number>();
  private dropped = 0;
  constructor(db: Db, symbols = FLOW_SYMBOLS) {
    this.db = db; this.symbols = symbols;
    for (const s of symbols) this.observed.set(s, 0);
    db.db.exec(`CREATE TABLE IF NOT EXISTS order_flow_minutes (
      symbol TEXT NOT NULL, open_time INTEGER NOT NULL, covered INTEGER NOT NULL,
      payload TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(symbol,open_time));
      CREATE INDEX IF NOT EXISTS order_flow_time ON order_flow_minutes(open_time);`);
    db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_flow_minutes (
      symbol TEXT NOT NULL,open_time INTEGER NOT NULL,available_at INTEGER NOT NULL,covered INTEGER NOT NULL,
      buy REAL NOT NULL,sell REAL NOT NULL,unknown REAL NOT NULL,trades INTEGER NOT NULL,PRIMARY KEY(symbol,open_time));
      CREATE INDEX IF NOT EXISTS advisory_flow_time ON advisory_flow_minutes(open_time);`);
  }

  /** Compact observations expand independently of the footprint inputs used by existing scanners. */
  observeSymbols(symbols: string[], now = Date.now()) {
    const wanted = new Set([...this.symbols, ...symbols]);
    for (const s of wanted) if (!this.observed.has(s)) { this.observed.set(s, now); this.firstPrint.delete(s); }
    for (const s of this.observed.keys()) if (!wanted.has(s)) this.observed.delete(s);
  }
  summary(symbol: string, now = Date.now()) {
    const end = Math.floor((now - SETTLE) / MINUTE) * MINUTE;
    const rows = this.db.all<{open_time:number;available_at:number;covered:number;buy:number;sell:number;unknown:number;trades:number}>(
      'SELECT * FROM advisory_flow_minutes WHERE symbol=? AND open_time>=? AND open_time<? ORDER BY open_time', symbol, end-5*MINUTE,end);
    const covered = this.since !== null && rows.length === 5 && rows.every((r,i)=>r.open_time===end-(5-i)*MINUTE && !!r.covered && !r.unknown && r.available_at<=now);
    const buy=rows.reduce((a,r)=>a+r.buy,0),sell=rows.reduce((a,r)=>a+r.sell,0);
    return {observed:this.observed.has(symbol),covered,minutes:rows.length,throughAt:rows.at(-1)?.open_time ? rows.at(-1)!.open_time+MINUTE : null,
      availableAt:rows.length?Math.max(...rows.map(r=>r.available_at)):null,lastTradeAt:this.lastTrade.get(symbol)??null,
      buy:covered?buy:null,sell:covered?sell:null,imbalance:covered&&buy+sell>0?(buy-sell)/(buy+sell):null};
  }

  connection(connected: boolean, now = Date.now()) {
    if (connected && this.since !== null) return;
    this.flush(now);
    for (const m of this.pending.values()) m.covered = false;
    this.since = connected ? now : null;
    this.firstPrint.clear();
    this.cursor = connected ? Math.floor(now / MINUTE) * MINUTE : null;
  }

  private minute(symbol: string, at: number): FlowMinute {
    const key = `${symbol}:${at}`;
    let m = this.pending.get(key);
    if (!m) {
      m = { openTime: at, levels: [], buy: 0, sell: 0, unknown: 0, trades: 0,
        covered: this.since !== null && this.since <= at && (this.observed.get(symbol)??Infinity)<=at };
      this.pending.set(key, m);
    }
    return m;
  }

  onTrade(t: WsTrade, now = Date.now()) {
    if (!this.observed.has(t.symbol)) return;
    if (t.timeKnown === false || !(Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.qty) && t.qty > 0 && Number.isFinite(t.timeMs) && t.timeMs > 0)) {
      this.minute(t.symbol, Math.floor(now / MINUTE) * MINUTE).covered = false; this.dropped++; return;
    }
    const at = Math.floor(t.timeMs / MINUTE) * MINUTE;
    if (t.timeMs > now + 2000 || this.since === null) {
      this.minute(t.symbol, Math.floor(now / MINUTE) * MINUTE).covered = false; this.dropped++; return;
    }
    // A late arrival cannot silently rewrite an interval already used by a scanner.
    if (at + MINUTE <= now - SETTLE) {
      this.db.run('UPDATE order_flow_minutes SET covered=0 WHERE symbol=? AND open_time=?', t.symbol, at);
      this.db.run('UPDATE advisory_flow_minutes SET covered=0 WHERE symbol=? AND open_time=?', t.symbol, at);
      const pending = this.pending.get(`${t.symbol}:${at}`); if (pending) pending.covered = false;
      this.dropped++; return;
    }
    // Only supplied exchange IDs are safe to deduplicate. Identical prints without IDs are real possibilities.
    if (t.id) { const key = `${t.symbol}:${t.id}`; if (this.ids.has(key)) return; this.ids.set(key, now); }
    const m = this.minute(t.symbol, at);
    if (!this.firstPrint.has(t.symbol)) this.firstPrint.set(t.symbol, now);
    m.trades++;
    if (!t.aggressor) { m.unknown += t.qty; m.covered = false; }
    else {
      if (!this.symbols.includes(t.symbol)) {
        if (t.aggressor === 'buy') m.buy += t.qty; else m.sell += t.qty;
        this.lastTrade.set(t.symbol, now);
        while (this.ids.size > 20000) this.ids.delete(this.ids.keys().next().value!);
        return;
      }
      let level = m.levels.find(l => l.price === t.price);
      if (!level && m.levels.length >= MAX_LEVELS) { m.covered = false; this.dropped++; return; }
      if (!level) { level = { price: t.price, buyVolume: 0, sellVolume: 0 }; m.levels.push(level); }
      if (t.aggressor === 'buy') { m.buy += t.qty; level.buyVolume += t.qty; }
      else { m.sell += t.qty; level.sellVolume += t.qty; }
    }
    this.lastTrade.set(t.symbol, now);
    while (this.ids.size > 20000) this.ids.delete(this.ids.keys().next().value!);
  }

  flush(now = Date.now()) {
    if (this.cursor !== null) {
      // A stalled collector must expose a hole instead of manufacturing coverage.
      if (now - this.cursor > 3 * MINUTE) {
        for (const m of this.pending.values()) m.covered = false;
        this.since = now; this.cursor = Math.floor(now / MINUTE) * MINUTE;
      }
      while (this.cursor + MINUTE <= now - SETTLE) {
        for (const symbol of this.observed.keys()) this.minute(symbol, this.cursor);
        this.cursor += MINUTE;
      }
    }
    const ready = [...this.pending].filter(([, m]) => m.openTime + MINUTE <= now - SETTLE);
    this.db.transaction(() => {
      for (const [key, m] of ready) {
        const symbol = key.slice(0, key.lastIndexOf(':'));
        // An open socket alone does not establish that this symbol's subscription
        // delivered anything. Never label a never-seen channel as zero-volume flow.
        if ((this.firstPrint.get(symbol) ?? Infinity) >= m.openTime + MINUTE) m.covered = false;
        const payload = JSON.stringify(m);
        if(this.symbols.includes(symbol)) this.db.run(`INSERT INTO order_flow_minutes(symbol,open_time,covered,payload,bytes) VALUES(?,?,?,?,?)
          ON CONFLICT(symbol,open_time) DO UPDATE SET covered=0`, symbol, m.openTime, Number(m.covered), payload, Buffer.byteLength(payload));
        this.db.run(`INSERT INTO advisory_flow_minutes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(symbol,open_time) DO UPDATE SET covered=0`,
          symbol,m.openTime,now,Number(m.covered),m.buy,m.sell,m.unknown,m.trades);
      }
      if (now - this.lastPrune >= 600_000) {
        this.db.run('DELETE FROM advisory_flow_minutes WHERE open_time<?', now-KEEP);
        this.db.run('DELETE FROM advisory_flow_minutes WHERE rowid IN (SELECT rowid FROM advisory_flow_minutes ORDER BY open_time DESC LIMIT -1 OFFSET 500000)');
        this.db.run('DELETE FROM order_flow_minutes WHERE open_time<?', now - KEEP);
        this.db.run('DELETE FROM order_flow_minutes WHERE rowid IN (SELECT rowid FROM order_flow_minutes ORDER BY open_time DESC LIMIT -1 OFFSET 16000)');
        const rows = this.db.all<{ rowid: number; bytes: number }>('SELECT rowid,bytes FROM order_flow_minutes ORDER BY open_time DESC');
        let bytes = 0;
        for (const row of rows) { bytes += row.bytes; if (bytes > 64 * 1024 * 1024) this.db.run('DELETE FROM order_flow_minutes WHERE rowid=?', row.rowid); }
      }
    });
    for (const [key] of ready) this.pending.delete(key);
    if (now - this.lastPrune >= 600_000) this.lastPrune = now;
    for (const [id, at] of this.ids) if (at < now - 2 * MINUTE) this.ids.delete(id);
  }

  minutes(symbol: string, from: number, to: number): FlowMinute[] {
    if (!this.symbols.includes(symbol)) return [];
    return this.db.all<{ payload: string; covered: number }>(
      'SELECT payload,covered FROM order_flow_minutes WHERE symbol=? AND open_time>=? AND open_time+60000<=? ORDER BY open_time LIMIT 4320',
      symbol, Math.max(from, to - KEEP), to).map(r => ({ ...JSON.parse(r.payload), covered: Boolean(r.covered) }));
  }

  view(symbol: string, duration: number, from: number, to: number, now = Date.now()) {
    const bars = aggregateFlow(this.minutes(symbol, from, Math.min(to, now - SETTLE)), duration, from, Math.min(to, now - SETTLE));
    return { venue: 'Delta India', symbol, unit: 'contracts', supported: this.symbols.includes(symbol),
      connected: this.since !== null, lastTradeAt: this.lastTrade.get(symbol) ?? null,
      observedSince: this.db.get<{ at: number | null }>('SELECT min(open_time) at FROM order_flow_minutes WHERE symbol=?', symbol)?.at ?? null,
      retention: '72 hours / 16,000 minutes / 64 MiB; collection starts at deployment',
      coverageBasis: 'Continuous local socket observation; gaps and unclassified trades are excluded',
      dropped: this.dropped, bars };
  }
}
