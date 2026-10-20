/**
 * Decision 153: the Library — every script the bot holds, with what the bot has measured about it, for the dashboard's
 * Library page. One cached list (families, status, the stages its pairs sit in, its last 30 days in the shadow book and
 * its paper record), one detail per script, and each user's favorites.
 */
import type { App } from '../app.ts';
import { FAMILIES } from './families.ts';

const DAY = 86_400_000;
type Stages = Partial<Record<'live' | 'shadow' | 'proposed' | 'tracked' | 'candidate' | 'retired' | 'demote_proposed', number>>;
export interface LibraryEntry {
  id: string; name: string; author: string; family: string; origin: string; status: 'runs' | 'fails' | 'quarantined';
  error: string | null; scriptType: string | null; overlay: boolean; updated: string | null; url: string; enabled: boolean;
  stages: Stages; shadow: { n: number; r: number; win: number; spark: number[] } | null; paper: { n: number; net: number; r: number } | null;
}

/** A date for "new releases": the manifest's `updated`, as YYYY-MM-DD, or null. */
function day(v: string | null | undefined): string | null { const m = v ? String(v).match(/^\d{4}-\d{2}-\d{2}/) : null; return m ? m[0] : null; }
/** A cumulative-R line sampled to `n` points, for the card's preview. */
function spark(rs: number[], n = 24): number[] {
  if (!rs.length) return [];
  const cum: number[] = []; let c = 0; for (const r of rs) cum.push(c += r);
  if (cum.length <= n) return [0, ...cum].map(v => Math.round(v * 100) / 100);
  return Array.from({ length: n + 1 }, (_, i) => i === 0 ? 0 : Math.round(cum[Math.round(i * (cum.length - 1) / n)] * 100) / 100);
}

export class LibraryService {
  private cache: { at: number; body: { families: Array<{ key: string; label: string; count: number }>; scripts: LibraryEntry[]; at: number } } | null = null;
  private app: App;
  constructor(app: App) { this.app = app; }

  private stageMap(): Map<string, Stages> {
    const out = new Map<string, Stages>();
    for (const r of this.app.db.all<{ scanner_id: string; stage: string; n: number }>('SELECT scanner_id, stage, COUNT(*) n FROM incubator_pairs GROUP BY scanner_id, stage')) {
      const s = out.get(r.scanner_id) ?? {}; (s as any)[r.stage] = r.n; out.set(r.scanner_id, s);
    }
    return out;
  }

  list(now = Date.now()) {
    if (this.cache && now - this.cache.at < 60_000) return this.cache.body;
    const stages = this.stageMap();
    const shadow = new Map<string, number[]>();
    for (const r of this.app.db.all<{ scanner_id: string; r: number }>("SELECT scanner_id, (realized_pnl - fees) / risk_amount r FROM positions WHERE bt=2 AND status='closed' AND risk_amount > 0 AND exit_at >= ? ORDER BY exit_at", now - 30 * DAY)) {
      const a = shadow.get(r.scanner_id) ?? []; a.push(r.r); shadow.set(r.scanner_id, a);
    }
    const paper = new Map<string, { n: number; net: number; r: number }>();
    for (const r of this.app.db.all<{ scanner_id: string; n: number; net: number; r: number }>("SELECT scanner_id, COUNT(*) n, SUM(realized_pnl - fees) net, SUM((realized_pnl - fees) / risk_amount) r FROM positions WHERE bt=0 AND status='closed' AND risk_amount > 0 GROUP BY scanner_id")) paper.set(r.scanner_id, { n: r.n, net: r.net, r: r.r });
    const scripts: LibraryEntry[] = [];
    for (const s of this.app.registry.all()) {
      if (s.status === 'unavailable') continue;
      const health = this.app.scanners.health.row(s.id);
      const cfg = this.app.scanners.scannerConfig(s.id);
      const rs = shadow.get(s.id) ?? [];
      scripts.push({
        id: s.id, name: s.name, author: s.author, family: s.family, origin: s.origin,
        status: health?.quarantined ? 'quarantined' : s.status === 'ok' ? 'runs' : 'fails',
        error: health?.quarantined ? (health.reason ?? health.lastError ?? null) : s.status === 'ok' ? null : s.reason,
        scriptType: s.scriptType, overlay: s.overlay, updated: day(s.updated), url: s.url, enabled: Boolean(cfg.enabled && !cfg.hidden),
        stages: stages.get(s.id) ?? {},
        shadow: rs.length ? { n: rs.length, r: Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100, win: rs.filter(x => x > 0).length / rs.length, spark: spark(rs) } : null,
        paper: paper.get(s.id) ?? null,
      });
    }
    const counts = new Map<string, number>(); for (const e of scripts) counts.set(e.family, (counts.get(e.family) ?? 0) + 1);
    const body = { at: now, families: FAMILIES.map(f => ({ ...f, count: counts.get(f.key) ?? 0 })), scripts };
    this.cache = { at: now, body };
    return body;
  }

