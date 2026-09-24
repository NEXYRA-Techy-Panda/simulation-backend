import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { fakeClock } from './engineHelpers.js';
import { closeDatabase, memoryDb } from './helpers.js';

interface Body {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; field?: string };
  meta?: { request_id: string };
}

interface RoomState { room_id: string; climate: { temp_c: number; rh_pct: number } | null }
interface StateBody { seq: number; sim_time_utc: string; status: string; rooms: RoomState[]; office: { power_w: number; energy_kwh: number } | null; ac_power_model: string | null }

// Inert scheduler timers: no simulated time passes unless a test advances it,
// so HTTP command effects are deterministic.
const db = memoryDb();
const clock = fakeClock();
const engine = new SimulationEngine(db, { schedulerDeps: clock.deps });
let server: Server;
let base: string;

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
};

const state = async (): Promise<StateBody> => (await call('GET', '/api/v1/state')).body.data as unknown as StateBody;

before(async () => {
  server = createApp(loadConfig({}), { db, engine }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  engine.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase(db);
});

describe('POST /api/v1/environment (sequential)', () => {
  it('reports the documented conflict before any run exists', async () => {
    const r = await call('POST', '/api/v1/environment', { room_id: 'room-open-workspace', temp_c: 30, rh_pct: 40 });
    assert.deepEqual([r.status, r.body.error?.code], [409, 'CONFLICT']);
    assert.equal((await state()).status, 'not_initialized');
  });

  it('accepts a valid command in the success envelope and changes only that room', async () => {
    await call('POST', '/api/v1/control/start', {});
    const before = await state();
    assert.equal(before.ac_power_model, 'ac-demand-v1');
    const others = before.rooms.filter((r) => r.room_id !== 'room-open-workspace');

    const r = await call('POST', '/api/v1/environment', { room_id: 'room-open-workspace', temp_c: 30, rh_pct: 40 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data?.room_id, 'room-open-workspace');
    assert.equal(r.body.data?.temp_c, 30);
    assert.equal(r.body.data?.rh_pct, 40);
    assert.equal(r.body.data?.applies_from, 'next_step');
    assert.equal(typeof r.body.data?.seq, 'number');
    assert.match(r.body.meta?.request_id ?? '', /^[0-9a-f-]{36}$/);

    const after = await state();
    assert.deepEqual(after.rooms.find((x) => x.room_id === 'room-open-workspace')?.climate, { temp_c: 30, rh_pct: 40 });
    assert.deepEqual(after.rooms.filter((x) => x.room_id !== 'room-open-workspace'), others);
    assert.equal(after.sim_time_utc, before.sim_time_utc); // commands never advance time
  });

  it('rejects invalid bodies and unknown rooms without mutating state', async () => {
    const before = await state();
    const cases: [Record<string, unknown>, number, string, string | undefined][] = [
      [{ room_id: 'room-open-workspace', temp_c: 30, rh_pct: 40, turbo: true }, 400, 'VALIDATION_ERROR', 'turbo'],
      [{ room_id: 'room-open-workspace', rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
      [{ room_id: 'room-open-workspace', temp_c: 30 }, 400, 'VALIDATION_ERROR', 'rh_pct'],
      [{ room_id: 'room-open-workspace', temp_c: '30', rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
      [{ room_id: 'room-open-workspace', temp_c: 70, rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
      [{ room_id: 'room-open-workspace', temp_c: 30, rh_pct: 101 }, 400, 'VALIDATION_ERROR', 'rh_pct'],
      [{ room_id: 'room-nope', temp_c: 30, rh_pct: 40 }, 404, 'NOT_FOUND', 'room_id'],
      [{ room_id: 'room-open-workspace', temp_c: 30, rh_pct: 40, setpoint_c: 24 }, 400, 'VALIDATION_ERROR', 'setpoint_c'],
    ];
    for (const [body, status, code, field] of cases) {
      const r = await call('POST', '/api/v1/environment', body);
      assert.deepEqual([r.status, r.body.error?.code, r.body.error?.field], [status, code, field], JSON.stringify(body));
    }
    const after = await state();
    assert.deepEqual(after.rooms, before.rooms);
    assert.equal(after.seq, before.seq);
  });

  it('accepts a climate change while paused without advancing time or energy', async () => {
    await call('POST', '/api/v1/control/pause', {});
    const before = await state();
    const r = await call('POST', '/api/v1/environment', { room_id: 'room-meeting', temp_c: 19, rh_pct: 70 });
    assert.equal(r.status, 200);
    const after = await state();
    assert.equal(after.status, 'paused');
    assert.equal(after.sim_time_utc, before.sim_time_utc);
    assert.equal(after.office?.energy_kwh, before.office?.energy_kwh);
    assert.deepEqual(after.rooms.find((x) => x.room_id === 'room-meeting')?.climate, { temp_c: 19, rh_pct: 70 });
  });
});
