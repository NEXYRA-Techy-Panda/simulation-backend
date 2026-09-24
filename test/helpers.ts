import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, type Database, MEMORY, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';

/** A test-owned temp directory (never the user's data/ directory). */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'nexyra-sim-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function memoryDb({ seed = true } = {}): Database {
  const db = openDatabase(MEMORY);
  runMigrations(db);
  if (seed) seedDemoInventory(db);
  return db;
}

export { closeDatabase };

export const count = (db: Database, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Asserts fn throws an SQLite/constraint error whose message matches re. */
export function sqliteError(re: RegExp): (err: unknown) => boolean {
  return (err) => err instanceof Error && re.test(err.message);
}
