import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/opt/vnedge/data/vnedge.db', { readOnly: true });
const live = db.prepare("SELECT scanner_id sc, symbol sym, tf, since FROM incubator_pairs WHERE stage='live'").all();
const names = Object.fromEntries(db.prepare('SELECT DISTINCT scanner_id, scanner_name FROM positions').all().map((r) => [r.scanner_id, r.scanner_name]));
const q = db.prepare('SELECT scanner_id FROM script_health WHERE quarantined=1').all().map((r) => r.scanner_id);
const mirrorEligible = db.prepare("SELECT stage, COUNT(*) n FROM incubator_pairs GROUP BY stage").all();
console.log(JSON.stringify({ live, names, quarantined: q, mirrorEligible }));
