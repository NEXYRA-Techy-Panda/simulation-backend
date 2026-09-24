import { Router } from 'express';
import type { SimulationEngine } from '../engine/engine.js';
import { sendData } from '../http/envelope.js';

/**
 * GET /api/v1/health — reachable service plus the engine's real state:
 * not_initialized (run_id/sim_time_utc null) until a run exists, then ok
 * with the actual run id and processed simulated time. Never invented.
 */
export function healthRouter(engine: SimulationEngine): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    sendData(res, engine.health());
  });
  return router;
}
