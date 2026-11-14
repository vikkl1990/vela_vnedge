import type { Db } from '../db.ts';
import { fundingOf, validatePerformanceFilter, type PerformanceFilter } from './performance.ts';

export type JournalBook = 'paper' | 'shadow';
export type JournalFilter = PerformanceFilter & { book: JournalBook; status: string; scope: string; history: string; dateBy: 'entry' | 'exit'; offset: number; limit: number; sort: string };
type Raw = Record<string, any>;
class JournalError extends Error { status = 400; }
const parsed = (s: unknown): any => { try { return typeof s === 'string' ? JSON.parse(s) : null; } catch { return null; } };
const finite = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) ? n : null;
const arrays = (s: unknown): any[] | null => { const v = parsed(s); return Array.isArray(v) ? v : null; };

export function journalFilter(p: URLSearchParams): JournalFilter {
  const book = p.get('book') ?? 'paper', status = p.get('status') ?? 'closed', scope = p.get('scope') ?? 'all', dateBy = p.get('dateBy') ?? 'exit';
  const sort = p.get('sort') ?? 'newest';
  const history = p.get('history') ?? 'current';
  if (!['current','archived','all'].includes(history)) throw new JournalError('Invalid journal history.');
  if (!['paper', 'shadow'].includes(book)) throw new JournalError('Choose paper or shadow.');
  if (!['all', 'open', 'pending', 'closed', 'voided', 'cancelled'].includes(status)) throw new JournalError('Invalid journal status.');
  if (!['all', 'evidence', 'watch', 'plans'].includes(scope)) throw new JournalError('Invalid evidence scope.');
  if (!['entry', 'exit'].includes(dateBy) || !['newest', 'oldest', 'worst', 'best'].includes(sort)) throw new JournalError('Invalid journal ordering or date basis.');
  const num = (k: string, fallback?: number) => p.has(k) ? Number(p.get(k)) : fallback;
  const f = { book, status, scope, history, dateBy, sort, offset: num('offset', 0)!, limit: num('limit', 50)!, from: num('from'), to: num('to'),
    ...Object.fromEntries(['scanner', 'symbol', 'tf', 'side', 'reason'].map(k => [k, p.get(k) || undefined])) } as JournalFilter;
  try { validatePerformanceFilter(f); } catch (e) { throw new JournalError((e as Error).message); }
  if (!Number.isSafeInteger(f.offset) || f.offset < 0 || !Number.isSafeInteger(f.limit) || f.limit < 1 || f.limit > 200) throw new JournalError('Invalid journal page.');
  return f;
}

export function journalRow(r: Raw) {
  const meta = parsed(r.fills), fills = Array.isArray(meta) ? meta : Array.isArray(meta?.fills) ? meta.fills : null;
  const funded = fundingOf(r.fills), realized = finite(r.realized_pnl), fees = finite(r.fees);
  const net = realized !== null && fees !== null ? realized - fees : null;
  const risk = finite(r.risk_amount), leverage = finite(meta?.marginLeverage);
  const notional = [r.entry_price, r.qty, r.contract_value].every(n => finite(n) !== null) ? r.entry_price * r.qty * r.contract_value : null;
  const pending = meta?.limitEntry ?? meta?.pending;
  return {
    id: r.id as number, book: [0,-1].includes(r.bt) ? 'paper' as const : 'shadow' as const, archived: r.bt < 0, status: r.status as string,
    scannerId: r.scanner_id as string, scannerName: r.scanner_name as string, symbol: r.symbol as string, tf: r.tf as string, side: r.side as string | null,
    evidenceScope: r.scanner_id.startsWith('plan:') ? 'plan-comparison' : r.evidence_scope ?? 'unknown',
    entryAt: finite(r.entry_at), exitAt: finite(r.exit_at), eventAt: finite(r.exit_at) ?? finite(r.entry_at) ?? r.event_at,
    entryPrice: finite(r.entry_price), exitPrice: finite(r.exit_price), qty: finite(r.qty), qtyOpen: finite(r.qty_open), contractValue: finite(r.contract_value),
    slOriginal: finite(r.sl_original), sl: finite(r.sl), targets: arrays(r.tp), targetsHit: arrays(r.tp_hit), levelsSource: r.levels_source ?? null,
    risk, notional, marginLeverage: leverage, margin: leverage && leverage > 0 && notional !== null ? notional / leverage : null,
    realizedNet: net, net: r.status === 'closed' ? net : null, commission: fees, funding: funded,
    grossTrading: funded !== null && realized !== null ? realized - funded : null,
    r: r.status === 'closed' && net !== null && risk !== null && risk > 0 ? net / risk : null,
    peakR: finite(r.peak_r) ?? finite(meta?.peakR), worstR: finite(r.worst_r), exitReason: r.exit_reason ?? null,
    mlProbability: finite(meta?.mlProb), policyId: r.policy_id ?? null, configFingerprint: r.config_fp ?? null, signalId: r.signal_id ?? null,
    fills: fills as Array<{at: number; price: number; qty: number; reason: string; fee: number; pnl: number; liquidity?: string; feeWaived?: boolean}> | null,
    accountingPending: !!r.accounting_pending, source: r.fill_source ?? null,
    pending: pending ? { price: finite(pending.limit?.price), expiresAt: finite(pending.limit?.expiresAt), dueAt: finite(pending.dueAt) } : null,
    missingPosition: !!r.missing_position,
  };
}
export type JournalRow = ReturnType<typeof journalRow>;

