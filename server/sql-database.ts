export type SqlDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...bindings: any[]): unknown; all(...bindings: any[]): unknown[]; run(...bindings: any[]): { changes: number | bigint } };
  transaction?<T>(work: () => T): T;
  close(): void;
};

export function transaction<T>(db: SqlDatabase, work: () => T): T {
  if (db.transaction) return db.transaction(work);
  db.exec('BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
