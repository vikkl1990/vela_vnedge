/**
 * Decides whether to show the application, the sign-in form, or first-run setup.
 *
 * The permissions it exposes are a copy of what the server decided. They drive what the UI
 * offers, never what it is allowed to do: every route is checked again on the server, so a
 * disabled button is a courtesy rather than a control.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api/client'
import type { Me, Permission, Role } from '../api/types'

interface AuthValue {
  user: Me
  permissions: Permission[]
  sessions: number
  can: (p: Permission) => boolean
  isAdmin: boolean
  canTrade: boolean
  signOut: () => void
  refresh: () => void
}

const Ctx = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthGate')
  return v
}

/** Convenience for the common case: "may this user change what the bot does?" */
export function useCanTrade(): boolean {
  return useContext(Ctx)?.canTrade ?? false
}

export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: api.authStatus, retry: 1, staleTime: 30_000 })
  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: api.me,
    retry: (count, e) => !(e instanceof ApiError && e.status === 401) && count < 1,
    staleTime: 60_000,
  })

  const signOut = useCallback(() => {
    void api.logout().finally(() => {
      qc.clear()
      void qc.invalidateQueries()
    })
  }, [qc])

  const value = useMemo<AuthValue | null>(() => {
    if (!me.data) return null
    const permissions = me.data.permissions
    return {
      user: me.data.user,
      permissions,
      sessions: me.data.sessions,
      can: (p: Permission) => permissions.includes(p),
      isAdmin: permissions.includes('admin'),
      canTrade: permissions.includes('trade'),
      signOut,
      refresh: () => void qc.invalidateQueries({ queryKey: ['auth'] }),
    }
  }, [me.data, qc, signOut])

  if (me.isLoading || status.isLoading) {
    return <Splash>Checking your session…</Splash>
  }
  if (status.data && !status.data.configured) {
    return <SetupForm canSetup={status.data.canSetup} onDone={() => void qc.invalidateQueries({ queryKey: ['auth'] })} />
  }
  if (!value) {
    return <SignInForm onDone={() => void qc.invalidateQueries({ queryKey: ['auth'] })} />
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">VNEdge</div>
        <p className="muted">{children}</p>
      </div>
    </div>
  )
}

function SignInForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({ mutationFn: api.login, onSuccess: onDone })

  return (
    <div className="auth-shell">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault()
          login.mutate({ username: username.trim(), password })
        }}
      >
        <div className="auth-brand">VNEdge</div>
        <h1 className="auth-title">Sign in</h1>
        <p className="muted small">Paper-trading control panel. Access is per account.</p>

        <label className="auth-field">
          <span>Username</span>
          <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>

        {login.isError && <div className="auth-error" role="alert">{(login.error as Error).message}</div>}

        <button className="btn btn-primary auth-submit" type="submit" disabled={login.isPending || !username || !password}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

function SetupForm({ canSetup, onDone }: { canSetup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const setup = useMutation({ mutationFn: api.setup, onSuccess: onDone })
  const mismatch = confirm.length > 0 && confirm !== password

  if (!canSetup) {
    return (
      <Splash>
        This instance has no accounts yet. The first administrator must be created from the server itself, so open the
        dashboard over an SSH tunnel to <code>127.0.0.1</code> and reload.
      </Splash>
    )
  }

  return (
    <div className="auth-shell">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!mismatch) setup.mutate({ username: username.trim(), password })
        }}
      >
        <div className="auth-brand">VNEdge</div>
        <h1 className="auth-title">Create the first administrator</h1>
        <p className="muted small">
          Nobody can sign in yet. This account will be able to trade and to manage every other account.
        </p>

        <label className="auth-field">
          <span>Username</span>
          <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <span className="muted small">At least 10 characters.</span>
        </label>
        <label className="auth-field">
          <span>Confirm password</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>

        {mismatch && <div className="auth-error" role="alert">The two passwords do not match.</div>}
        {setup.isError && <div className="auth-error" role="alert">{(setup.error as Error).message}</div>}

        <button className="btn btn-primary auth-submit" type="submit" disabled={setup.isPending || mismatch || !username || !password}>
          {setup.isPending ? 'Creating…' : 'Create administrator'}
        </button>
      </form>
    </div>
  )
}

export const ROLE_HELP: Record<Role, string> = {
  viewer: 'Reads everything and runs backtests and validation. Cannot trade or change settings.',
  trader: 'Everything a backtest account can do, plus trading, scanner changes and settings.',
  admin: 'Everything, plus creating accounts and changing what each one may do.',
}
