import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { ROLE_HELP, useAuth } from '../auth/AuthGate'
import { Callout, PageHeader, Pill, Section, Stat, StatGrid } from '../components/kit'

import '../styles/pages/account.css'

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
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      auth.refresh()
    },
  })
  const mismatch = confirm.length > 0 && confirm !== next

  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never')

  return (
    <div className="page account-page">
      <PageHeader
        title="Profile"
        subtitle="Who you are signed in as, what you may do, and how to change your password."
        meta={
          <Pill tone={auth.isAdmin ? 'accent' : auth.canTrade ? 'ok' : 'neutral'}>{auth.user.roleLabel}</Pill>
        }
      />

      <StatGrid min={190}>
        <Stat
          label="Signed in as"
          value={<span className="account-stat-text">{auth.user.displayName || auth.user.username}</span>}
          sub={<span className="mono">{auth.user.username}</span>}
        />
        <Stat
          label="Access"
          value={<span className="account-stat-text">{auth.user.roleLabel}</span>}
          sub={`${auth.permissions.length} permission${auth.permissions.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="Last sign-in"
          value={<span className="account-stat-text">{fmt(auth.user.lastLoginAt)}</span>}
          sub={`Member since ${fmt(auth.user.createdAt)}`}
        />
        <Stat label="Active sessions" value={auth.sessions} sub="browsers signed in as you" />
      </StatGrid>

      <div className="account-grid">
        <Section variant="panel" title="What you may do">
          <p className="account-lead">{ROLE_HELP[auth.user.role]}</p>
          <div className="cluster" role="list" aria-label="Permissions you hold">
            {auth.permissions.map((p) => (
              <span role="listitem" key={p}>
                <Pill tone="accent">{p}</Pill>
              </span>
            ))}
          </div>
          <p className="muted small mt">Only an administrator can change your access level.</p>
        </Section>

        <Section variant="panel" title="Display name">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              saveName.mutate({ displayName: displayName.trim() })
            }}
          >
            <label className="auth-field">
              <span>Shown instead of your username</span>
              <input
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
              />
            </label>
            {saveName.isError && <Callout tone="danger">{(saveName.error as Error).message}</Callout>}
            {saveName.isSuccess && (
              <p className="muted small" role="status">
                Saved.
              </p>
            )}
            <button
              className="btn mt"
              type="submit"
              disabled={saveName.isPending || displayName.trim() === auth.user.displayName}
            >
              {saveName.isPending ? 'Saving…' : 'Save'}
            </button>
          </form>
        </Section>

        <Section variant="panel" title="Change password" className="account-wide">
          <form
            className="form-narrow"
            onSubmit={(e) => {
              e.preventDefault()
              if (!mismatch) changePassword.mutate({ current, next })
            }}
          >
            <label className="auth-field">
              <span>Current password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </label>
            <label className="auth-field">
              <span>New password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                aria-describedby="pw-rule"
              />
              <span id="pw-rule" className="muted small">
                At least 10 characters, and not all digits.
              </span>
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                aria-invalid={mismatch}
              />
            </label>
            {mismatch && <Callout tone="danger">The two passwords do not match.</Callout>}
            {changePassword.isError && (
              <Callout tone="danger">{(changePassword.error as Error).message}</Callout>
            )}
            {changePassword.isSuccess && (
              <Callout tone="ok">Password changed. Your other sessions were signed out.</Callout>
            )}
            <div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={changePassword.isPending || mismatch || !current || !next}
              >
                {changePassword.isPending ? 'Changing…' : 'Change password'}
              </button>
            </div>
            <p className="muted small">
              Changing your password signs out every other browser you are signed in on.
            </p>
          </form>
        </Section>
      </div>
    </div>
  )
}
