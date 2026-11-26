import { lazy, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthGate, useAuth } from './auth/AuthGate'
import { Layout } from './components/Layout'
import { BookProvider } from './lib/bookScope'
import { canonicalPath, HUB_ROUTES } from './lib/routeHubs'
import { Trading } from './pages/Trading'

/**
 * Every page except the landing one (the trading overview) loads on first visit, so the first paint ships the shell and the overview instead of
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
const Terminal = page(() => import('./pages/Terminal'), 'Terminal')
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
              <Route index element={<Trading />} />
              <Route path="workspace" element={<Terminal />} />
              <Route path="overview" element={<Overview />} />
              <Route path="strategies" element={<Strategies />} />
              <Route path="lab" element={<Lab />} />
              <Route path="live" element={<Live />} />
              <Route path="strategies/scanners" element={<Scanners />} />
              <Route path="strategies/scanners/:id" element={<ScannerDetail />} />
              <Route path="signals" element={<Signals />} />
              <Route path="signals/radar" element={<Radar />} />
              <Route path="monitor" element={<TradeMonitor />} />
              <Route path="trades" element={<Trades />} />
              <Route path="trades/:id/replay" element={<TradeReplay />} />
              <Route path="chart" element={<ChartPage />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="analytics/daily" element={<Daily />} />
              <Route path="strategies/trackers" element={<Trackers />} />
              <Route path="strategies/library" element={<Library />} />
              <Route path="strategies/incubator" element={<Incubator />} />
              <Route path="strategies/decisions" element={<Decisions />} />
              <Route path="signals/gates" element={<Gates />} />
              <Route path="lab/learn" element={<Learn />} />
              <Route path="settings" element={<Settings />} />
              <Route path="exchange" element={<Exchange />} />
              <Route path="settings/logs" element={<Logs />} />
              <Route path="profile" element={<Profile />} />
              <Route
                path="users"
                element={
                  <AdminOnly>
                    <Users />
                  </AdminOnly>
                }
              />
              {Object.keys(HUB_ROUTES).map((path) => (
                <Route key={path} path={`${path.slice(1)}/*`} element={<LegacyRedirect />} />
              ))}
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

function LegacyRedirect() {
  const location = useLocation()
  return (
    <Navigate
      replace
      to={{ pathname: canonicalPath(location.pathname), search: location.search, hash: location.hash }}
    />
  )
}