  detail(id: string, now = Date.now()) {
    const s = this.app.registry.get(id);
    if (!s || s.status === 'unavailable') return null;
    const entry = this.list(now).scripts.find(e => e.id === id) ?? null;
    const health = this.app.scanners.health.row(id);
    const cells = new Map<string, { n: number; r: number }>();
    for (const r of this.app.db.all<{ symbol: string; tf: string; n: number; r: number }>("SELECT symbol, tf, COUNT(*) n, SUM((realized_pnl - fees) / risk_amount) r FROM positions WHERE bt=2 AND status='closed' AND risk_amount > 0 AND scanner_id=? AND exit_at >= ? GROUP BY symbol, tf", id, now - 30 * DAY)) cells.set(`${r.symbol}|${r.tf}`, { n: r.n, r: r.r });
    const pairs = this.app.db.all<{ symbol: string; tf: string; stage: string; since: number; screen: string | null }>('SELECT symbol, tf, stage, since, screen FROM incubator_pairs WHERE scanner_id=? ORDER BY stage, symbol, tf', id).map(p => {
      let sc: any = null; try { sc = p.screen ? JSON.parse(p.screen) : null; } catch { sc = null; }
      return { symbol: p.symbol, tf: p.tf, stage: p.stage, since: p.since, screen: sc ? { pass: Boolean(sc.pass), trades: sc.trades ?? null, avgR: sc.avgR ?? null, profitFactor: sc.profitFactor ?? null, at: sc.at ?? null, expired: Boolean(sc.expiredAt) } : null, shadow30: cells.get(`${p.symbol}|${p.tf}`) ?? null };
    });
    const recent = this.app.db.all<{ bt: number; symbol: string; tf: string; side: string; entry_at: number; exit_at: number; exit_reason: string; net: number; r: number }>(
      "SELECT bt, symbol, tf, side, entry_at, exit_at, exit_reason, realized_pnl - fees net, (realized_pnl - fees) / risk_amount r FROM positions WHERE bt IN (0,2) AND status='closed' AND risk_amount > 0 AND scanner_id=? ORDER BY exit_at DESC LIMIT 12", id)
      .map(t => ({ book: t.bt === 0 ? 'paper' : 'shadow', symbol: t.symbol, tf: t.tf, side: t.side, entryAt: t.entry_at, exitAt: t.exit_at, exitReason: t.exit_reason, r: t.r, net: t.bt === 0 ? t.net : null }));
    return {
      ...(entry ?? {}), id: s.id, name: s.name, author: s.author, family: s.family, origin: s.origin, url: s.url, license: s.license,
      scriptType: s.scriptType, overlay: s.overlay, pineVersion: s.pineVersion, lines: s.lines, patches: s.patches, reason: s.reason,
      health: health ? { fails: health.fails, lastError: health.lastError, quarantined: health.quarantined, reason: health.reason } : null,
      pairs, recent,
    };
  }

  favorites(userId: number): string[] { return this.app.db.kvGet<string[]>(`library.favorites.${userId}`) ?? []; }
  setFavorite(userId: number, id: string, on: boolean): string[] {
    if (!this.app.registry.get(id)) throw new Error('unknown script');
    const cur = new Set(this.favorites(userId)); if (on) cur.add(id); else cur.delete(id);
    const out = [...cur]; this.app.db.kvSet(`library.favorites.${userId}`, out); return out;
  }
}
