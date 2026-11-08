import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import type { DeltaConnection, ObservationSession } from './delta.ts';
import type { AccountSnapshot, HistoryKind, HistoryRow } from './reader.ts';

type Connection = Pick<DeltaConnection, 'observationRevision' | 'observationSession'>;
type Saved = { account_id: string; revision: string; started_at: number; completed_at: number; from_at: number; through_at: number; snapshot: string };
const ENVIRONMENT = 'production', HOUR = 3600_000, OVERLAP = 300_000;

/** Independent of the order executor. Its ledger is never joined to simulated trades or unscoped legacy history. */
export class AccountObserver {
  private db: Db;
  private connection: Connection;
  private clock: () => number;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private failure: { revision: string | null; at: number; message: string } | null = null;

  constructor(db: Db, connection: Connection, clock = Date.now) {
    this.db = db; this.connection = connection; this.clock = clock;
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS account_observer_state (
        environment TEXT NOT NULL, account_id TEXT NOT NULL, revision TEXT NOT NULL,
        started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL,
        from_at INTEGER NOT NULL, through_at INTEGER NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY(environment,account_id));
      CREATE TABLE IF NOT EXISTS account_observer_history (
        environment TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(environment,account_id,kind,id));
      CREATE INDEX IF NOT EXISTS account_observer_history_time ON account_observer_history(environment,account_id,at);
    `);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      await this.sync();
      if (!this.stopped) {
        this.timer = setTimeout(() => { void tick(); }, Math.min(300_000, 60_000 * 2 ** Math.min(this.failures, 3)));
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void tick(); }, 0); this.timer.unref();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  sync(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopped) return Promise.resolve();
    this.active = this.perform().finally(() => { this.active = null; });
    return this.active;
  }

  private async perform(): Promise<void> {
    let session: ObservationSession | null = null, stage = 'credential storage';
    const startedAt = this.clock();
    try {
      session = this.connection.observationSession();
      if (!session) { this.failure = null; this.failures = 0; return; }
      stage = 'account identity';
      const accountId = await session.reader.identity();
      const prior = this.db.get<Saved>('SELECT * FROM account_observer_state WHERE environment=? AND account_id=?', ENVIRONMENT, accountId);
      const start = prior ? prior.through_at - OVERLAP : startedAt - HOUR;
      const end = Math.min(startedAt, start + HOUR);
      if (prior && startedAt < prior.completed_at) throw Error('clock moved backwards');
      stage = 'fills history';
      const fills = await session.reader.history('fills', start, end, accountId);
      stage = 'wallet history';
      const wallet = await session.reader.history('wallet', start, end, accountId);
      const oldSnapshot: AccountSnapshot | null = prior ? JSON.parse(prior.snapshot) : null;
      const products = new Set(oldSnapshot?.positions.map(p => p.productId) ?? []);
      for (const f of fills) if (typeof f.payload.productId === 'string') products.add(f.payload.productId);
      stage = 'balances, orders and realtime positions';
      const snapshot = await session.reader.snapshot(accountId, [...products]);
      stage = 'credential revision';
      if (this.stopped || !session.current()) return;
      const completedAt = this.clock();
      if (completedAt < startedAt) throw Error('clock moved backwards');
      stage = 'local ledger';
      this.db.transaction(() => {
        const saveRows = (kind: HistoryKind, records: HistoryRow[]) => {
          for (const r of records) this.db.run('INSERT OR REPLACE INTO account_observer_history VALUES(?,?,?,?,?,?)', ENVIRONMENT, accountId, kind, r.id, r.at, JSON.stringify(r.payload));
        };
        saveRows('fills', fills); saveRows('wallet', wallet);
        this.db.run(`INSERT INTO account_observer_state VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(environment,account_id) DO UPDATE SET
          revision=excluded.revision,started_at=excluded.started_at,completed_at=excluded.completed_at,through_at=excluded.through_at,snapshot=excluded.snapshot`,
          ENVIRONMENT, accountId, session!.revision, startedAt, completedAt, prior?.from_at ?? start, end, JSON.stringify(snapshot));
      });
      this.failure = null; this.failures = 0;
    } catch {
      // Never persist or return upstream exception text: it can contain credentials or private metadata.
      this.failures++;
      this.failure = { revision: session?.revision ?? null, at: this.clock(), message: `Observation failed at ${stage}. Last complete data retained; retry scheduled.` };
    }
  }

  summary() {
    const at = this.clock();
    let config;
    try { config = this.connection.observationRevision(); }
    catch { return { at, state: 'error', message: 'Credential storage unavailable.', account: null, syncing: !!this.active }; }
    const unavailable = !config ? 'Save production credentials in Settings to start observation.' : config.environment !== ENVIRONMENT ? 'Production India credentials are required for this observer.' : null;
    if (unavailable) return { at, state: 'unconfigured', message: unavailable, account: null, syncing: !!this.active };
    const saved = this.db.get<Saved>('SELECT * FROM account_observer_state WHERE environment=? AND revision=?', ENVIRONMENT, config!.revision);
    const failure = this.failure?.revision === config!.revision ? this.failure : null;
    if (!saved) return { at, state: failure ? 'error' : 'awaiting', message: failure?.message ?? 'Awaiting the first complete production observation.', account: null, syncing: !!this.active };
    const age = at - saved.started_at, lag = at - saved.through_at;
    const stale = age < 0 || age > 180_000;
    const counts = this.db.all<{kind: string; n: number}>('SELECT kind,count(*) n FROM account_observer_history WHERE environment=? AND account_id=? GROUP BY kind', ENVIRONMENT, saved.account_id);
    const recent = this.db.all<{kind: string; at: number; payload: string}>('SELECT kind,at,payload FROM account_observer_history WHERE environment=? AND account_id=? ORDER BY at DESC LIMIT 20', ENVIRONMENT, saved.account_id)
      .map(r => ({ kind: r.kind, at: r.at, ...JSON.parse(r.payload) }));
    return {
      at, state: failure ? 'error' : stale ? 'stale' : lag > 180_000 ? 'catching-up' : 'observing', syncing: !!this.active,
      message: failure?.message ?? (stale ? 'Observation is stale.' : lag > 180_000 ? 'Backfilling missing history.' : 'Production reads are current. Live certification is still pending.'),
      account: {
        label: createHash('sha256').update(`${ENVIRONMENT}:${saved.account_id}`).digest('hex').slice(0, 12), environment: ENVIRONMENT,
        snapshotStartedAt: saved.started_at, completedAt: saved.completed_at, historyFrom: saved.from_at, historyThrough: saved.through_at,
        historyLagMs: Math.max(0, lag), counts, snapshot: JSON.parse(saved.snapshot) as AccountSnapshot, recent,
        accountingStatus: 'unverified',
        limitations: 'REST observations are not atomic exchange snapshots. Position discovery can lag. History begins at the displayed time, with a five-minute overlap; older or late-posted events need a separate audit. Fees, tax, funding and credits are reported separately, not reconciled or added to paper P&L. No order lifecycle is certified by these reads.',
      },
    };
  }
}