/** Read model only. Never mutates either engine or joins the observer's real account ledger. */
export class Journal {
  constructor(privateDb: Db) { this.db = privateDb; }
  private db: Db;

  private records(f: JournalFilter, id?: number): JournalRow[] {
    const book = f.book === 'paper' ? 0 : 2;
    const archive = -(book + 1), books = f.history === 'all' ? [book,archive] : [f.history === 'archived' ? archive : book];
    const where = [`p.bt IN (${books.map(()=>'?').join(',')})`], args: Array<string | number> = [...books];
    if (id !== undefined) { where.push('p.id=?'); args.push(id); }
    if (f.status !== 'all') { where.push('p.status=?'); args.push(f.status); }
    for (const [c, v] of [['scanner_id', f.scanner], ['symbol', f.symbol], ['tf', f.tf], ['side', f.side], ['exit_reason', f.reason]]) if (v) { where.push(`p.${c}=?`); args.push(v); }
    const time = f.dateBy === 'entry' ? 'p.entry_at' : 'p.exit_at';
    if (f.from !== undefined) { where.push(`${time}>=?`); args.push(f.from); }
    if (f.to !== undefined) { where.push(`${time}<?`); args.push(f.to); }
    if (f.scope === 'plans') where.push("p.scanner_id LIKE 'plan:%'");
    if (f.scope === 'evidence') where.push("p.scanner_id NOT LIKE 'plan:%' AND (p.bt IN (0,-1) OR p.evidence_scope IN ('shadow','legacy-shadow'))");
    if (f.scope === 'watch') where.push("p.scanner_id NOT LIKE 'plan:%' AND p.bt IN (2,-3) AND p.evidence_scope IN ('tracker','legacy-tracker')");
    const rows = this.db.all<Raw>(`SELECT p.*,
      EXISTS(SELECT 1 FROM execution_accounting a WHERE a.position_id=p.id AND a.state!='complete') accounting_pending,
      (SELECT o.price_source FROM orders o WHERE o.position_id=p.id AND o.bt=p.bt AND o.reason='entry' ORDER BY o.at,o.id LIMIT 1) fill_source
      FROM positions p WHERE ${where.join(' AND ')}`, ...args).map(journalRow);
    // Pending orders used to be deleted. Retained decision events are the only honest record of those cancellations.
    if (['all', 'cancelled'].includes(f.status) && ['all', 'plans'].includes(f.scope)) {
      const deleted = this.db.all<Raw>(`SELECT d.* FROM decision_trace d WHERE d.book=? AND d.stage='cancelled'
        AND d.position_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.id=d.position_id)
        AND d.id=(SELECT max(x.id) FROM decision_trace x WHERE x.position_id=d.position_id AND x.book=d.book AND x.stage='cancelled') ${id === undefined ? '' : 'AND d.position_id=?'}`, ...[book, ...(id === undefined ? [] : [id])]);
      const resetAt = finite(parsed(this.db.get<{v:string}>('SELECT v FROM kv WHERE k=?',`${book === 0 ? 'paper' : 'book2'}.resetAt`)?.v)) ?? 0;
      for (const d of deleted) {
        const archived = d.at < resetAt;
        if ((f.history === 'current' && archived) || (f.history === 'archived' && !archived)) continue;
        if ((f.scanner && d.scanner_id !== f.scanner) || (f.symbol && d.symbol !== f.symbol) || (f.tf && d.tf !== f.tf) || f.side ||
          (f.reason && f.reason !== d.reason) || (f.scope === 'plans' && !d.scanner_id.startsWith('plan:'))) continue;
        // Placement dates are missing for deleted orders; do not invent them from the cancellation timestamp.
        if ((f.from !== undefined || f.to !== undefined) && f.dateBy === 'entry') continue;
        if ((f.from !== undefined && d.at < f.from) || (f.to !== undefined && d.at >= f.to)) continue;
        rows.push(journalRow({ id: d.position_id, bt: archived ? archive : book, status: 'cancelled', scanner_id: d.scanner_id, scanner_name: d.scanner_id,
          symbol: d.symbol, tf: d.tf, side: null, exit_at: d.at, exit_reason: d.reason, signal_id: d.signal_id, missing_position: true }));
      }
    }
    const timeOf = (r: JournalRow) => f.dateBy === 'entry' ? r.entryAt : r.eventAt;
    return rows.sort((a, b) => {
      const av = ['worst', 'best'].includes(f.sort) ? a.net : timeOf(a), bv = ['worst', 'best'].includes(f.sort) ? b.net : timeOf(b);
      if (av === null && bv !== null) return 1; if (av !== null && bv === null) return -1;
      return ((av ?? 0) - (bv ?? 0)) * (['oldest', 'worst'].includes(f.sort) ? 1 : -1) || b.id - a.id;
    });
  }

