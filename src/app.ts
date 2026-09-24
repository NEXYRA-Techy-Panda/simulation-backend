import cors from 'cors';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Database } from './db/connection.js';
import type { SimulationEngine } from './engine/engine.js';
import { errorHandler, notFound } from './http/errors.js';
import { requestId } from './http/requestId.js';
import { healthRouter } from './routes/health.js';
import { inventoryRouter } from './routes/inventory.js';
import { simulationRouter } from './routes/simulation.js';

export interface AppDeps {
  /** Open, migrated simulator database (owned and closed by the caller). */
  db: Database;
  /** The authoritative simulation engine for this process. */
  engine: SimulationEngine;
}

export function createApp(config: Config, { db, engine }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: config.frontendOrigin }));
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.use('/api/v1', healthRouter(engine));
  app.use('/api/v1', inventoryRouter(db));
  app.use('/api/v1', simulationRouter(engine));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
