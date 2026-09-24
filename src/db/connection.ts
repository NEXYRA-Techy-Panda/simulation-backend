import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export interface OpenOptions {
  /** How long a writer waits for a competing lock before SQLITE_BUSY (ms). */
  busyTimeoutMs?: number;
}

export const MEMORY = ':memory:';

/**
 * Opens the simulator database with the settings every connection needs:
 * foreign keys enforced (verified, not assumed), a busy timeout, and WAL
 * journaling with synchronous=NORMAL for a local file. Creates the parent
 * directory for a file path; never deletes or resets anything.
 */
export function openDatabase(path: string, { busyTimeoutMs = 5000 }: OpenOptions = {}): Database {
  const memory = path === MEMORY;
  const file = memory ? path : resolve(path);
  if (!memory) mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    db.exec('PRAGMA foreign_keys = ON');
    if (!memory) {
      const { journal_mode: mode } = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      if (mode !== 'wal') throw new Error(`SQLite refused WAL journal mode (got "${mode}")`);
      db.exec('PRAGMA synchronous = NORMAL');
    }
    const { foreign_keys: fk } = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    if (fk !== 1) throw new Error('SQLite foreign-key enforcement could not be enabled');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Closes the connection if open. Safe to call more than once. */
export function closeDatabase(db: Database): void {
  if (!db.isOpen) return;
  try {
    db.exec('PRAGMA optimize');
  } finally {
    db.close();
  }
}

/** Runs fn inside BEGIN IMMEDIATE … COMMIT, rolling back on any error. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
