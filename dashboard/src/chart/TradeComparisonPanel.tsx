import { Link } from 'react-router-dom'
import type { JournalRow } from '../api/journal'
import { DataTable } from '../components/DataTable'
import { Section } from '../components/kit'
import { fmtPnl, fmtRecordedPrice } from '../lib/format'
import { compareTrades, type AuthorLedger } from './tradeComparison'

const utc = (at: number | null | undefined) =>
  at == null ? '—' : new Date(at).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
export function TradeComparisonPanel({
  rows,
  ledgers,
  selectedCount,
  loading,
  error,
}: {
  rows: JournalRow[]
  ledgers: AuthorLedger[]
  selectedCount: number
  loading: boolean
  error?: string
}) {
  return (
    <Section title="Author vs bot · read-only comparison" variant="panel">
      <p className="small muted">
        Bot fills are recorded executions. Author trades are simulations on the chart’s loaded history and
        current inputs, with forming-bar fills excluded. Costs, size and history can differ; this is not
        promotion evidence or a profit backtest. Native price arrows belong to the script; timeline B/X/P
        marks belong to the bot.
      </p>
      {error && <p role="alert">Trade journal unavailable: {error}</p>}
      {!selectedCount && <p>Select an overlay script to inspect its author ledger beside bot trades.</p>}
      {selectedCount > 0 && !ledgers.length && (
        <p role="status">Waiting for the selected scripts to finish their chart runs…</p>
      )}
      {ledgers.map((l) => (
        <details key={l.id + l.tf} className="chart-ledger" open>
          <summary>
            <strong>
              {l.title} · {l.tf}
            </strong>{' '}
            ·{' '}
            {l.kind === 'strategy'
              ? `${l.trades.filter((t) => !t.open).length} simulated closed / ${l.trades.filter((t) => t.open).length} open`
              : 'indicator · no strategy ledger'}
          </summary>
          <p className="small muted">
            Source {l.sourceHash?.slice(0, 12) ?? 'unknown'} · {l.timezone} · {utc(l.from)} to{' '}
            {utc(l.through)} · {l.complete ? 'history loaded' : 'history still loading'}
            {l.inputsChanged ? ' · chart inputs differ from bot configuration' : ''}
          </p>
          <p className="small muted">
            Delta author previews use the bot’s signal-unit profile (point value 1 and fractional minimum
            size). Exchange contract quantities and account risk are calculated separately.
          </p>
          {l.error ? (
            <p role="alert">Author ledger unavailable: {l.error}</p>
          ) : !l.complete ? (
            <p>Waiting for complete history.</p>
          ) : l.kind === 'indicator' ? (
            <p>
              This indicator has no strategy round trips. Its entries and exits require its scanner contract;
              no author fills are invented.
            </p>
          ) : (
            <>
              <DataTable
                caption={`Bot comparison · ${l.title} · ${l.tf}`}
                rows={compareTrades(rows, l)}
                rowKey={(r) => r.bot.id}
                pageSize={10}
                loading={loading}
                emptyLabel="No closed bot trades for this scanner in the loaded journal selection."
                columns={[
                  {
                    key: 'bot',
                    header: 'Bot trade',
                    render: ({ bot }) => (
                      <>
                        <Link to={`/trades/${bot.id}/replay?book=${bot.book}`}>#{bot.id}</Link> · {bot.book} ·{' '}
                        {bot.side}
                        <br />
                        <span className="small">{bot.scannerName}</span>
                      </>
                    ),
                  },
                  {
                    key: 'entry',
                    header: 'Bot entry → exit (UTC)',
                    render: ({ bot }) => (
                      <>
                        {utc(bot.entryAt)}
                        <br />
                        {fmtRecordedPrice(bot.entryPrice)} → {fmtRecordedPrice(bot.exitPrice)}
                        <br />
                        {utc(bot.exitAt)}
                      </>
                    ),
                    mobile: 'detail',
                  },
                  {
                    key: 'result',
                    header: 'Bot net / exit',
                    render: ({ bot }) => (
                      <>
                        {fmtPnl(bot.r)}R · ${fmtPnl(bot.net)}
                        <br />
                        {bot.exitReason ?? 'unknown'}
                        <br />
                        <span className="small">Fees ${fmtPnl(bot.commission)}</span>
                      </>
                    ),
                  },
                  {
                    key: 'author',
                    header: 'Author entry → exit (UTC)',
                    render: ({ author }) =>
                      author ? (
                        <>
                          {utc(author.entry.time)}
                          <br />
                          {fmtRecordedPrice(author.entry.price)} →{' '}
                          {author.exit ? fmtRecordedPrice(author.exit.price) : 'still open'}
                          <br />
                          {utc(author.exit?.time)}
                          <br />
                          {author.exit?.comment ?? author.exit?.id ?? ''}
                        </>
                      ) : (
                        '—'
                      ),
                    mobile: 'detail',
                  },
                  {
                    key: 'match',
                    header: 'Association',
                    value: (r) => r.status,
                    render: ({ status, bot, author }) => (
                      <>
                        {status}
                        {author?.exit && bot.exitAt !== null && (
                          <>
                            <br />
                            <span className="small">
                              Bot exited {Math.abs((bot.exitAt - author.exit.time) / 60000).toFixed(1)} min{' '}
                              {bot.exitAt < author.exit.time ? 'earlier' : 'later'}
                            </span>
                          </>
                        )}
                        <br />
                        <span className="small muted">
                          Same-bar association does not prove policy parity.
                        </span>
                      </>
                    ),
                  },
                ]}
              />
              <details>
                <summary>All author round trips in loaded history ({l.trades.length})</summary>
                <DataTable
                  caption={`Author simulation · ${l.title} · ${l.tf}`}
                  rows={[...l.trades].reverse()}
                  rowKey={(t) => t.id}
                  pageSize={10}
                  columns={[
                    { key: 'side', header: 'Author side', value: (t) => t.side },
                    {
                      key: 'entry',
                      header: 'Entry (UTC)',
                      render: (t) => (
                        <>
                          {utc(t.entry.time)}
                          <br />
                          {fmtRecordedPrice(t.entry.price)} · {t.entry.id}
                        </>
                      ),
                    },
                    {
                      key: 'exit',
                      header: 'Exit (UTC)',
                      render: (t) =>
                        t.exit ? (
                          <>
                            {utc(t.exit.time)}
                            <br />
                            {fmtRecordedPrice(t.exit.price)} · {t.exit.comment ?? t.exit.id}
                          </>
                        ) : (
                          'Open at last closed bar'
                        ),
                    },
                  ]}
                />
              </details>
            </>
          )}
        </details>
      ))}
    </Section>
  )
}
