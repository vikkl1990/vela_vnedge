import type { AuthorReview as Review } from '../api/types'

export function AuthorReview({ review: r }: { review: Review }) {
  const p = r.publication, c = r.contract
  const source = { matches: 'Installed source matches the earlier code study', changed: 'Source changed — code study needs updating', unreviewed: 'No source study linked to this version' }[r.sourceStatus]
  const description = { reviewed: 'Author explanation and updates reviewed', retrieved: 'Author page retrieved; explanation review pending', changed: 'Author publication changed since review', unavailable: 'Author page verification unavailable' }[r.descriptionStatus]
  return <section className="lib-sub author-review" aria-label="Author intent and bot reading">
    <h3>Author intent and bot reading</h3>
    {r.variant && <p className="small"><strong>This reading’s purpose:</strong> {r.variant.reason ?? `Separate reading of ${r.variant.base}.`} Historical findings below may describe the base reading; this variant still needs its own execution tests and evidence.</p>}
    <p className="small">{source}{r.sourceReviewedAt ? ` · ${r.sourceReviewedAt}` : ''}<br />{description}</p>
    {p && <p className="small"><a href={p.url} target="_blank" rel="noreferrer">{p.author ?? 'Author publication'}</a>{p.role ? ` · ${p.role}` : ''}{p.version != null ? ` · publication v${p.version}` : ''}<br /><span className="muted">Page checked {p.retrievedAt ? new Date(p.retrievedAt).toLocaleString() : 'not verified'}</span></p>}
    {p?.summary && <p className="small">{p.summary}</p>}
    {p?.reviewBlocker && <p className="small">Review blocked: {p.reviewBlocker.blocker}</p>}
    {r.integrationNotes.map((n, i) => <p key={i} className="small">{n}</p>)}
    {p?.requirements && <details><summary>Author guidance and integration requirements</summary><p className="small">{p.requirements}</p></details>}
    {r.reconciliation ? <details><summary>Author and source reconciliation ({r.reconciliation.findings.length} findings)</summary>
      <p className="small muted">{r.reconciliation.scope} Findings describe integration work; they do not certify readiness or profitability.</p>
      {r.reconciliation.findings.length ? <ul className="small">{r.reconciliation.findings.map((f, i) => <li key={i}><strong>{f.marker}</strong>{f.sourceLine ? ` · source line ${f.sourceLine}` : ''}<br />{f.evidence}<br /><strong>Required treatment:</strong> {f.action}</li>)}</ul> : <p className="small">No discrepancy recorded within this review’s scope. Execution and promotion checks still apply.</p>}
    </details> : r.reconciliationStatus && r.reconciliationStatus !== 'unreviewed' && <p className="small">Author/source findings need rechecking: {r.reconciliationStatus}.</p>}
    {c && <>
      <details><summary>Earlier source-study entries ({c.entries.length})</summary>
        <p className="small muted">These are the earlier study’s interpretations. Review the author/source findings above for corrections; matching source bytes do not prove every interpretation correct.</p>
        <p className="small">{c.idea}</p>
        {c.entries.length ? <ul className="small">{c.entries.map((e, i) => <li key={i}><strong>{e.marker || '(untitled output)'}</strong> · {e.side} · {e.channel} · source line {e.line}<br />{e.condition}</li>)}</ul> : <p className="small">The source study identifies no autonomous entry.</p>}
      </details>
      <details><summary>Earlier context and management interpretations ({c.notEntries.length})</summary>
        <ul className="small">{c.notEntries.map((e, i) => <li key={i}>{e.marker} · {e.role} · {e.channel} · source line {e.line}</li>)}</ul>
      </details>
      <details><summary>Author protection, exits and timing</summary>
        <p className="small"><strong>Stop:</strong> {c.stop.how}<br /><strong>Targets:</strong> {c.targets.how}<br /><strong>Exit:</strong> {c.exit.how}</p>
        <p className="small">{c.timing.note}</p>
      </details>
      {c.claims.length > 0 && <details><summary>Earlier confirmed research claims ({c.claims.length})</summary>
        <p className="small muted">{r.claimMeaning}</p>
        <ul className="small">{c.claims.map((x, i) => <li key={i}><strong>{x.marker}</strong> · source line {x.line}<br />{x.evidence}</li>)}</ul>
      </details>}
    </>}
    <details><summary>Current bot reading</summary>
      <p className="small">Reader {r.reading.reader} · exits {r.reading.exitMode} · entry protection {r.reading.entryProtection}<br />Channels: {r.reading.sources?.join(', ') ?? 'inherited'}<br />Entry labels: {r.reading.labels?.join(', ') || 'no explicit allow-list'}</p>
      {r.reading.sides && <ul className="small">{Object.entries(r.reading.sides).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>}
      {r.reading.labelStyles && <ul className="small">{Object.entries(r.reading.labelStyles).flatMap(([text, styles]) => Object.entries(styles).map(([style, side]) => <li key={`${text}:${style}`}>Label {text} · {style}: {side}</li>))}</ul>}
      {r.patches.length > 0 && <p className="small">Runtime patches: {r.patches.join(', ')}. Source matching alone does not validate their effects.</p>}
      <p className="small muted">Source SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{r.sourceHash}</code></p>
    </details>
    <p className="small muted">{r.admission}</p>
  </section>
}
