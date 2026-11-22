import type { App } from '../app.ts';
import type { Position } from '../paper/logic.ts';
import { entryOrigin, entryOriginSql } from '../analytics/paperFleet.ts';

/** HTTP snapshots and stream updates use the same persisted admission provenance.
 * Engine position events are emitted after commit, so even a first fill can read its receipt. */
export function paperPositionViews(a: App) {
  type Row = { id: number; fills: string; receipt: string | null };
  const select = `SELECT p.id,p.fills,${entryOriginSql} receipt FROM positions p WHERE p.bt=0`;
  const view = (p: Position, row?: Row) => ({
    ...a.paper.view(p, a.marks.mark(p.symbol) ?? null),
    ...entryOrigin(row?.fills, row?.receipt),
  });
  return {
    one(p: Position) { return view(p, a.db.get<Row>(`${select} AND p.id=?`, p.id)); },
    all() {
      const rows = new Map(a.db.all<Row>(`${select} AND p.status='open'`).map(row => [row.id, row]));
      return a.paper.openPositions().map(p => view(p, rows.get(p.id)));
    },
  };
}
