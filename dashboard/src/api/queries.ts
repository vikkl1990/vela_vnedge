import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { api, ApiError } from './client'
import type { ConfigPatch, LogLevel, ScannerUpdate, SignalQuery, TradeQuery } from './types'

/** Query keys — SSE handlers invalidate by these prefixes. */
export const qk = {
  health: ['health'] as const,
  config: ['config'] as const,
  markets: ['markets'] as const,
  scanners: ['scanners'] as const,
  scannerIndex: ['scanners', 'index'] as const,
  scannerSource: (id: string) => ['scanners', 'source', id] as const,
  scannerOverlay: (id: string, symbol: string, tf: string) => ['scanners', 'overlay', id, symbol, tf] as const,
  signals: (q: SignalQuery = {}) => ['signals', q] as const,
  positions: ['positions'] as const,
  trades: (q: TradeQuery = {}) => ['trades', q] as const,
  orders: ['orders'] as const,
  stats: ['stats'] as const,
  equity: (scanner?: string) => ['equity', scanner ?? 'global'] as const,
  backtest: (scanner: string, symbol: string, tf: string) => ['backtest', scanner, symbol, tf] as const,
  logs: (level?: LogLevel) => ['logs', level ?? 'all'] as const,
  ml: ['ml'] as const,
  analytics: ['analytics'] as const,
  mlScanner: (id: string) => ['ml', id] as const,
  candles: (symbol: string, tf: string) => ['candles', symbol, tf] as const,
}

type Opts<T> = Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>

/** Portfolio risk state: halts, loss limits, drawdown scaling. */
export function useRisk() {
  return useQuery({ queryKey: ['risk'], queryFn: api.risk, refetchInterval: 20_000, retry: false })
}

/** Exchange mirroring: mode, protective orders in place, last reconciliation. */
export function useExecution() {
  return useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000, retry: false })
}

export function useHealth() {
  return useQuery<ReturnType<typeof api.health> extends Promise<infer T> ? T : never, ApiError>({
    queryKey: qk.health,
    queryFn: api.health,
    refetchInterval: 15_000,
    retry: false,
  })
}

/** True when the backend answered health within the last attempts. */
export function useBackendOnline(): { online: boolean; error: ApiError | null; checked: boolean } {
  const h = useHealth()
  return { online: !h.isError && !!h.data, error: h.error ?? null, checked: h.isFetched }
}

/*
 * staleTime policy: SSE keeps these caches fresh (setQueryData / debounced
 * invalidation), so remounting a page must not trigger a refetch storm.
 * Anything not pushed over SSE (markets, config) refreshes on a slow interval.
 */
const LIVE_STALE = 30_000

export const useConfig = () => useQuery({ queryKey: qk.config, queryFn: api.config, staleTime: 60_000, retry: 1 })
export const useMarkets = () =>
  useQuery({ queryKey: qk.markets, queryFn: api.markets, staleTime: 5 * 60_000, refetchInterval: 5 * 60_000, retry: 1 })
export const useScanners = (opts?: Opts<Awaited<ReturnType<typeof api.scanners>>>) =>
  useQuery({ queryKey: qk.scanners, queryFn: api.scanners, staleTime: LIVE_STALE, retry: 1, ...opts })
/**
 * Name/status lookup for headers, dropdowns and pickers. Same rows as `useScanners`, without the
 * per-scanner statistics and symbol lists that make the full response ~100x larger.
 */
export const useScannerIndex = (opts?: Opts<Awaited<ReturnType<typeof api.scannerIndex>>>) =>
  useQuery({ queryKey: qk.scannerIndex, queryFn: api.scannerIndex, staleTime: LIVE_STALE, retry: 1, ...opts })
export const useScannerSource = (id: string | undefined) =>
  useQuery({
    queryKey: qk.scannerSource(id ?? ''),
    queryFn: () => api.scannerSource(id!),
    enabled: !!id,
    staleTime: 5 * 60_000,
    retry: 1,
  })
