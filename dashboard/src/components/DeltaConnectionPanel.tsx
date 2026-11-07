import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DeltaConnectionStatus, DeltaEnvironment } from '../api/deltaConnection'
import { useAuth } from '../auth/AuthGate'
import { Panel, Pill, Time } from './ui'

const queryKey = ['delta-connection']

export function DeltaConnectionPanel() {
  const { isAdmin } = useAuth()
  const client = useQueryClient()
  const safeTransport = window.location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  const query = useQuery({ queryKey, queryFn: api.deltaConnection, enabled: isAdmin && safeTransport, retry: false })
  const [environment, setEnvironment] = useState<DeltaEnvironment | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const status = query.data
  if (!isAdmin) return null
  if (!safeTransport) return <Panel title="Delta India connection"><p role="alert">Open this dashboard over HTTPS or through your local SSH tunnel before entering API credentials.</p></Panel>
  const remember = (result: DeltaConnectionStatus) => client.setQueryData(queryKey, result)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!environment || busy) return
    // Keep secrets out of query/mutation caches and clear the form before the request finishes.
    const credentials = { environment, apiKey, apiSecret }
    setApiKey(''); setApiSecret(''); setBusy('save'); setError(''); setNotice('')
    try {
      remember(await api.saveDeltaConnection(credentials))
      setNotice('Credentials saved. Checking authenticated reads…')
      remember(await api.checkDeltaConnection())
      setNotice('Credentials saved. Execution settings are unchanged.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save or check this connection.')
    } finally { credentials.apiKey = ''; credentials.apiSecret = ''; setBusy(null) }
  }
  async function act(action: 'check' | 'remove') {
    setBusy(action); setError(''); setNotice('')
    try {
      remember(await (action === 'check' ? api.checkDeltaConnection() : api.removeDeltaConnection()))
      if (action === 'remove') { setApiKey(''); setApiSecret(''); setNotice('Saved connection credentials removed.') }
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection action failed.') }
    finally { setBusy(null) }
  }
  return (
    <section id="delta-connection" aria-label="Delta India API connection">
      <Panel title="Delta India connection" right={<Pill tone={status?.check?.ok ? 'ok' : status?.configured ? 'warn' : 'muted'}>{query.isPending ? 'Loading…' : query.isError ? 'Status unavailable' : status?.check?.ok ? 'Read access verified' : status?.configured ? 'Saved · verify access' : 'Not connected'}</Pill>}>
        <p className="small">Save an API key and its secret, then verify wallet and position reads. Use a key with <b>Read Data</b> permission. This panel does not enable trading or change the account’s execution mode.</p>
        <div className="grid-2">
          <form onSubmit={save} autoComplete="off" className="form" aria-label="Save Delta credentials">
            <label className="field"><span className="field-label">Key environment</span>
              <select className="input" value={environment} onChange={e => setEnvironment(e.target.value as DeltaEnvironment)} required disabled={!!busy}>
                <option value="">Choose where you created the key</option><option value="production">Delta India production</option><option value="testnet">Delta India testnet</option>
              </select>
            </label>
            <label className="field"><span className="field-label">API key</span><input className="input" type="password" name="delta-api-key" autoComplete="off" spellCheck={false} autoCapitalize="none" value={apiKey} onChange={e => setApiKey(e.target.value)} required maxLength={512} disabled={!!busy} placeholder={status?.configured ? 'Enter a new key to replace the saved connection' : 'Paste API key'} /></label>
            <label className="field"><span className="field-label">API secret</span><input className="input" type="password" name="delta-api-secret" autoComplete="new-password" spellCheck={false} autoCapitalize="none" value={apiSecret} onChange={e => setApiSecret(e.target.value)} required maxLength={512} disabled={!!busy} placeholder="Paste API secret" /></label>
            <div className="row gap"><button type="submit" className="btn btn-cta" disabled={!!busy || !environment || !apiKey.trim() || !apiSecret.trim()}>{busy === 'save' ? 'Saving and checking…' : status?.configured ? 'Replace and check' : 'Save and check'}</button></div>
          </form>
          <div>
            {query.isPending && <p className="muted small">Loading connection status…</p>}
            {query.isError && <p className="text-danger small" role="alert">{query.error.message} <button className="btn btn-sm" onClick={() => void query.refetch()}>Retry</button></p>}
            <dl className="kv-list">
              <div><dt>Saved connection</dt><dd>{status?.configured ? `Delta India ${status.environment}` : 'None'}</dd></div>
              <div><dt>Saved</dt><dd>{status?.savedAt ? <Time t={status.savedAt} /> : '—'}</dd></div>
              <div><dt>Last check</dt><dd>{status?.check ? <Time t={status.check.at} /> : 'Not checked since server start'}</dd></div>
              <div><dt>Trading permission</dt><dd>Not tested</dd></div>
            </dl>
            {status?.check && <p className={`small ${status.check.ok ? '' : 'text-danger'}`} role="status">{status.check.message}</p>}
            <div className="row gap">
              <button type="button" className="btn" onClick={() => void act('check')} disabled={!!busy || !status?.configured}>{busy === 'check' ? 'Checking…' : 'Check saved connection'}</button>
              <button type="button" className="btn btn-danger-outline" onClick={() => void act('remove')} disabled={!!busy || !status?.configured}>{busy === 'remove' ? 'Removing…' : 'Remove saved credentials'}</button>
            </div>
            <p className="muted small">Administrator access only. Credentials stay in an owner-only file on the bot server, outside settings and database backups, and are never returned to this page. Use HTTPS or the local SSH tunnel. Removal here does not revoke the key at Delta.</p>
          </div>
        </div>
        {notice && <p className="small" role="status">{notice}</p>}
        {error && <p className="text-danger small" role="alert">{error}</p>}
      </Panel>
    </section>
  )
}
