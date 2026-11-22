import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/vnedge/data/vnedge.db', { readOnly: true });
const since = Date.now() - 120 * 864e5;
const rows = db.prepare("SELECT bt, scanner_id sc, symbol sym, tf, side, entry_at at, exit_at ex_at, exit_reason ex, (realized_pnl-fees)/risk_amount r FROM positions WHERE status='closed' AND bt IN (0,2) AND scanner_id NOT LIKE 'plan:%' AND risk_amount>0 AND entry_at > ?").all(since);
console.log(JSON.stringify(rows));
