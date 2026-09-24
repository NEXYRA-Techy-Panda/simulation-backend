import { Router } from 'express';
import type { Database } from '../db/connection.js';
import { getInventory } from '../db/inventory.js';
import { sendData } from '../http/envelope.js';

/** GET /api/v1/inventory — current database-backed rooms, devices and latest policy versions. */
export function inventoryRouter(db: Database): Router {
  const router = Router();
  router.get('/inventory', (_req, res) => {
    sendData(res, getInventory(db));
  });
  return router;
}