export const useScannerOverlay = (id: string | undefined, symbol: string, tf: string, enabled = true) =>
  useQuery({
    queryKey: qk.scannerOverlay(id ?? '', symbol, tf),
    queryFn: () => api.scannerOverlay(id!, symbol, tf),
    enabled: !!id && enabled,
    retry: 0,
  })
export const useSignals = (q: SignalQuery = {}) =>
  useQuery({ queryKey: qk.signals(q), queryFn: () => api.signals(q), staleTime: LIVE_STALE, retry: 1 })
export const usePositions = () =>
  useQuery({ queryKey: qk.positions, queryFn: api.positions, staleTime: LIVE_STALE, refetchInterval: 60_000, retry: 1 })
export const useTrades = (q: TradeQuery = {}) =>
  useQuery({ queryKey: qk.trades(q), queryFn: () => api.trades(q), staleTime: LIVE_STALE, retry: 1 })
export const useOrders = (limit = 200) =>
  useQuery({ queryKey: qk.orders, queryFn: () => api.orders(limit), staleTime: LIVE_STALE, retry: 1 })
export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: api.stats, staleTime: LIVE_STALE, refetchInterval: 60_000, retry: 1 })
export const useEquity = (scanner?: string) =>
  useQuery({ queryKey: qk.equity(scanner), queryFn: () => api.equity(scanner), staleTime: LIVE_STALE, retry: 1 })
export const useBacktest = (scanner: string | undefined, symbol: string, tf: string) =>
  useQuery({
    queryKey: qk.backtest(scanner ?? '', symbol, tf),
    queryFn: () => api.backtest(scanner!, symbol, tf),
    enabled: !!scanner && !!symbol && !!tf,
    retry: 0,
  })
export const useLogs = (level?: LogLevel, limit = 300) =>
  useQuery({ queryKey: qk.logs(level), queryFn: () => api.logs(limit, level), staleTime: LIVE_STALE, retry: 1 })
export const useCandles = (symbol: string, tf: string, limit = 500) =>
  useQuery({
    queryKey: qk.candles(symbol, tf),
    queryFn: () => api.candles({ symbol, tf, limit }),
    enabled: !!symbol && !!tf,
    retry: 1,
  })

// ---------- mutations ----------

export function useUpdateScanner() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ScannerUpdate }) => api.updateScanner(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.scanners })  // prefix match also covers qk.scannerIndex
      void qc.invalidateQueries({ queryKey: qk.config })
    },
  })
}

export function useRunScanner() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.runScanner(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.scanners })  // prefix match also covers qk.scannerIndex,
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: ConfigPatch) => api.updateConfig(patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.config, data)
      void qc.invalidateQueries({ queryKey: qk.scanners })  // prefix match also covers qk.scannerIndex
    },
  })
}

export function useClosePosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.closePosition(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.positions })
      void qc.invalidateQueries({ queryKey: ['trades'] })
      void qc.invalidateQueries({ queryKey: qk.stats })
    },
  })
}

export function useCloseAll() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.closeAll(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.positions })
      void qc.invalidateQueries({ queryKey: ['trades'] })
      void qc.invalidateQueries({ queryKey: qk.orders })
      void qc.invalidateQueries({ queryKey: qk.stats })
    },
  })
}

export function useResetPaper() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.resetPaper(),
    onSuccess: () => void qc.invalidateQueries(),
  })
}

export function useRunBacktest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ scanner, symbol, tf }: { scanner: string; symbol: string; tf: string }) =>
      api.runBacktest(scanner, symbol, tf),
    onSuccess: (data, v) => qc.setQueryData(qk.backtest(v.scanner, v.symbol, v.tf), data),
  })
}

export const useMl = () => useQuery({ queryKey: qk.ml, queryFn: api.ml, staleTime: 60_000, retry: 1, refetchInterval: 60_000 })
export const useMlScanner = (id: string) =>
  useQuery({ queryKey: qk.mlScanner(id), queryFn: () => api.mlScanner(id), enabled: !!id, staleTime: 60_000, retry: 1 })
export const useAnalytics = () =>
  useQuery({ queryKey: qk.analytics, queryFn: api.analytics, staleTime: LIVE_STALE, retry: 1, refetchInterval: 60_000 })
