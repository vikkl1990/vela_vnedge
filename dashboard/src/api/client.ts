import type {ExecutionPlansView} from './executionPlans'
import type {Contributions, ContributionDetail} from './contributions'
import type {
  ReclaimTrialsView,
  ExecutionStatus,
  RiskState,
  IncubatorPair,
  IncubatorView,
  ScannerIndexEntry,
  BacktestResult,
  Candle,
  CandleQuery,
  Config,
  ConfigPatch,
  EquityPoint,
  Health,
  LogEntry,
  LogLevel,
  Market,
  Order,
  Position,
  Scanner,
  ScannerOverlay,
  ScannerSource,
  ScannerUpdate,
  Signal,
  SignalQuery,
  Stats,
  Ticker,
  Trade,
  TradeQuery, TradePage, MlSnapshot,
  AllocationAudit, MlYardstick, ShareLink, MlScannerInsight, Analytics, Learning, AuthStatus, Me, Session, Role, RoleOption, PathPoint, PathLevels, ProfileRow, MarketsToday, OpsMetricRow, GatesView, ContextView, DailyRow, TrackerView,
  LibraryDetail,
  LibraryList, ScreenJob, ScreenQueueView, RadarView, TapeAuditView, DuplicateGroup, OverlapCluster, LockStudyView, RunHealthRow } from './types'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

const BASE = '/api'

function qs(params: object): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      // the session lives in an HttpOnly cookie; without this the API sees an anonymous caller
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    })
  } catch (e) {
    throw new ApiError(0, `Backend unreachable (${(e as Error).message})`)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null) ?? `${res.status} ${res.statusText}`
    throw new ApiError(res.status, msg, body)
  }
  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

