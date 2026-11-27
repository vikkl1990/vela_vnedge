// Build a read-only browser fixture through the real server worker and reader in an isolated process.
import fs from 'node:fs'
import { PinePool } from '../../server/src/pine/pool.ts'
import { Db } from '../../server/src/db.ts'
import { extractEvents } from '../../server/src/scanners/extractor.ts'
import { readingOf } from '../../server/src/scanners/reading.ts'
import { recordChartReceipt, chartReceipt } from '../../server/src/scanners/chartReceipts.ts'
const { source, bars } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const db = new Db(':memory:'),
  pool = new PinePool(1)
try {
  const result = await pool.run({
    scannerId: 'scanner-0',
    source,
    symbol: 'ETHUSD',
    tf: '15m',
    tickSize: 0.01,
    bars,
    tailBars: 3,
    plotTail: 3,
  })
  if (!result.ok) throw Error(result.error)
  const reading = readingOf({}, 'scanner-0', 900000, source)
  const events = extractEvents(result.alerts, result.shapes, { drawn: result.labels, ...reading.extract })
  recordChartReceipt(db, 'scanner-0', 'ETHUSD', '15m', source, {}, bars, result, events)
  if (db.get('SELECT count(*) n FROM positions').n || db.get('SELECT count(*) n FROM signals').n)
    throw Error('Diagnostic wrote trading rows')
  fs.writeFileSync(
    process.argv[2] + '.receipt.json',
    JSON.stringify(chartReceipt(db, 'scanner-0', 'ETHUSD', '15m')),
    { mode: 0o600 },
  )
} finally {
  await pool.stop()
  db.db.close()
}
