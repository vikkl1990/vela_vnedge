import sqlite3,json,time,argparse
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("--db",required=True);p.add_argument("--days",type=int,default=7);p.add_argument("--out",required=True);a=p.parse_args()
if not 1<=a.days<=90:p.error("--days must be 1 to 90")
c=sqlite3.connect(Path(a.db).resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('begin')
def rows(q,*args): return [dict(r) for r in c.execute(q,args)]
now=int(time.time()*1000)
out={'at':now,'orders':rows("SELECT o.*,p.tf,p.scanner_name,p.entry_price,p.entry_at,p.contract_value,p.qty position_qty,p.risk_amount,p.side position_side,p.realized_pnl,p.fees,p.exit_at,p.exit_reason,p.policy_id FROM orders o JOIN positions p ON p.id=o.position_id WHERE o.at>? AND o.bt IN(0,2) AND o.reason NOT IN('entry','funding') ORDER BY o.at,o.id",now-a.days*86400000)}
c.rollback();c.close();Path(a.out).write_text(json.dumps(out,separators=(',',':')))
print(json.dumps({'at':now,'days':a.days,'exits':len(out['orders']),'out':a.out}))
