import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PositionHealth as Health } from '../../../shared/positionHealth'
import type { Position } from '../api/types'
import { fmtMoney, fmtPrice } from '../lib/format'
import { protectionText } from '../lib/protection'
import { Pnl } from './kit'
import '../styles/position-health.css'

const states = {
  none: 'No active SL',
  initial: 'Initial stop',
  'reduced-loss': 'Loss reduced',
  'entry-price': 'At entry · before fees',
  'profit-level': 'Profit-level stop · before fees',
} as const

export function ActiveStop({ p, h, tick }: { p: Position; h?: Health; tick?: number }) {
  const delta = p.sl === null ? null : (p.sl - p.entryPrice) * (p.side === 'long' ? 1 : -1)
  const state =
    h?.stop.state ??
    (delta === null
      ? 'none'
      : Math.abs(delta) < 1e-10
        ? 'entry-price'
        : delta > 0
          ? 'profit-level'
          : p.sl !== null &&
              p.slOriginal !== null &&
              (p.sl - p.slOriginal) * (p.side === 'long' ? 1 : -1) > 1e-10
            ? 'reduced-loss'
            : 'initial')
  return (
    <div className="position-health-stop">
      <span className="mono">{fmtPrice(p.sl, tick)}</span>
      <span className="small muted">{states[state]}</span>
      {h?.stop.netAtLevel != null && (
        <span
          className="small"
          title="Total trade result if the remainder filled exactly at this stop, with standard exit fees. Future slippage and funding can make it worse."
        >
          At level: {fmtMoney(h.stop.netAtLevel)} net*
        </span>
      )}
      {h?.stop.liquidationBeforeStop && <span className="loss small">Modelled liquidation before SL</span>}
      {p.protection && p.protection.trailAfterR > 0 && (
        <span className="small muted">
          {p.protection.peakR + 1e-10 >= p.protection.trailAfterR
            ? 'Trail threshold reached'
            : `Trail waits for +${p.protection.trailAfterR.toFixed(2)}R · peak +${p.protection.peakR.toFixed(2)}R`}
        </span>
      )}
      <span className="small muted">Paper protection</span>
    </div>
  )
}

export function CloseNow({
  p,
  h,
  fresh,
  unavailable,
}: {
  p: Position
  h?: Health
  fresh: boolean
  unavailable?: boolean
}) {
  const q = h?.closeNow,
    r = h?.coverage.replay
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <div className="position-health" data-testid={`position-health-${p.id}`}>
      {q?.netUsd != null ? (
        <>
          <span className={fresh ? '' : 'price-stale'}>
            {fresh ? <Pnl value={q.netUsd} /> : <span className="mono">{fmtMoney(q.netUsd)}</span>}
          </span>
          <span className="small muted">
            {fresh ? 'Depth estimate' : 'Last estimate · stale'}
            {h?.coverage.pendingFunding ? ' · provisional' : ''}
          </span>
        </>
      ) : (
        <>
          <span className="muted">Unavailable</span>
          <span className="small muted">
            {unavailable ? 'Health feed unavailable' : (q?.reason ?? 'Waiting for depth estimate')}
          </span>
        </>
      )}
      <button
        className="btn btn-xs position-health-button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        Data & protection
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="dialog position-health-dialog"
          aria-labelledby={title}
          onClose={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 id={title}>{p.symbol} · Data & protection</h3>
          <div className="position-health-details dialog-body">
            <p>
              Estimated total trade result after closing the remaining position: realized P&L, booked funding,
              all booked fees and an estimated taker exit fee. Each position is priced independently. Not a
              fill guarantee.
            </p>
            {q && (
              <dl>
                <div>
                  <dt>Observed depth</dt>
                  <dd>
                    {q.filledQty}/{q.requestedQty} contracts ·{' '}
                    {q.depthAgeMs === null
                      ? 'no fresh book'
                      : `${Math.max(0, q.depthAgeMs).toFixed(0)} ms old at calculation`}
                  </dd>
                </div>
                <div>
                  <dt>Estimated exit VWAP</dt>
                  <dd>{fmtPrice(q.price)}</dd>
                </div>
                <div>
                  <dt>Exit fee: gross / cash / discount</dt>
                  <dd>
                    {fmtMoney(q.grossExitFee)} / {fmtMoney(q.cashExitFee)} / {fmtMoney(q.feeDiscount)}
                  </dd>
                </div>
              </dl>
            )}
            {h && (
              <dl>
                <div>
                  <dt>First entry fill</dt>
                  <dd>
                    {
                      {
                        'depth-recorded': 'Depth receipt saved',
                        'limit-observation': 'Limit observation saved',
                        'receipt-only': 'Receipt only; no depth or tape observation',
                        missing: 'No matching receipt',
                      }[h.coverage.entry]
                    }{' '}
                    · later fills require their own audit
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {h.coverage.policy === 'frozen'
                      ? 'Entry policy saved'
                      : h.coverage.policy === 'adopted'
                        ? 'Policy adopted later; original rules unverified'
                        : 'Legacy position; resolved current policy'}
                  </dd>
                </div>
                <div>
                  <dt>Funding</dt>
                  <dd>
                    {h.coverage.pendingFunding
                      ? `${h.coverage.pendingFunding} recorded settlements unresolved; net is provisional`
                      : 'Booked funding included; unrecorded gaps not verified'}
                  </dd>
                </div>
                <div>
                  <dt>Replay archive</dt>
                  <dd>
                    {r
                      ? `${r.capturing ? 'Capture selected' : 'Not capturing'} · ${r.segments} sealed segments · ${r.checkpoints} checkpoints`
                      : 'Archive unavailable'}
                  </dd>
                </div>
                {r && (
                  <div>
                    <dt>Replay quality</dt>
                    <dd>
                      {r.segmentsWithGaps} overlapping segments contain gaps; {r.failures} writer errors,{' '}
                      {r.dropped} dropped events this process.{' '}
                      {r.from !== null && r.from > p.entryAt ? 'Entry predates available segments. ' : ''}
                      Continuity is unverified; segment counts are not complete coverage.
                    </dd>
                  </div>
                )}
              </dl>
            )}
            <p>{protectionText(p)}</p>
            <p>
              * At-stop net assumes an exact fill at the acknowledged stop with standard exit fees. Stops can
              slip; future funding is unknown. Pending stop amendments are not active protection.
            </p>
          </div>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </dialog>,
        document.body,
      )}
    </div>
  )
}
