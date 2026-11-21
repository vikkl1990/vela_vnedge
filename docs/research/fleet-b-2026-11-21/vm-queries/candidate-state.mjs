import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('/opt/vnedge/data/vnedge.db', { readOnly: true });
const cfg = JSON.parse(fs.readFileSync('/opt/vnedge/data/config.json', 'utf8'));
const manifest = (() => { try { return JSON.parse(fs.readFileSync('/opt/vnedge/scripts/manifest.json', 'utf8')); } catch { return null; } })();
const ids = JSON.parse(fs.readFileSync('/tmp/cands.json', 'utf8'));
const since = Date.now() - 14 * 864e5;
const q = new Set(db.prepare('SELECT scanner_id FROM script_health WHERE quarantined=1').all().map((r) => r.scanner_id));
const mids = manifest ? new Set((manifest.scripts ?? manifest).map?.((s) => s.id) ?? Object.keys(manifest)) : null;
const out = ids.map((c) => {
  const p = db.prepare('SELECT stage, since, substr(gate,1,300) gate FROM incubator_pairs WHERE scanner_id=? AND symbol=? AND tf=?').get(c.scannerId, c.symbol, c.tf);
  let g = null; try { g = p?.gate ? JSON.parse(p.gate + (p.gate.endsWith('}') ? '' : '"}')) : null; } catch { /* truncated */ }
  const cp = db.prepare("SELECT COUNT(*) n, SUM(action LIKE 'opened%') opened, SUM(action LIKE 'rejected:stop too tigh%') tight, SUM(action LIKE 'rejected:risk market%') market FROM signals WHERE scanner_id=? AND symbol=? AND tf=? AND kind='entry' AND label LIKE '%(shadow mirror)%' AND at>?").get(c.scannerId, c.symbol, c.tf, since);
  const sc = cfg.scanners?.[c.scannerId];
  return { ...c, stage: p?.stage ?? null, decision: (p?.gate && /"decision":"(\w+)"/.exec(p.gate))?.[1] ?? null, copySignals14d: cp.n, copiesOpened: cp.opened, tightShare: cp.n ? +(cp.tight / cp.n).toFixed(2) : null, marketShare: cp.n ? +(cp.market / cp.n).toFixed(2) : null, quarantined: q.has(c.scannerId), inManifest: mids ? mids.has(c.scannerId) : null, cfg: sc ? { enabled: sc.enabled, hidden: sc.hidden ?? false, symbols: sc.symbols?.length ?? null, pairs: sc.pairs?.length ?? 0, exitMode: sc.exitMode } : 'no config entry' };
});
console.log(JSON.stringify(out));
