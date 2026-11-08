import { useState } from 'react'
import { api } from '../api/client'
import type { JournalQuery } from '../api/journal'
import { journalExportQuery, type JournalExportKind, type JournalExportRange } from '../lib/journalExport'

export function JournalExport({ query, total, filterError }: { query: JournalQuery; total?: number; filterError: string | null }) {
  const [range, setRange] = useState<JournalExportRange>('filtered')
  const [busy, setBusy] = useState<JournalExportKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<string | null>(null)
  const book = query.book === 'shadow' ? 'Shadow' : 'Paper'
  const unavailable = range === 'filtered' && (!!filterError || total === undefined || total === 0)
  const start = async (kind: JournalExportKind) => {
    setBusy(kind); setError(null); setDownload(null)
    try {
      const file = await api.journalExport(journalExportQuery(query, range), kind)
      const url = URL.createObjectURL(file.blob), link = document.createElement('a')
      link.href = url; link.download = file.filename
      document.body.append(link); link.click(); link.remove()
      // Allow the browser to begin consuming the file before releasing its object URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setDownload(file.filename)
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed. Please retry.') }
    finally { setBusy(null) }
  }
  return <section className="journal-export" aria-labelledby="journal-export-title" aria-busy={!!busy}>
    <div className="journal-export-copy">
      <h2 id="journal-export-title">Export trade history</h2>
      <p>{book} book · {range === 'complete' ? 'All closed trades, all markets and scanners, including before account resets.' : 'Uses the journal filters below and includes every matching page.'}</p>
      <p className="small muted">CSV for Excel or Sheets. Trades include entry, exit, SL/TP, sizing, fees, funding and net P&amp;L. Fills contain individual executions.</p>
      {query.book === 'shadow' && <p className="small muted">Shadow dollars are synthetic. Complete history also includes watch-only and plan comparisons, labelled in the trades file.</p>}
    </div>
    <div className="journal-export-actions">
      <label>Export range<select className="select" value={range} disabled={!!busy} onChange={e => { setRange(e.target.value as JournalExportRange); setError(null); setDownload(null) }}>
        <option value="filtered">Selected filters{!filterError && total !== undefined ? ` · ${total.toLocaleString()} records` : ''}</option>
        <option value="complete">Complete closed history + archives</option>
      </select></label>
      <div className="row gap">
        <button className="btn btn-cta" disabled={!!busy || unavailable} onClick={() => void start('trades')}>{busy === 'trades' ? 'Preparing trades…' : 'Export trades CSV'}</button>
        <button className="btn" disabled={!!busy || unavailable} onClick={() => void start('fills')}>{busy === 'fills' ? 'Preparing fills…' : 'Export fills CSV'}</button>
      </div>
    </div>
    {range === 'filtered' && filterError && <p className="journal-export-status small" role="status">Correct the date or direction filter below, or choose complete history.</p>}
    {range === 'filtered' && !filterError && total === 0 && <p className="journal-export-status small" role="status">No records match. Change the filters or choose complete history.</p>}
    {error && <p className="journal-export-status loss" role="alert">{error}</p>}
    {download && <p className="journal-export-status small" role="status">Download started: {download}</p>}
  </section>
}
