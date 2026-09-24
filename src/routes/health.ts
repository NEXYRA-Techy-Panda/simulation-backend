import { Router } from 'express';
import { CONTRACT_VERSION } from '../contract.js';
import { sendData } from '../http/envelope.js';

/**
 * GET /api/v1/health — scaffold stage. The simulation engine does not exist
 * yet, so the contract's uninitialised shape is returned: no run id and no
 * simulated time are invented. HTTP 200 means the service itself is reachable.
 */
export function healthRouter(): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    sendData(res, {
      status: 'not_initialized',
      run_id: null,
      sim_time_utc: null,
      contract_version: CONTRACT_VERSION,
    });
  });
  return router;
}
