import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api/client'
import { useAuth, ROLE_HELP } from '../auth/AuthGate'
import { PageTitle, Panel, Pill } from '../components/ui'

/** Your own account: who you are, what you may do, and how to change your password. */
export default function Profile() {
  const auth = useAuth()
  const [displayName, setDisplayName] = useState(auth.user.displayName)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')

  const saveName = useMutation({ mutationFn: api.updateProfile, onSuccess: () => auth.refresh() })
  const changePassword = useMutation({
    mutationFn: api.changePassword,
    onSuccess: () => { setCurrent(''); setNext(''); setConfirm(''); auth.refresh() },
  })
  const mismatch = confirm.length > 0 && confirm !== next

  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never')

  return (
    <>
      <PageTitle pre="Your account," accent="and what" post="it may do." sub="Profile details, access level and password." />

      <div className="cards-2">
        <Panel title="Account">
          <dl className="kv-list">
            <div><dt>Username</dt><dd className="mono">{auth.user.username}</dd></div>
            <div><dt>Access</dt><dd><Pill tone={auth.isAdmin ? 'accent' : auth.canTrade ? 'ok' : 'neutral'}>{auth.user.roleLabel}</Pill></dd></div>
            <div><dt>Member since</dt><dd>{fmt(auth.user.createdAt)}</dd></div>
            <div><dt>Last sign-in</dt><dd>{fmt(auth.user.lastLoginAt)}</dd></div>
            <div><dt>Active sessions</dt><dd className="mono">{auth.sessions}</dd></div>
          </dl>
          <p className="muted small mt">{ROLE_HELP[auth.user.role]}</p>
          <p className="muted small">
            Permissions held: <span className="mono">{auth.permissions.join(', ')}</span>. Only an administrator can change
            your access level.
          </p>
        </Panel>

        <Panel title="Display name">
          <form
            onSubmit={(e) => { e.preventDefault(); saveName.mutate({ displayName: displayName.trim() }) }}
          >
            <label className="auth-field">
              <span>Shown instead of your username</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
            </label>
            {saveName.isError && <div className="auth-error" role="alert">{(saveName.error as Error).message}</div>}
            {saveName.isSuccess && <div className="muted small">Saved.</div>}
            <button className="btn mt" type="submit" disabled={saveName.isPending || displayName.trim() === auth.user.displayName}>
              {saveName.isPending ? 'Saving…' : 'Save'}
            </button>
          </form>
        </Panel>
      </div>

      <Panel title="Change password">
        <form
          className="form-narrow"
          onSubmit={(e) => { e.preventDefault(); if (!mismatch) changePassword.mutate({ current, next }) }}
        >
          <label className="auth-field">
            <span>Current password</span>
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label className="auth-field">
            <span>New password</span>
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            <span className="muted small">At least 10 characters, and not all digits.</span>
          </label>
          <label className="auth-field">
            <span>Confirm new password</span>
            <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          {mismatch && <div className="auth-error" role="alert">The two passwords do not match.</div>}
          {changePassword.isError && <div className="auth-error" role="alert">{(changePassword.error as Error).message}</div>}
          {changePassword.isSuccess && <div className="muted small">Password changed. Your other sessions were signed out.</div>}
          <button className="btn btn-primary mt" type="submit" disabled={changePassword.isPending || mismatch || !current || !next}>
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </button>
          <p className="muted small mt">Changing your password signs out every other browser you are signed in on.</p>
        </form>
      </Panel>
    </>
  )
}