  page(f: JournalFilter) {
    return this.db.transaction(() => {
      const rows = this.records(f), closed = rows.filter(r => r.status === 'closed'), known = closed.filter(r => r.net !== null), rs = closed.filter(r => r.r !== null);
      const sum = (key: 'net' | 'commission' | 'funding' | 'grossTrading') => closed.reduce((n, r) => n + (r[key] ?? 0), 0);
      const wins = known.filter(r => r.net! > 0), losses = known.filter(r => r.net! < 0), loss = losses.reduce((n, r) => n - r.net!, 0);
      return { at: Date.now(), book: f.book, total: rows.length, offset: f.offset, limit: f.limit, rows: rows.slice(f.offset, f.offset + f.limit),
        summary: { archived: rows.filter(r=>r.archived).length, closed: closed.length, open: rows.filter(r => r.status === 'open').length, pending: rows.filter(r => r.status === 'pending').length,
          cancelled: rows.filter(r => r.status === 'cancelled').length, net: sum('net'), commission: sum('commission'), funding: sum('funding'), grossTrading: sum('grossTrading'),
          wins: wins.length, losses: losses.length, winRate: known.length ? wins.length / known.length * 100 : null,
          profitFactor: loss ? wins.reduce((n, r) => n + r.net!, 0) / loss : null, noLosses: wins.length > 0 && !loss,
          sumR: rs.length ? rs.reduce((n, r) => n + r.r!, 0) : null, avgR: rs.length ? rs.reduce((n, r) => n + r.r!, 0) / rs.length : null,
          unknownFunding: closed.filter(r => r.funding === null).length, unknownNet: closed.length - known.length, unknownRisk: closed.length - rs.length,
          accountingPending: closed.filter(r => r.accountingPending).length,
        } };
    });
  }

  detail(book: JournalBook, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new JournalError('Invalid journal ID.');
    const f = journalFilter(new URLSearchParams({ book, status: 'all', history: 'all' }));
    const row = this.records(f, id)[0];
    if (!row) { const e = new JournalError('Trade not found in this book.'); e.status = 404; throw e; }
    const currentBook = book === 'paper' ? 0 : 2, bt = row.archived ? -(currentBook+1) : currentBook;
    const signal = row.signalId ? this.db.signalById(row.signalId) ?? null : null;
    const rawPolicy = row.policyId ? this.db.get<Raw>('SELECT * FROM trade_policies WHERE id=?', row.policyId) : undefined;
    const raw = this.db.get<Raw>('SELECT fills FROM positions WHERE id=? AND bt=?', id, bt);
    const meta = parsed(raw?.fills);
    const entry = this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_execution'") ? this.db.get('SELECT * FROM entry_execution WHERE position_id=? AND book=?', id, currentBook) ?? null : null;
    const evidence=this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_fill_evidence'")?this.db.get<Raw>('SELECT * FROM entry_fill_evidence WHERE position_id=? AND book=?',id,currentBook):null;
    const entryFillEvidence=evidence?{...evidence,depth:parsed(evidence.depth),admission_depth:parsed(evidence.admission_depth),limit_observation:parsed(evidence.limit_observation)}:null;
    return { row, signal, policy: rawPolicy ? { id: rawPolicy.id, strategyId: rawPolicy.strategy_id, sourceHash: rawPolicy.source_hash, snapshot: parsed(rawPolicy.snapshot) } : null,
      features: meta?.features ?? null, entryExecution: entry,
      entryFillEvidence,
      basketEntries: this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_basket_entries'") ? this.db.all<Raw>('SELECT sequence,at,qty,price,fee,signal_bar,plan_event_id,context FROM paper_basket_entries WHERE position_id=? ORDER BY sequence',id).map(x=>({...x,context:parsed(x.context)})) : [],
      orders: this.db.all('SELECT id,at,side,qty,price,fee,reason,price_source,ref_price,bid,ask,quote_at FROM orders WHERE position_id=? AND bt=? ORDER BY at,id', id, bt).map((o:any)=>({...o,liquidity:meta?.fills?.find((f:any)=>f.orderId===o.id)?.liquidity??null})),
      decisions: this.db.all('SELECT at,stage,reason,snapshot FROM decision_trace WHERE position_id=? AND book=? ORDER BY at,id', id, currentBook).map((r: any) => ({ ...r, snapshot: parsed(r.snapshot) })),
      pathCoverage: this.db.get('SELECT count(*) samples,min(at) fromAt,max(at) throughAt FROM position_path WHERE position_id=?', id),
      caveats: ['All values come from retained records. Reset archives are available; previously erased records cannot be recreated.', 'Shadow dollars are simulated evidence, not account profit.', 'Recorded funding is not proof of complete historical settlement coverage. Missing fields remain unknown.'],
    };
  }

