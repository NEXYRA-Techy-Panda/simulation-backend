import { Router } from 'express';
import type { HistoryJobService } from '../history/service.js';
import { HISTORY_ALLOWED_FIELDS } from '../history/request.js';
import { objectBody } from '../http/body.js';
import { sendData } from '../http/envelope.js';
import { ApiError } from '../http/errors.js';

/**
 * K005-PREP history-job routes (contracts/v1/API.md):
 *   POST /history/jobs      → 202 { job_id, status: "queued", ... }
 *   GET  /history/jobs/:id  → { job_id, status: queued|running|succeeded|failed, result_ref, ... }
 * Mount with `app.use('/api/v1', historyJobsRouter(service))` — the mounting
 * step is documented (docs/K005_HISTORY_GENERATION_PREP_EVIDENCE.md) and not
 * applied to the shared app startup on this branch.
 */
export function historyJobsRouter(service: HistoryJobService): Router {
  const router = Router();

  router.post('/history/jobs', (req, res) => {
    sendData(res, service.submit(objectBody(req, HISTORY_ALLOWED_FIELDS)), 202);
  });

  router.get('/history/jobs/:id', (req, res) => {
    const job = service.get(req.params.id);
    if (!job) throw new ApiError(404, 'NOT_FOUND', `History job "${req.params.id}" not found`);
    sendData(res, job);
  });

  return router;
}
