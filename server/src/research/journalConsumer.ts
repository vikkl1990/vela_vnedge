import type { Db } from '../db.ts';

/** Independent cursors over the existing transactional position journal, never a second trade ledger. */
export class JournalConsumer {
  constructor(privateDb: Db, name: string, adoptHistory = false, closedOnly = false) {
    this.db = privateDb;
    this.closedOnly = closedOnly;
    this.key = `journal.consumer.${name}`;
    if (privateDb.kvGet(this.key) === undefined)
      privateDb.kvSet(
        this.key,
        adoptHistory
          ? 0
          : privateDb.get<{ id: number }>('SELECT coalesce(max(id),0) id FROM decision_trace')!.id,
      );
  }
  private db: Db;
  private key: string;
  private closedOnly: boolean;
  consume(
    handle: (
      event: { id: number; book: number; stage: string; position_id: number | null },
      position: any,
    ) => void,
    limit = 50,
  ) {
    let n = 0;
    for (const row of this.db.all<any>(
      `SELECT id,book,stage,position_id FROM decision_trace WHERE id>? ${this.closedOnly ? "AND book=0 AND stage='closed'" : ''} ORDER BY id LIMIT ?`,
      this.db.kvGet<number>(this.key) ?? 0,
      limit,
    )) {
      this.db.transaction(() => {
        const p =
          row.position_id == null
            ? undefined
            : this.db.get('SELECT * FROM positions WHERE id=?', row.position_id);
        handle(row, p);
        this.db.kvSet(this.key, row.id);
      });
      n++;
    }
    return n;
  }
}
