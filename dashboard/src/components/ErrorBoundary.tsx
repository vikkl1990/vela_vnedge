import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

interface Props {
  children: ReactNode
  /** Changing this resets the boundary (we pass the route path). */
  resetKey?: string
}
interface State {
  error: Error | null
}

/** Catches render errors below it and shows a recoverable card instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="error-card" role="alert">
        <div className="error-card-title">Something broke on this page</div>
        <div className="error-card-msg mono">{error.message || String(error)}</div>
        <div className="row gap">
          <button className="btn btn-sm btn-primary" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
          <button className="btn btn-sm" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    )
  }
}

/** Per-route boundary: navigating to another page clears the error automatically. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation()
  return <ErrorBoundary resetKey={loc.pathname}>{children}</ErrorBoundary>
}
