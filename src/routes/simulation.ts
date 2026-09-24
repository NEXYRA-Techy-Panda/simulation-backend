import { Router } from 'express';
import { type DeviceCommand, type SimulationEngine } from '../engine/engine.js';
import { objectBody } from '../http/body.js';
import { sendData } from '../http/envelope.js';
import { ApiError } from '../http/errors.js';

/**
 * K1 simulation routes (contracts/v1/API.md): state, lifecycle control,
 * speed, and manual lighting control. Lifecycle table:
 *   start  : not_initialized → running (new run); paused → running; running → no-op
 *   resume : paused → running; running → no-op; no run → 409 CONFLICT
 *   pause  : running → paused; paused → no-op; no run → 409 CONFLICT
 *   reset  : any → NEW run, paused, seq 0 (previous run ended, history kept)
 *   speed  : any; value must be 1|2|10|60|100|1000 (else 400)
 */
export function simulationRouter(engine: SimulationEngine): Router {
  const router = Router();

  router.get('/state', (_req, res) => {
    sendData(res, engine.getState());
  });

  router.post('/control/start', (req, res) => {
    engine.start(objectBody(req, ['speed']).speed);
    sendData(res, engine.summary());
  });

  router.post('/control/resume', (req, res) => {
    engine.resume(objectBody(req, ['speed']).speed);
    sendData(res, engine.summary());
  });

  router.post('/control/pause', (req, res) => {
    objectBody(req, []);
    engine.pause();
    sendData(res, engine.summary());
  });

  router.post('/control/reset', (req, res) => {
    objectBody(req, []);
    engine.reset();
    sendData(res, engine.summary());
  });

  router.post('/control/speed', (req, res) => {
    const body = objectBody(req, ['speed']);
    if (!('speed' in body)) throw new ApiError(400, 'VALIDATION_ERROR', 'speed is required', 'speed');
    engine.setSpeed(body.speed);
    sendData(res, { speed: engine.currentSpeed });
  });

  router.post('/devices/:id', (req, res) => {
    const body = objectBody(req, ['manual_state', 'clear_override']);
    const hasSet = 'manual_state' in body;
    const hasClear = 'clear_override' in body;
    let command: DeviceCommand;
    if (hasSet && !hasClear && (body.manual_state === 'on' || body.manual_state === 'off')) {
      command = { kind: 'set', on: body.manual_state === 'on' };
    } else if (hasClear && !hasSet && body.clear_override === true) {
      command = { kind: 'clear' };
    } else {
      throw new ApiError(400, 'VALIDATION_ERROR',
        'Body must be exactly {"manual_state":"on"|"off"} or {"clear_override":true}', hasSet ? 'manual_state' : 'clear_override');
    }
    sendData(res, engine.commandDevice(req.params.id, command));
  });

  return router;
}