  csv(f: JournalFilter, fills = false): string {
    return this.db.transaction(() => {
      const rows = this.records(f);
      const header = fills ? ['book','position_id','status','symbol','timeframe','scanner','at_utc','reason','side','contracts','price','commission','fill_pnl','source','liquidity','fee_waived','archived'] :
        ['book','id','status','scope','scanner_id','scanner','symbol','timeframe','side','entry_utc','exit_utc','contracts','remaining','contract_value','entry','exit','original_sl','current_sl','targets','targets_hit','risk_usd','notional_usd','margin_leverage','margin_usd','gross_trading_usd','recorded_funding_usd','commission_usd','closed_net_usd','realized_net_usd','net_r','peak_r','worst_r','exit_reason','ml_probability','levels_source','fill_source','policy_id','config_fingerprint','accounting_pending','fills_recorded','missing_position','archived'];
      const lines = [header.map(csvCell).join(',')];
      const orders = new Map<number, Raw[]>();
      if (fills) for (const o of this.db.all<Raw>('SELECT * FROM orders WHERE bt IN (?,?) ORDER BY at,id', f.book === 'paper' ? 0 : 2, f.book === 'paper' ? -1 : -3)) {
        const group = orders.get(o.position_id) ?? []; group.push(o); orders.set(o.position_id, group);
      }
      for (const r of rows) {
        if (fills) {
          const recorded = orders.get(r.id) ?? [], matched = new Set<number>();
          for (const o of recorded) {
            const candidates = r.fills?.map((x, i) => ({x,i})).filter(({x,i}) => !matched.has(i) && ((x as any).orderId === o.id || (x.at === o.at && x.reason === o.reason && x.qty === o.qty && x.price === o.price))) ?? [];
            const match = candidates.find(({x}) => (x as any).orderId === o.id) ?? candidates[0];
            const fill = match?.x; if (match) matched.add(match.i);
            lines.push([r.book,r.id,r.status,r.symbol,r.tf,r.scannerName,utc(o.at),o.reason,o.side,o.qty,o.price,o.fee,fill?.pnl,o.price_source,fill?.liquidity,fill?.feeWaived,r.archived].map(csvCell).join(','));
          }
          // Old fills may survive in the position even when there is no corresponding order row.
          for (const [i, fill] of (r.fills ?? []).entries()) if (!matched.has(i)) lines.push([r.book,r.id,r.status,r.symbol,r.tf,r.scannerName,utc(fill.at),fill.reason,null,fill.qty,fill.price,fill.fee,fill.pnl,'position record only',fill.liquidity,fill.feeWaived,r.archived].map(csvCell).join(','));
        } else lines.push([r.book,r.id,r.status,r.evidenceScope,r.scannerId,r.scannerName,r.symbol,r.tf,r.side,utc(r.entryAt),utc(r.exitAt),r.qty,r.qtyOpen,r.contractValue,r.entryPrice,r.exitPrice,r.slOriginal,r.sl,JSON.stringify(r.targets),JSON.stringify(r.targetsHit),r.risk,r.notional,r.marginLeverage,r.margin,r.grossTrading,r.funding,r.commission,r.net,r.realizedNet,r.r,r.peakR,r.worstR,r.exitReason,r.mlProbability,r.levelsSource,r.source,r.policyId,r.configFingerprint,r.accountingPending,r.fills?.length,r.missingPosition,r.archived].map(csvCell).join(','));
      }
      return '\uFEFF' + lines.join('\r\n') + '\r\n';
    });
  }
}
function utc(at: number | null) { return typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at) > 8.64e15 ? null : new Date(at).toISOString(); }
/** RFC 4180 plus spreadsheet formula neutralisation for untrusted scanner names/labels. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v); if (typeof v === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