export const api = {
  signalActivity: () => get<{at:number;since:number;entries:number}>('/signals/activity'),
  executionQuality: () => get<import('./types').ExecutionQuality>('/execution-quality'),
  // health / config
  health: () => get<Health>('/health'),
  config: () => get<Config>('/config'),
  configDefaults: () => get<Config>('/config/defaults'),
  updateConfig: (patch: ConfigPatch) => put<Config>('/config', patch),

  // markets & candles
  markets: () => get<Market[]>('/markets'),
  candles: (q: CandleQuery) => get<Candle[]>(`/candles${qs(q)}`),
  ticker: (symbol: string) => get<Ticker>(`/ticker${qs({ symbol })}`),

  // scanners
  // ---- authentication ----
  authStatus: () => get<AuthStatus>('/auth/status'),
  setup: (body: { username: string; password: string; displayName?: string }) => post<{ user: Me }>('/auth/setup', body),
  login: (body: { username: string; password: string }) => post<{ user: Me }>('/auth/login', body),
  logout: () => post<{ ok: true }>('/auth/logout'),
  me: () => get<Session>('/auth/me'),
  changePassword: (body: { current: string; next: string }) => post<{ ok: true }>('/auth/password', body),
  updateProfile: (body: { displayName: string }) => post<{ user: Me }>('/auth/profile', body),
  // risk and exchange state
  risk: () => get<RiskState>('/risk'),
  marketsToday: () => get<MarketsToday>('/markets/today'),
  gates: () => get<GatesView>('/gates'),
  context: () => get<ContextView>('/context'),
  opsMetricsHistory: (hours = 24) => get<{ hours: number; rows: OpsMetricRow[] }>(`/ops/metrics/history?hours=${hours}`),
  ops: () => get<{ alerts?: { channel?: string; configured?: boolean; sent?: number; lastAt?: number | null; lastError?: string | null; recent?: Array<{ at: number; text: string; delivered: boolean }> } }>('/ops'),
  refreshMarketsToday: () => post<MarketsToday>('/markets/today/refresh'),
  /** Manual halt: no new entries until resumed; optionally flatten the paper book. */
  riskKill: (reason: string, closeAll = false) => post<RiskState>('/risk/kill', { reason, closeAll }),
  riskResume: () => post<RiskState>('/risk/reset'),
  executionReconcile: () => post<unknown>('/execution/reconcile'),
  executionCloseAll: () => post<unknown>('/execution/close-all', { confirm: true, actor: 'dashboard' }),
  execution: () => get<ExecutionStatus>('/execution'),

  // incubator
  incubator: () => get<IncubatorView>('/incubator'),
  radar: (hours: number) => get<RadarView>(`/radar?hours=${hours}`),
  tapeAudit: (days: number) => get<TapeAuditView>(`/tape-audit?days=${days}`),
  scannerDuplicates: () => get<DuplicateGroup[]>('/scanners/duplicates'),
  lockStudy: (days: number) => get<LockStudyView>(`/research/lock?days=${days}`),
  runHealth: (hours: number) => get<RunHealthRow[]>(`/scanners/run-health?hours=${hours}`),
  incubatorOverlap: (days: number) => get<OverlapCluster[]>(`/incubator/overlap?days=${days}`),
  incubatorDecide: (v: { id: number; action: 'approve' | 'reject' | 'demote'; note?: string }) => post<IncubatorPair>(`/incubator/${v.id}/${v.action}`, v.note ? { note: v.note } : {}),
  incubatorEvaluate: () => post<{ report: unknown }>('/incubator/evaluate'),
  screenQueue: () => get<ScreenQueueView>('/incubator/screen'),
  screenNow: (body: { ids?: string[]; author?: string; family?: string; tf: string; markets?: string[] }) => post<ScreenJob>('/incubator/screen', body),
  screenCancel: (id: string) => del<ScreenJob>(`/incubator/screen/${encodeURIComponent(id)}`),
  users: () => get<{ users: Me[]; roles: RoleOption[] }>('/users'),
  createUser: (body: { username: string; password: string; role: Role; displayName?: string }) => post<{ user: Me }>('/users', body),
  updateUser: (id: number, body: Partial<{ role: Role; displayName: string; disabled: boolean; password: string }>) => post<{ user: Me }>(`/users/${id}`, body),
  deleteUser: (id: number) => del<{ ok: true }>(`/users/${id}`),
  revokeSessions: (id: number) => post<{ ok: true }>(`/users/${id}/sessions/revoke`),
  shareLinks: () => get<{ links: ShareLink[]; maxHours: number }>('/share'),
  createShareLink: (body: { label: string; hours: number }) => post<{ link: ShareLink; url: string }>('/share', body),
  revokeShareLink: (id: number) => del<{ link: ShareLink }>(`/share/${id}`),

  scanners: () => get<Scanner[]>('/scanners'),
  scannerContributions: () => get<Contributions>('/scanners/contributions'),
  scannerContribution: (id:string) => get<ContributionDetail>(`/scanners/${encodeURIComponent(id)}/contribution`),
  /** id/name/status/category/enabled/hidden only — the full list carries per-scanner stats for ~2000 scripts. */
  scannerIndex: () => get<ScannerIndexEntry[]>('/scanners?view=lite'),
  updateScanner: (id: string, body: ScannerUpdate) => post<Scanner>(`/scanners/${encodeURIComponent(id)}`, body),
  runScanner: (id: string) => post<{ queued: number }>(`/scanners/${encodeURIComponent(id)}/run`),
  releaseScanner: (id: string) => post<{ released: boolean }>(`/scanners/${encodeURIComponent(id)}/release`),
  profileScanner: (id: string, body: { market?: string; tfs?: string[] } = {}) => post<{ rows: ProfileRow[] }>(`/scanners/${encodeURIComponent(id)}/profile`, body),
  scannerProfile: (id: string) => get<{ rows: ProfileRow[] }>(`/scanners/${encodeURIComponent(id)}/profile`),
  scannerSource: (id: string) => get<ScannerSource>(`/scanners/${encodeURIComponent(id)}/source`),
  // decision 153: the Library
  library: () => get<LibraryList>('/library'),
  libraryDetail: (id: string) => get<LibraryDetail>(`/library/${encodeURIComponent(id)}`),
  libraryFavorite: (b: { id: string; on: boolean }) => post<{ favorites: string[] }>('/library/favorites', b),
  scannerOverlay: (id: string, symbol: string, tf: string) =>
    get<ScannerOverlay>(`/scanners/${encodeURIComponent(id)}/overlay${qs({ symbol, tf })}`),

  // signals / positions / trades
  signals: (q: SignalQuery = {}) => get<Signal[]>(`/signals${qs(q)}`),
  positions: () => get<Position[]>('/positions'),
  closePosition: (id: number) => post<unknown>(`/positions/${id}/close`),
  closeAll: () => post<unknown>('/paper/close-all'),
  trades: (q: TradeQuery = {}) => get<Trade[]>(`/trades${qs(q)}`),
  tradesPage: (q: TradeQuery = {}) => get<TradePage>(`/trades/page${qs(q)}`),
  positionPath: (id: number) => get<{ position: PathLevels; path: PathPoint[] }>(`/positions/${id}/path`),
  orders: (limit = 200) => get<Order[]>(`/orders${qs({ limit })}`),
  stats: () => get<Stats>('/stats'),
  equity: (scanner?: string, limit = 2000) => get<EquityPoint[]>(`/equity${qs({ scanner, limit })}`),
  resetPaper: () => post<unknown>('/paper/reset'),

  // backtest
  backtest: (scanner: string, symbol: string, tf: string) =>
    get<BacktestResult>(`/backtest${qs({ scanner, symbol, tf })}`),
  runBacktest: (scanner: string, symbol: string, tf: string) =>
    post<BacktestResult>('/backtest/run', { scanner, symbol, tf }),

  // logs
  logs: (limit = 200, level?: LogLevel) => get<LogEntry[]>(`/logs${qs({ limit, level })}`),
  autoTune: () => post<{ tuned: number; disabled: number; report: Array<{ id: string; name: string; before: string[]; after: string[]; disabled: boolean }> }>('/scanners/auto-tune'),
  executionPlans: () => get<ExecutionPlansView>('/execution-plans'),
  decisionTrace: () => get<Array<{id:number;at:number;symbol:string;tf:string;scanner_id:string;stage:string;reason:string|null;signal_id:number|null;position_id:number|null;snapshot:{risk?:number;notional?:number;entryFee?:number;standardExitFeeAtEntry?:number;offerConfigured?:boolean;offerEligibility?:string;breakEvenPrice?:number;entryLiquidity?:string}}>>('/decision-trace'),
  scannerPipeline: () => get<{at:number;since:number;entryDepth:{enabled:boolean;requests:number;checks:number;blocked:number;errors:number;inFlight:number;queued:number};quarantined:number;unallocated:Array<{id:string;name:string}>;shadowDispatch:{evidenceTurns?:number;fairTurns?:number;pending:number;inFlight:number;offered:number;replaced:number;expired:number;finished:number;maxWaitMs:number};queue:{queued:number;queuedLive:number;queuedMirror:number;queuedShadow:number};cells:Array<{scannerId:string;symbol:string;tf:string;lastRun:number|null;error:string|null;runs:number;failures:number;entries24h:number;actions:Array<{action:string;n:number}>;latest:{at:number;action:string;label:string}|null}>}>('/scanner-pipeline'),
  fundingGuard: () => get<{at:number;executionSupported:boolean;settings?:{enabled:boolean;leadMinutes:number;scalpMaxR:number;swingMaxR:number};positions:Array<{id:number;book:string;symbol:string;tf:string;side:string;fresh:boolean;cost:number|null;costR:number|null;limitR:number;nextAt:number|null;ratePct:number|null;near:boolean;trigger:boolean;enabled:boolean}>}>('/funding-guard'),
  allocationAudit: () => get<AllocationAudit>('/analytics/allocations'),
  analytics: () => get<Analytics>('/analytics'),
  performance: (q: import('./types').PerformanceFilter) => get<import('./types').PerformanceReport>(`/analytics/performance${qs(q)}`),
  dailyReport: (days = 30) => get<DailyRow[]>(`/reports/daily?days=${days}`),
  reclaimTrials: () => get<ReclaimTrialsView>('/reclaim-trials'),
  trackers: () => get<TrackerView[]>('/trackers'),
  learning: () => get<Learning>('/learning'),
  ml: () => get<MlSnapshot>('/ml'),
  mlTrain: () => post<MlSnapshot>('/ml/train'),
  mlYardstick: (days = 60) => get<MlYardstick>(`/ml/yardstick?days=${days}`),
  mlScanner: (id: string) => get<MlScannerInsight>(`/ml/scanner/${id}`),
}

export type Api = typeof api
