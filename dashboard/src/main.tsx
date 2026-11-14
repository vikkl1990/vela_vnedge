import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/kit.css'
import './styles/polish.css'
import './styles/pages.css'
import './terminal.css'
import { DensityProvider } from './lib/density'
import { ThemeProvider } from './lib/theme'
import { ToastProvider } from './lib/toast'
import { SSEProvider } from './sse/SSEProvider'

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
