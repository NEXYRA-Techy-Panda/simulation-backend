import { createHash } from 'node:crypto';
import { type Database, transaction } from './connection.js';
import { type Migration, migrations as defaultMigrations } from './migrations/index.js';

export class MigrationError extends Error {}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

/** Line-ending-insensitive so a CRLF checkout does not look like an edited migration. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function ensureHistoryTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version >= 1),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_utc TEXT NOT NULL
  ) STRICT`);
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Applies pending migrations in order, in one IMMEDIATE transaction, and
 * records each in schema_migrations. Idempotent: already-applied versions
 * are skipped. Refuses (without changes) if an applied migration was edited
 * or is unknown to this build. Forward-only; never drops or resets data.
 */
export function runMigrations(db: Database, list: readonly Migration[] = defaultMigrations): MigrationResult {
  list.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version < 1 || (i > 0 && m.version <= list[i - 1]!.version)) {
      throw new MigrationError(`Migration list must have strictly increasing positive versions (at ${m.name})`);
    }
  });

  ensureHistoryTable(db);
  const result = transaction(db, () => {
    const appliedRows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as unknown as AppliedRow[];
    const known = new Map(list.map((m) => [m.version, m]));
    for (const row of appliedRows) {
      const m = known.get(row.version);
      if (!m) {
        throw new MigrationError(`Database has migration ${row.version} (${row.name}) unknown to this build; refusing to continue`);
      }
      if (migrationChecksum(m.sql) !== row.checksum) {
        throw new MigrationError(`Applied migration ${row.version} (${row.name}) was modified after being applied; add a new migration instead`);
      }
    }

    const done = new Set(appliedRows.map((r) => r.version));
    const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_utc) VALUES (?, ?, ?, ?)');
    const applied: number[] = [];
    for (const m of list) {
      if (done.has(m.version)) continue;
      db.exec(m.sql);
      record.run(m.version, m.name, migrationChecksum(m.sql), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
      applied.push(m.version);
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new MigrationError(`Foreign-key violations after migration: ${JSON.stringify(violations)}`);
    return applied;
  });

  return { applied: result, currentVersion: currentSchemaVersion(db) };
}

export function currentSchemaVersion(db: Database): number {
  ensureHistoryTable(db);
  const row = db.prepare('SELECT coalesce(max(version), 0) AS v FROM schema_migrations').get() as { v: number };
  return row.v;
}

export function latestKnownVersion(list: readonly Migration[] = defaultMigrations): number {
  return list.at(-1)?.version ?? 0;
}
