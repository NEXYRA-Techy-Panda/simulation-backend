import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { realSchedulerDeps } from '../src/engine/scheduler.js';
import { closeDatabase, memoryDb } from './helpers.js';

interface Body { data?: Record<string, unknown>; error?: { code: string; message: string; field?: string } }

// Real scheduler timers, with a controllable offset added to the monotonic
// clock so a large high-speed backlog can be created instantly.
let offsetMs = 0;
const db = memoryDb();
const engine = new SimulationEngine(db, { schedulerDeps: { ...realSchedulerDeps, now: () => performance.now() + offsetMs } });
let server: Server;
let base: string;

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body; ms: number }> => {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body, ms: performance.now() - t0 };
};

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

describe('simulation HTTP API (sequential)', () => {
  it('reports not_initialized before any run and rejects run-dependent calls with contract errors', async () => {
    const state = await call('GET', '/api/v1/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.data, {
      status: 'not_initialized', speed: 1, run_id: null, seq: null, sim_time_utc: null, rooms: [], devices: [], office: null,
      occupancy: null, calendar: null, overrides: [], pending_changes: [],
    });
    assert.deepEqual((await call('GET', '/api/v1/health')).body.data,
      { status: 'not_initialized', run_id: null, sim_time_utc: null, contract_version: '1.0.1' });
    for (const path of ['/api/v1/control/pause', '/api/v1/control/resume']) {
      const r = await call('POST', path);
      assert.equal(r.status, 409, path);
      assert.equal(r.body.error?.code, 'CONFLICT');
    }
    const cmd = await call('POST', '/api/v1/devices/dev-meeting-light', { manual_state: 'on' });
    assert.deepEqual([cmd.status, cmd.body.error?.code], [409, 'CONFLICT']);
  });

  it('validates control bodies', async () => {
    for (const [path, body, field] of [
      ['/api/v1/control/speed', { speed: 5 }, 'speed'],
      ['/api/v1/control/speed', {}, 'speed'],
      ['/api/v1/control/start', { speed: '60' }, 'speed'],
      ['/api/v1/control/start', { turbo: true }, 'turbo'],
    ] as const) {
      const r = await call('POST', path, body);
      assert.deepEqual([r.status, r.body.error?.code, r.body.error?.field], [400, 'VALIDATION_ERROR', field], JSON.stringify(body));
    }
    assert.equal(engine.lifecycle, 'not_initialized');
  });

  it('starts, commands lighting, and exposes real state', async () => {
    const start = await call('POST', '/api/v1/control/start', { speed: 60 });
    assert.equal(start.status, 200);
    const { run_id: runId } = start.body.data as { run_id: string };
    assert.deepEqual({ ...start.body.data, run_id: 'x' }, { run_id: 'x', seq: 1, sim_time_utc: '2025-12-31T18:30:00Z', status: 'running', speed: 60 });

    const on = await call('POST', '/api/v1/devices/dev-meeting-light', { manual_state: 'on' });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.data?.override, { active: true, on: true });
    assert.equal(on.body.data?.device_id, 'dev-meeting-light');

    const state = (await call('GET', '/api/v1/state')).body.data as {
      run_id: string; rooms: unknown[];
      devices: { device_id: string; on: boolean; power_w: number; energy_kwh: number }[];
    };
    assert.equal(state.run_id, runId);
    assert.equal(state.rooms.length, 5);
    assert.equal(state.devices.length, 18);
    const light = state.devices.find((d) => d.device_id === 'dev-meeting-light')!;
    assert.deepEqual(light, {
      device_id: 'dev-meeting-light', room_id: 'room-meeting', on: true, power_w: 72, control_source: 'override',
      override: { active: true, on: true }, policy_ref: 'pol-meeting-light:1', energy_kwh: light.energy_kwh,
    });
    assert.equal(state.devices.find((d) => d.device_id === 'dev-pantry-fridge')?.power_w, 150);

    const clear = await call('POST', '/api/v1/devices/dev-meeting-light', { clear_override: true });
    assert.equal(clear.body.data?.override, null);
    const after = (await call('GET', '/api/v1/state')).body.data as { devices: { device_id: string; on: boolean }[] };
    assert.equal(after.devices.find((d) => d.device_id === 'dev-meeting-light')?.on, false); // policy: closed at 00:00 IST, vacant

    const health = (await call('GET', '/api/v1/health')).body.data as { status: string; run_id: string };
    assert.deepEqual([health.status, health.run_id], ['ok', runId]);
  });

  it('rejects invalid devices and unsupported controls', async () => {
    const cases: [string, unknown, number, string][] = [
      ['dev-nope', { manual_state: 'on' }, 404, 'NOT_FOUND'],
      ['dev-pantry-fridge', { manual_state: 'off' }, 400, 'VALIDATION_ERROR'],
      ['dev-meeting-light', { manual_state: 'dim' }, 400, 'VALIDATION_ERROR'],
      ['dev-meeting-light', { clear_override: false }, 400, 'VALIDATION_ERROR'],
      ['dev-meeting-light', { manual_state: 'on', clear_override: true }, 400, 'VALIDATION_ERROR'],
      ['dev-meeting-light', { brightness: 3 }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [id, body, status, code] of cases) {
      const r = await call('POST', `/api/v1/devices/${id}`, body);
      assert.deepEqual([r.status, r.body.error?.code], [status, code], `${id} ${JSON.stringify(body)}`);
    }
  });

  it('stays responsive while working through a large high-speed backlog', async () => {
    await call('POST', '/api/v1/control/speed', { speed: 1000 });
    const t0 = (await call('GET', '/api/v1/state')).body.data as { sim_time_utc: string };
    offsetMs += 3_600_000; // one real hour owed at 1000x = 360,000 steps
    const latencies: number[] = [];
    let last = Date.parse(t0.sim_time_utc);
    for (let i = 0; i < 10; i++) {
      const h = await call('GET', '/api/v1/health');
      latencies.push(h.ms);
      const now = Date.parse((h.body.data as { sim_time_utc: string }).sim_time_utc);
      assert.ok(now >= last, 'processed time only moves forward');
      last = now;
      await new Promise((r) => setTimeout(r, 20));
    }
    const advancedSeconds = (last - Date.parse(t0.sim_time_utc)) / 1000;
    assert.ok(advancedSeconds > 0, 'backlog is being processed');
    assert.ok(advancedSeconds < 3_600_000, 'exposed time is processed time, not the owed target');
    assert.ok(Math.max(...latencies) < 250, `max health latency ${Math.max(...latencies).toFixed(1)} ms`);
    console.log(`backlog check: processed ${advancedSeconds} s simulated; health latency max ${Math.max(...latencies).toFixed(1)} ms`);

    const pause = await call('POST', '/api/v1/control/pause');
    assert.equal((pause.body.data as { status: string }).status, 'paused');
    const frozen = (await call('GET', '/api/v1/state')).body.data as { sim_time_utc: string };
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(((await call('GET', '/api/v1/state')).body.data as { sim_time_utc: string }).sim_time_utc, frozen.sim_time_utc);
  });

  it('reset returns a new run at seq 0 and the initial time', async () => {
    const old = engine.summary().run_id;
    const r = await call('POST', '/api/v1/control/reset');
    const data = r.body.data as { run_id: string; seq: number; sim_time_utc: string; status: string };
    assert.notEqual(data.run_id, old);
    assert.deepEqual([data.seq, data.sim_time_utc, data.status], [0, '2025-12-31T18:30:00Z', 'paused']);
  });
});
