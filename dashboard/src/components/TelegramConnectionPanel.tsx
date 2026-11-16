import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import type { TelegramStatus } from '../api/telegram'
import { useAuth } from '../auth/AuthGate'
import { Callout, ConfirmDialog, Pill, Section, Time } from './kit'

const key = ['telegram-connection']

export function TelegramConnectionPanel() {
  const { isAdmin } = useAuth()
  const cache = useQueryClient()
  const safe =
    window.location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  const query = useQuery({
    queryKey: key,
    queryFn: api.telegramConnection,
    enabled: isAdmin && safe,
    retry: false,
    refetchInterval: 5000,
  })
  const [token, setToken] = useState('')
  const [pairUrl, setPairUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [remove, setRemove] = useState(false)
  const [controlsDraft, setControlsDraft] = useState<boolean | null>(null)
  const status = query.data
  if (!isAdmin) return null
  const remember = (s: TelegramStatus) => {
    cache.setQueryData(key, s)
    void cache.invalidateQueries({ queryKey: ['health'] })
    void cache.invalidateQueries({ queryKey: ['learning'] })
    void cache.invalidateQueries({ queryKey: ['gates'] })
  }
  async function act(fn: () => Promise<TelegramStatus>, success: string) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await cache.cancelQueries({ queryKey: key })
      remember(await fn())
      setNotice(success)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Telegram setup failed.')
    } finally {
      setBusy(false)
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    const credentials = { botToken: token }
    setToken('')
    setPairUrl('')
    try {
      await act(
        () => api.saveTelegramConnection(credentials),
        'Bot verified and saved. Pair your private chat next.',
      )
    } finally {
      credentials.botToken = ''
    }
  }
  async function pair() {
    setPairUrl('')
    await act(async () => {
      const result = await api.pairTelegram()
      setPairUrl(result.url)
      return result.status
    }, 'Open the pairing link in Telegram and press Start, then approve the chat here.')
  }
  return (
    <section id="telegram-connection" className="settings-group" aria-label="Telegram alerts and controls">
      <Section
        variant="panel"
        title="Telegram alerts and controls"
        actions={
          <Pill tone={status?.ready ? 'ok' : 'warn'}>{status?.ready ? 'Connected' : 'Setup required'}</Pill>
        }
      >
        {!safe ? (
          <Callout tone="danger" title="Use a secure connection">
            Open this dashboard over HTTPS or through your local SSH tunnel before entering the bot token.
          </Callout>
        ) : (
          <div className="stack">
            <p>Connect your own bot for operational alerts and private paper-trading controls.</p>
            <ol>
              <li>
                Use your existing bot token from{' '}
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                  BotFather
                </a>
                . The token is saved privately on this server and is never returned by the API.
              </li>
              <li>Open the pairing link and press Start in your private Telegram chat.</li>
              <li>Check the Telegram identity shown below, then approve it and send a test alert.</li>
            </ol>
            <form onSubmit={(e) => void save(e)} className="stack">
              <label className="field">
                <span>Telegram bot token</span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={busy}
                  placeholder={status?.configured ? 'Enter a replacement token' : 'Token from BotFather'}
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy || !token.trim()}>
                Save and verify bot
              </button>
            </form>
            {query.isError && (
              <Callout tone="danger" title="Status unavailable">
                {query.error.message}
              </Callout>
            )}
            {error && (
              <Callout tone="danger" title="Telegram action failed">
                {error}
              </Callout>
            )}
            {notice && <p role="status">{notice}</p>}
            {status?.configured && (
              <>
                <p>
                  Bot: <strong>@{status.username}</strong> · receiver{' '}
                  {status.receiverRunning ? 'running' : 'stopped'} · mode <strong>{status.mode}</strong>
                </p>
                {status.lastError && (
                  <Callout tone="warn" title="Connection needs attention">
                    {status.lastError}
                  </Callout>
                )}
                {!status.ownerActive && (
                  <Callout tone="danger" title="Owner unavailable">
                    The administrator who connected this bot is disabled or no longer an administrator. Save
                    the token again from an active administrator account.
                  </Callout>
                )}
                <div className="actions">
                  <button className="btn" onClick={() => void pair()} disabled={busy}>
                    Pair private chat
                  </button>
                  <button
                    className="btn"
                    onClick={() => void act(api.testTelegram, 'Test alert delivered to your approved chat.')}
                    disabled={busy || !status.binding}
                  >
                    Send test alert
                  </button>
                  <button className="btn btn-danger" onClick={() => setRemove(true)} disabled={busy}>
                    Disconnect Telegram
                  </button>
                </div>
                {pairUrl && status.pairing && (
                  <p>
                    <a className="btn btn-primary" href={pairUrl} target="_blank" rel="noreferrer">
                      Open pairing in Telegram
                    </a>{' '}
                    · expires <Time t={status.pairing.expiresAt} />
                  </p>
                )}
                {status.pairing?.candidate && (
                  <Callout tone="warn" title="Approve this private chat">
                    <p>
                      {status.pairing.candidate.name}{' '}
                      {status.pairing.candidate.username ? '@' + status.pairing.candidate.username : ''} ·
                      Telegram user ID {status.pairing.candidate.userId}
                    </p>
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api.approveTelegram({ pairId: status.pairing!.id }),
                          'Private chat approved and test alert delivered.',
                        )
                      }
                    >
                      Approve chat and send test
                    </button>
                  </Callout>
                )}
                {status.binding && (
                  <p>
                    Approved chat: {status.binding.name} · user ID {status.binding.userId}. Last delivery
                    check:{' '}
                    {status.binding.verifiedAt ? <Time t={status.binding.verifiedAt} /> : 'not verified'}.
                  </p>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={controlsDraft ?? status.controlsEnabled}
                    disabled={busy}
                    onChange={(e) => {
                      const enabled = e.target.checked
                      setControlsDraft(enabled)
                      void act(
                        () => api.telegramControls(enabled),
                        'Telegram paper-control preference saved.',
                      ).finally(() => setControlsDraft(null))
                    }}
                  />{' '}
                  Allow paper pause, resume and position-close commands
                </label>
                <p className="small muted">
                  /status · /positions · /pnl · /alerts · /pause · /resume · /close ID · /help. Resume and
                  closure require a confirmation within 60 seconds. Resume preserves loss limits and
                  cooldowns. Telegram cannot activate live trading, alter risk settings or place new entries.
                </p>
                {status.recent.length > 0 && (
                  <details>
                    <summary>Recent command audit</summary>
                    <ul>
                      {status.recent.map((item, i) => (
                        <li key={item.at + ':' + i}>
                          <Time t={item.at} /> · /{item.command} · {item.status}
                          {item.status === 'claimed' ? ' — outcome unknown; inspect the dashboard' : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        )}
        <ConfirmDialog
          open={remove}
          title="Disconnect Telegram?"
          body="Alerts and remote commands will stop. Paper trading and existing risk settings will continue."
          confirmLabel="Disconnect"
          danger
          busy={busy}
          onCancel={() => setRemove(false)}
          onConfirm={() => {
            setRemove(false)
            setPairUrl('')
            void act(api.removeTelegramConnection, 'Telegram disconnected.')
          }}
        />
      </Section>
    </section>
  )
}
