import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DensityProvider } from './lib/density'
import { ThemeProvider } from './lib/theme'
import { ToastProvider } from './lib/toast'
import { SSEProvider } from './sse/SSEProvider'

// Preserve the cascade: tokens, shared controls, page refinements, then data-view overrides.
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/kit.css'
import './styles/polish.css'
import './styles/pages.css'
import './terminal.css'
import './styles/data-views.css'

// A tab opened before a deploy still holds the old index, whose lazy page files the new build has replaced: loading a
// page then fails on a missing file. Reload once to pick up the current build; the timestamp stops a reload loop
// if the file is missing for any other reason.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'vnedge.preloadReloadAt'
  let last = 0
  try {
    last = Number(sessionStorage.getItem(key) ?? 0)
  } catch {
    /* storage unavailable: still reload once per page life below */
  }
  if (Date.now() - last < 60_000) return
  try {
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    /* ignore */
  }
  event.preventDefault()
  window.location.reload()
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // SSE pushes fresh data into the cache; queries only refetch on explicit
      // (debounced) invalidation or when older than this on mount.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
      retryDelay: (n) => Math.min(8000, 1000 * 2 ** n),
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DensityProvider>
          <ToastProvider>
            <SSEProvider>
              <App />
            </SSEProvider>
          </ToastProvider>
        </DensityProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
