import { BookProvider } from './lib/bookScope'
import { lazy, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthGate, useAuth } from './auth/AuthGate'
import { Layout } from './components/Layout'
import { Terminal } from './pages/Terminal'

/**
 * Every page except the landing one (the trading workspace) loads on first visit, so the first paint ships the shell and the workspace instead of
 * the chart engine, the Pine runtime and twenty pages nobody opened. The Layout wraps the outlet in <Suspense>.
 */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType })))
}
function pageDefault(load: () => Promise<{ default: ComponentType }>) {
  return lazy(load)
}
const Profile = pageDefault(() => import('./pages/Profile'))
const Users = pageDefault(() => import('./pages/Users'))
const Incubator = pageDefault(() => import('./pages/Incubator'))
const Radar = pageDefault(() => import('./pages/Radar'))
const Overview = page(() => import('./pages/Overview'), 'Overview')
const Strategies = page(() => import('./pages/Strategies'), 'Strategies')
const Lab = page(() => import('./pages/Lab'), 'Lab')
const Live = page(() => import('./pages/Live'), 'Live')
const Decisions = page(() => import('./pages/Decisions'), 'Decisions')
const ChartPage = page(() => import('./pages/ChartPage'), 'ChartPage')
const Analytics = page(() => import('./pages/Analytics'), 'Analytics')
const Daily = page(() => import('./pages/Daily'), 'Daily')
const Trackers = page(() => import('./pages/Trackers'), 'Trackers')
const Library = page(() => import('./pages/Library'), 'Library')
const TradeReplay = page(() => import('./pages/TradeReplay'), 'TradeReplay')
const Learn = page(() => import('./pages/Learn'), 'Learn')
const Logs = page(() => import('./pages/Logs'), 'Logs')
const ScannerDetail = page(() => import('./pages/ScannerDetail'), 'ScannerDetail')
const Scanners = page(() => import('./pages/Scanners'), 'Scanners')
const Settings = page(() => import('./pages/Settings'), 'Settings')
const Signals = page(() => import('./pages/Signals'), 'Signals')
const Trades = page(() => import('./pages/Trades'), 'Trades')
const Exchange = page(() => import('./pages/Exchange'), 'Exchange')
const Gates = page(() => import('./pages/Gates'), 'Gates')
const TradeMonitor = page(() => import('./pages/TradeMonitor'), 'TradeMonitor')

export default function App() {
  return (
    <BrowserRouter>
      <BookProvider>
      <AuthGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Terminal />} />
          <Route path="overview" element={<Overview />} />
          <Route path="strategies" element={<Strategies />} />
          <Route path="lab" element={<Lab />} />
          <Route path="live" element={<Live />} />
          <Route path="scanners" element={<Scanners />} />
          <Route path="scanners/:id" element={<ScannerDetail />} />
          <Route path="signals" element={<Signals />} />
          <Route path="radar" element={<Radar />} />
          <Route path="monitor" element={<TradeMonitor />} />
          <Route path="trades" element={<Trades />} />
          <Route path="trades/:id/replay" element={<TradeReplay />} />
          <Route path="chart" element={<ChartPage />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="daily" element={<Daily />} />
          <Route path="trackers" element={<Trackers />} />
          <Route path="library" element={<Library />} />
          <Route path="incubator" element={<Incubator />} />
          <Route path="decisions" element={<Decisions />} />
          <Route path="gates" element={<Gates />} />
          <Route path="learn" element={<Learn />} />
          <Route path="settings" element={<Settings />} />
          <Route path="exchange" element={<Exchange />} />
          <Route path="logs" element={<Logs />} />
          <Route path="profile" element={<Profile />} />
          <Route path="users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </AuthGate>
    </BookProvider>
    </BrowserRouter>
  )
}

/** Administration is server-enforced; this only keeps the page out of the way for everyone else. */
function AdminOnly({ children }: { children: ReactNode }) {
  const auth = useAuth()
  return auth.isAdmin ? <>{children}</> : <Navigate to="/profile" replace />
}
