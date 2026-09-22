import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthGate, useAuth } from './auth/AuthGate'
import { Layout } from './components/Layout'
import Profile from './pages/Profile'
import Users from './pages/Users'
import Incubator from './pages/Incubator'
import { ChartPage } from './pages/ChartPage'
import { Analytics } from './pages/Analytics'
import { Learn } from './pages/Learn'
import { Logs } from './pages/Logs'
import { Overview } from './pages/Overview'
import { ScannerDetail } from './pages/ScannerDetail'
import { Scanners } from './pages/Scanners'
import { Settings } from './pages/Settings'
import { Signals } from './pages/Signals'
import { Trades } from './pages/Trades'

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="scanners" element={<Scanners />} />
          <Route path="scanners/:id" element={<ScannerDetail />} />
          <Route path="signals" element={<Signals />} />
          <Route path="trades" element={<Trades />} />
          <Route path="chart" element={<ChartPage />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="incubator" element={<Incubator />} />
          <Route path="learn" element={<Learn />} />
          <Route path="settings" element={<Settings />} />
          <Route path="logs" element={<Logs />} />
          <Route path="profile" element={<Profile />} />
          <Route path="users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}

/** Administration is server-enforced; this only keeps the page out of the way for everyone else. */
function AdminOnly({ children }: { children: ReactNode }) {
  const auth = useAuth()
  return auth.isAdmin ? <>{children}</> : <Navigate to="/profile" replace />
}
