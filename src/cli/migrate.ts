// npm run db:migrate — apply pending forward-only migrations (idempotent, non-destructive).
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { loadLocalEnv } from '../env.js';

loadLocalEnv();
const config = loadConfig();
const db = openDatabase(config.databasePath, { busyTimeoutMs: config.sqliteBusyTimeoutMs });
try {
  const { applied, currentVersion } = runMigrations(db);
  console.log(`database: ${config.databasePath}`);
  console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'no pending migrations');
  console.log(`schema version: ${currentVersion}`);
} catch (err) {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
