import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
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
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="scanners" element={<Scanners />} />
          <Route path="scanners/:id" element={<ScannerDetail />} />
          <Route path="signals" element={<Signals />} />
          <Route path="trades" element={<Trades />} />
          <Route path="chart" element={<ChartPage />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="learn" element={<Learn />} />
          <Route path="settings" element={<Settings />} />
          <Route path="logs" element={<Logs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
