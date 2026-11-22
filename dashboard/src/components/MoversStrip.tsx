import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMovers, usePositions } from '../api/queries'
import { fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { arrowFor, heldSides, HOT_PCT, MOVER_WINDOWS, pickMovers, type MoverWindow } from '../lib/movers'
import { AssetChip } from './AssetChip'
import { TickerTape } from './TickerTape'
import '../styles/movers.css'

const KEY = 'vnedge.movers.window'

function readWindow(): MoverWindow {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (v === 5 || v === 15 || v === 60) return v
  } catch {
    /* private window or blocked storage: the default is fine */
  }
  return 5
}

/**
 * What is moving right now, with a way into it: the biggest 5-minute, 15-minute or 1-hour moves, their asset class,
 * whether the account already holds a side there, and a link to the chart. Display only. Until the server has an hour
 * of history the longer windows are empty and the strip says so; with no figures at all it falls back to the 24 h tape.
 */
export function MoversStrip() {
  const movers = useMovers()
  const positions = usePositions()
  const [win, setWinState] = useState<MoverWindow>(readWindow)
  const setWin = (w: MoverWindow) => {
    setWinState(w)
    try {
      localStorage.setItem(KEY, String(w))
    } catch {
      /* ignore */
    }
  }
  const d = movers.data
  const picks = d ? pickMovers(d.rows, win) : []
  if (!d || (d.rows.length === 0 && d.historyMinutes < 5)) {
    return <TickerTape />
  }
  const held = heldSides(positions.data ?? [])
  const hot = picks.filter((p) => p.hot).length
  return (
    <section className="movers" aria-label="Moving now">
      <div className="movers-head">
        <span className="movers-title">Moving now</span>
        <span className="movers-win" role="group" aria-label="Window">
          {MOVER_WINDOWS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={win === o.value}
              onClick={() => setWin(o.value)}
            >
              {o.label}
            </button>
          ))}
        </span>
      </div>
      {picks.length === 0 ? (
        <span className="muted movers-note">
          No {MOVER_WINDOWS.find((o) => o.value === win)?.label} figures yet: the server has{' '}
          {d.historyMinutes} min of history.
        </span>
      ) : (
        <ul className="movers-list">
          {picks.map(({ row, ch, hot: isHot }) => {
            const side = held.get(row.symbol)
            return (
              <li key={row.symbol}>
                <Link
                  className="mover"
                  data-hot={isHot}
                  to={`/chart?symbol=${encodeURIComponent(row.symbol)}`}
                  title={`${row.symbol}: open the chart${side ? ` · the account is ${side}` : ' · no account position'}`}
                >
                  <span className="mover-sym">{row.symbol.replace(/USDT?$/, '')}</span>
                  <AssetChip symbol={row.symbol} />
                  <span className={`mono ${pnlClass(ch)}`}>
                    {arrowFor(ch)} {fmtPct(ch, 1, true)}
                  </span>
                  <span className="mono muted small">{fmtPrice(row.price)}</span>
                  {side && <span className="mover-held">{side}</span>}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {picks.length > 0 && (
        <span className="muted movers-note">
          {hot > 0
            ? `${hot} past ${HOT_PCT[win]}% in ${win === 60 ? '1 h' : `${win} min`}`
            : `quiet: nothing past ${HOT_PCT[win]}% in ${win === 60 ? '1 h' : `${win} min`}`}
        </span>
      )}
    </section>
  )
}
