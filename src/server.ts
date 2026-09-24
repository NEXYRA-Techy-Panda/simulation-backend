import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { loadLocalEnv } from './env.js';

loadLocalEnv();

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Startup applies pending forward-only migrations (never resets data) and
// does NOT seed; seeding is the explicit `npm run db:seed` step.
const db = openDatabase(config.databasePath, { busyTimeoutMs: config.sqliteBusyTimeoutMs });
try {
  const { applied, currentVersion } = runMigrations(db);
  console.log(`database ${config.databasePath}: schema v${currentVersion}${applied.length ? ` (applied ${applied.join(', ')})` : ''}`);
} catch (err) {
  closeDatabase(db);
  console.error(`Database migration failed: ${(err as Error).message}`);
  process.exit(1);
}

const { host, port, shutdownTimeoutMs } = config;
const server = createApp(config, { db }).listen(port, host, () => {
  const actual = (server.address() as AddressInfo).port;
  console.log(`simulation-backend listening on http://${host}:${actual} (health: /api/v1/health, pid ${process.pid})`);
});
server.on('error', (err) => {
  console.error(`Failed to listen on ${host}:${port}: ${err.message}`);
  closeDatabase(db);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} received; closing server`);
  const timer = setTimeout(() => {
    console.error('Shutdown deadline reached; closing remaining connections');
    server.closeAllConnections();
  }, shutdownTimeoutMs);
  timer.unref();
  server.close((err) => {
    if (err) console.error(err);
    closeDatabase(db);
    console.log('database closed; exiting');
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));
// When started with an IPC channel (process managers, tests), a "shutdown"
// message triggers the same path. Windows cannot deliver SIGTERM/SIGINT to
// another process gracefully, so this is the supported mechanism there.
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown('shutdown message');
});
