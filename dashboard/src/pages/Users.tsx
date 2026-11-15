import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { Me, Role, ShareLink } from '../api/types'
import { ROLE_HELP, useAuth } from '../auth/AuthGate'
import {
  Callout,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Pill,
  QueryState,
  Section,
  Stat,
  StatGrid,
  TabPanel,
  Tabs,
} from '../components/kit'

import '../styles/pages/account.css'

/** Administration: who has an account, and what each one is allowed to do. */
export default function Users() {
  const qc = useQueryClient()
  const auth = useAuth()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, staleTime: 15_000 })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] })

  const create = useMutation({ mutationFn: api.createUser, onSuccess: invalidate })
  const update = useMutation({
    mutationFn: (v: { id: number; body: Parameters<typeof api.updateUser>[1] }) =>
      api.updateUser(v.id, v.body),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: api.deleteUser, onSuccess: invalidate })
  const revoke = useMutation({ mutationFn: api.revokeSessions, onSuccess: invalidate })

  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    role: 'viewer' as Role,
    displayName: '',
  })
  const [confirmDelete, setConfirmDelete] = useState<Me | null>(null)
  const [resetting, setResetting] = useState<Me | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [tab, setTab] = useState<'accounts' | 'share'>('accounts')
  const [adding, setAdding] = useState(false)

  const roles = users.data?.roles ?? []
  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : '—')
  const tone = (r: Role) => (r === 'admin' ? 'accent' : r === 'trader' ? 'ok' : 'neutral')
  const share = useQuery({ queryKey: ['share'], queryFn: api.shareLinks, staleTime: 15_000 })
  const invalidateShare = () => void qc.invalidateQueries({ queryKey: ['share'] })
  const [newLink, setNewLink] = useState({ label: '', hours: 48 })
  const [minted, setMinted] = useState<{ url: string; link: ShareLink } | null>(null)
  const [now] = useState(() => Date.now())
  const mint = useMutation({
    mutationFn: api.createShareLink,
    onSuccess: (r) => {
      setMinted(r)
      invalidateShare()
    },
  })
  const unshare = useMutation({ mutationFn: api.revokeShareLink, onSuccess: invalidateShare })

  const userList = users.data?.users ?? []
  const admins = userList.filter((u) => u.role === 'admin' && !u.disabled).length
  const disabledN = userList.filter((u) => u.disabled).length
  const links = share.data?.links ?? []
  const liveLinks = links.filter((l) => !l.revokedAt && l.expiresAt > now).length

  return (
    <div className="page users-page">
      <PageHeader
        title="Users"
        subtitle="Who has an account, what each one may do, and the read-only links you have shared."
        actions={
          <button
            className="btn btn-primary"
            aria-expanded={adding}
            aria-controls="add-account"
            onClick={() => {
              setTab('accounts')
              setAdding((v) => !v)
            }}
          >
            {adding ? 'Close' : 'Add account'}
          </button>
        }
      />

      <StatGrid min={170}>
        <Stat
          label="Accounts"
          value={userList.length}
          sub={users.isLoading ? 'loading' : `${userList.length - disabledN} active`}
        />
        <Stat label="Administrators" value={admins} sub="the last one cannot be removed" />
        <Stat label="Disabled" value={disabledN} tone={disabledN ? 'warn' : undefined} sub="cannot sign in" />
        <Stat label="Live share links" value={liveLinks} sub={`${links.length} made in all`} />
      </StatGrid>

      <Tabs
        value={tab}
        onChange={setTab}
        idPrefix="usr"
        label="Users sections"
        items={[
          { id: 'accounts', label: 'Accounts', count: userList.length },
          { id: 'share', label: 'Share links', count: liveLinks },
        ]}
      />

      <TabPanel id="accounts" value={tab} idPrefix="usr">
        <div className="stack">
          {adding && (
            <Section
              variant="panel"
              title="Add an account"
              actions={
                <button className="btn btn-sm" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              }
            >
              <div id="add-account">
                <form
                  className="user-new"
                  onSubmit={(e) => {
                    e.preventDefault()
                    create.mutate(
                      {
                        ...newUser,
                        username: newUser.username.trim(),
                        displayName: newUser.displayName.trim() || undefined,
                      },
                      {
                        onSuccess: () => {
                          setNewUser({ username: '', password: '', role: 'viewer', displayName: '' })
                          setAdding(false)
                        },
                      },
                    )
                  }}
                >
                  <label className="auth-field">
                    <span>Username</span>
                    <input
                      className="input"
                      value={newUser.username}
                      onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>Display name</span>
                    <input
                      className="input"
                      value={newUser.displayName}
                      placeholder="optional"
                      onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                    />
                  </label>
                  <label className="auth-field">
                    <span>Temporary password</span>
                    <input
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                      required
                    />
                  </label>
                  <label className="auth-field">
                    <span>Access</span>
                    <select
                      className="select"
                      value={newUser.role}
                      onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}
                    >
                      {roles.map((r) => (
                        <option key={r.role} value={r.role}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={create.isPending || !newUser.username || !newUser.password}
                  >
                    {create.isPending ? 'Creating…' : 'Create account'}
                  </button>
                </form>
                {create.isError && <Callout tone="danger">{(create.error as Error).message}</Callout>}
                <p className="muted small mt">{ROLE_HELP[newUser.role]}</p>
              </div>
            </Section>
          )}

          <Section variant="panel" title="Accounts" pad={false}>
            <QueryState {...users} data={users.data} empty="No accounts." onRetry={() => users.refetch()}>
              {(d) =>
                d.users.length === 0 ? (
                  <EmptyState title="No accounts yet" hint="Use Add account to create the first one." />
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <caption className="sr-only">User accounts and their access levels</caption>
                      <thead>
                        <tr>
                          <th scope="col">User</th>
                          <th scope="col">Access</th>
                          <th scope="col">Created</th>
                          <th scope="col">Last sign-in</th>
                          <th scope="col">Status</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.users.map((u) => {
                          const isMe = u.id === auth.user.id
                          return (
                            <tr key={u.id}>
                              <td>
                                <strong>{u.displayName || u.username}</strong>
                                <div className="muted small mono">
                                  {u.username}
                                  {isMe ? ' · you' : ''}
                                </div>
                              </td>
                              <td>
                                <select
                                  className="select select-sm"
                                  aria-label={`Access level for ${u.username}`}
                                  value={u.role}
                                  disabled={update.isPending || isMe}
                                  title={
                                    isMe
                                      ? 'Change your own access from another administrator account'
                                      : ROLE_HELP[u.role]
                                  }
                                  onChange={(e) =>
                                    update.mutate({ id: u.id, body: { role: e.target.value as Role } })
                                  }
                                >
                                  {roles.map((r) => (
                                    <option key={r.role} value={r.role}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="mono small">{fmt(u.createdAt)}</td>
                              <td className="mono small">{fmt(u.lastLoginAt)}</td>
                              <td>
                                <Pill tone={u.disabled ? 'danger' : tone(u.role)}>
                                  {u.disabled ? 'Disabled' : 'Active'}
                                </Pill>
                              </td>
                              <td className="row-actions">
                                <button
                                  className="btn btn-sm"
                                  disabled={update.isPending || isMe}
                                  onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabled } })}
                                >
                                  {u.disabled ? 'Enable' : 'Disable'}
                                </button>
                                <button
                                  className="btn btn-sm"
                                  disabled={revoke.isPending}
                                  onClick={() => revoke.mutate(u.id)}
                                  title="Sign this account out everywhere"
                                >
                                  Sign out
                                </button>
                                <button
                                  className="btn btn-sm"
                                  onClick={() => {
                                    setResetting(u)
                                    setResetPassword('')
                                  }}
                                >
                                  Set password
                                </button>
                                <button
                                  className="btn btn-sm btn-danger"
                                  disabled={isMe}
                                  onClick={() => setConfirmDelete(u)}
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </QueryState>
          </Section>
          {(update.isError || remove.isError || revoke.isError) && (
            <Callout tone="danger">
              {((update.error ?? remove.error ?? revoke.error) as Error).message}
            </Callout>
          )}
          <p className="muted small">
            The server checks access on every request, so an account that may not trade cannot do so by any
            route, not only by hiding the buttons. The last administrator cannot be deleted, demoted or
            disabled.
          </p>
        </div>
      </TabPanel>

      <TabPanel id="share" value={tab} idPrefix="usr">
        <div className="stack">
          <Callout tone="info" title="Read-only, expiring, revocable">
            A link signs its visitor in as the read-only guest account: every page, no actions, not even a
            backtest. The link is shown once, when you make it. Revoking it ends every guest session.
            (Decision 117.)
          </Callout>
          <Section variant="panel" title="Make a link">
            <form
              className="share-form"
              onSubmit={(e) => {
                e.preventDefault()
                mint.mutate({ label: newLink.label.trim(), hours: newLink.hours })
              }}
            >
              <label>
                Label (who it is for)
                <input
                  className="input"
                  placeholder="for example, a reviewer"
                  value={newLink.label}
                  onChange={(e) => setNewLink({ ...newLink, label: e.target.value })}
                  maxLength={80}
                />
              </label>
              <label>
                Valid for (hours)
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={share.data?.maxHours ?? 336}
                  value={newLink.hours}
                  onChange={(e) => setNewLink({ ...newLink, hours: Number(e.target.value) })}
                  style={{ width: 110 }}
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={mint.isPending}>
                {mint.isPending ? 'Making…' : 'Make a link'}
              </button>
            </form>
            {mint.isError && <Callout tone="danger">{(mint.error as Error).message}</Callout>}
            {minted && (
              <Callout tone="warn" title={`Link for ${minted.link.label || 'unnamed'}`}>
                Valid until {fmt(minted.link.expiresAt)}. Copy it now; it will not be shown again.
                <span className="share-url">
                  <code className="mono small">{minted.url}</code>{' '}
                  <button
                    className="btn btn-xs"
                    onClick={() => void navigator.clipboard?.writeText(minted.url)}
                  >
                    Copy
                  </button>
                </span>
              </Callout>
            )}
          </Section>
          <Section variant="panel" title="Links made" pad={false}>
            {links.length === 0 ? (
              <EmptyState
                title="No share links"
                hint="Make one for a reviewer who needs to look but not touch."
              />
            ) : (
              <div className="table-wrap">
                <table className="table small">
                  <thead>
                    <tr>
                      <th>label</th>
                      <th>made</th>
                      <th>expires</th>
                      <th className="num">opened</th>
                      <th>last opened</th>
                      <th>state</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => {
                      const live = !l.revokedAt && l.expiresAt > now
                      return (
                        <tr key={l.id}>
                          <td>{l.label || <span className="muted">unnamed</span>}</td>
                          <td className="muted">{fmt(l.createdAt)}</td>
                          <td>{fmt(l.expiresAt)}</td>
                          <td className="num mono">{l.uses}</td>
                          <td className="muted">{fmt(l.lastUsedAt)}</td>
                          <td>
                            <Pill tone={live ? 'ok' : 'muted'}>
                              {l.revokedAt ? 'revoked' : live ? 'live' : 'expired'}
                            </Pill>
                          </td>
                          <td className="num">
                            {live && (
                              <button
                                className="btn btn-xs"
                                onClick={() => unshare.mutate(l.id)}
                                disabled={unshare.isPending}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      </TabPanel>

      <ConfirmDialog
        open={!!resetting}
        title={`Set a new password for ${resetting?.username ?? ''}?`}
        body={
          <>
            <p className="muted small">
              This signs the account out everywhere. Tell them the new password over a channel you trust.
            </p>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="New password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
          </>
        }
        confirmLabel="Set password"
        busy={update.isPending}
        onConfirm={() => {
          if (resetting)
            update.mutate(
              { id: resetting.id, body: { password: resetPassword } },
              {
                onSuccess: () => {
                  setResetting(null)
                  setResetPassword('')
                },
              },
            )
        }}
        onCancel={() => {
          setResetting(null)
          setResetPassword('')
        }}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete ${confirmDelete?.username ?? ''}?`}
        body={<p className="muted small">The account and its sessions are removed. This cannot be undone.</p>}
        confirmLabel="Delete account"
        busy={remove.isPending}
        onConfirm={() => {
          if (confirmDelete) remove.mutate(confirmDelete.id, { onSuccess: () => setConfirmDelete(null) })
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
