// npm run db:seed — insert missing demo inventory records only (never updates or deletes).
import { loadConfig } from '../config.js';
import { closeDatabase, openDatabase } from '../db/connection.js';
import { seedDemoInventory } from '../db/seed/seed.js';
import { loadLocalEnv } from '../env.js';

loadLocalEnv();
const config = loadConfig();
const db = openDatabase(config.databasePath, { busyTimeoutMs: config.sqliteBusyTimeoutMs });
try {
  const report = seedDemoInventory(db);
  console.log(`database: ${config.databasePath}`);
  for (const [table, { inserted, existing }] of Object.entries(report)) {
    console.log(`${table.padEnd(16)} inserted ${inserted}, already present ${existing}`);
  }
  const count = (t: string): number => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(`totals: rooms ${count('rooms')}, devices ${count('devices')}, policies ${count('policies')}, policy_versions ${count('policy_versions')}`);
} catch (err) {
  console.error(`seed failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
