import cors from 'cors';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Database } from './db/connection.js';
import type { SimulationEngine } from './engine/engine.js';
import { errorHandler, notFound } from './http/errors.js';
import { requestId } from './http/requestId.js';
import { healthRouter } from './routes/health.js';
import { inventoryRouter } from './routes/inventory.js';
import { exportsRouter, type ExportDatabaseProvider } from './routes/exports.js';
import { simulationRouter } from './routes/simulation.js';

export interface AppDeps {
  /** Open, migrated simulator database (owned and closed by the caller). */
  db: Database;
  /** The authoritative simulation engine for this process. */
  engine: SimulationEngine;
  /** Dedicated read-only provider used for consistent export snapshots. */
  exportDatabase?: ExportDatabaseProvider;
}

export function createApp(config: Config, { db, engine, exportDatabase }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({
    origin: config.frontendOrigin,
    exposedHeaders: ['Content-Disposition', 'X-Request-Id'],
  }));
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.use('/api/v1', healthRouter(engine));
  app.use('/api/v1', inventoryRouter(db));
  app.use('/api/v1', exportsRouter(exportDatabase ?? { open: () => db }));
  app.use('/api/v1', simulationRouter(engine));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
