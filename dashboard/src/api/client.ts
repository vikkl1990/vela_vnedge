import type {
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
  TradeQuery, MlSnapshot, MlScannerInsight, Analytics, AuthStatus, Me, Session, Role, RoleOption } from './types'

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
  // health / config
  health: () => get<Health>('/health'),
  config: () => get<Config>('/config'),
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
  execution: () => get<ExecutionStatus>('/execution'),

  // incubator
  incubator: () => get<IncubatorView>('/incubator'),
  incubatorDecide: (v: { id: number; action: 'approve' | 'reject'; note?: string }) => post<IncubatorPair>(`/incubator/${v.id}/${v.action}`, v.note ? { note: v.note } : {}),
  incubatorEvaluate: () => post<{ report: unknown }>('/incubator/evaluate'),
  users: () => get<{ users: Me[]; roles: RoleOption[] }>('/users'),
  createUser: (body: { username: string; password: string; role: Role; displayName?: string }) => post<{ user: Me }>('/users', body),
  updateUser: (id: number, body: Partial<{ role: Role; displayName: string; disabled: boolean; password: string }>) => post<{ user: Me }>(`/users/${id}`, body),
  deleteUser: (id: number) => del<{ ok: true }>(`/users/${id}`),
  revokeSessions: (id: number) => post<{ ok: true }>(`/users/${id}/sessions/revoke`),

  scanners: () => get<Scanner[]>('/scanners'),
  /** id/name/status/category/enabled/hidden only — the full list carries per-scanner stats for ~2000 scripts. */
  scannerIndex: () => get<ScannerIndexEntry[]>('/scanners?view=lite'),
  updateScanner: (id: string, body: ScannerUpdate) => post<Scanner>(`/scanners/${encodeURIComponent(id)}`, body),
  runScanner: (id: string) => post<{ queued: number }>(`/scanners/${encodeURIComponent(id)}/run`),
  scannerSource: (id: string) => get<ScannerSource>(`/scanners/${encodeURIComponent(id)}/source`),
  scannerOverlay: (id: string, symbol: string, tf: string) =>
    get<ScannerOverlay>(`/scanners/${encodeURIComponent(id)}/overlay${qs({ symbol, tf })}`),

  // signals / positions / trades
  signals: (q: SignalQuery = {}) => get<Signal[]>(`/signals${qs(q)}`),
  positions: () => get<Position[]>('/positions'),
  closePosition: (id: number) => post<unknown>(`/positions/${id}/close`),
  closeAll: () => post<unknown>('/paper/close-all'),
  trades: (q: TradeQuery = {}) => get<Trade[]>(`/trades${qs(q)}`),
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
  analytics: () => get<Analytics>('/analytics'),
  ml: () => get<MlSnapshot>('/ml'),
  mlTrain: () => post<MlSnapshot>('/ml/train'),
  mlScanner: (id: string) => get<MlScannerInsight>(`/ml/scanner/${id}`),
}

export type Api = typeof api
