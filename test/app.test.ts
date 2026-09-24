import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { assertDevice, assertPolicy, assertRoom } from '../src/contract/validators.js';
import type { Inventory } from '../src/db/inventory.js';
import { closeDatabase, memoryDb } from './helpers.js';

const config = loadConfig({ JSON_BODY_LIMIT: '1kb' });
const db = memoryDb();

interface Envelope {
  data?: unknown;
  meta?: { request_id: string };
  error?: { code: string; message: string };
}
const readJson = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

let server: Server;
let base: string;

before(async () => {
  server = createApp(config, { db }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())).then(() => closeDatabase(db)));

describe('GET /api/v1/health', () => {
  it('returns the uninitialised contract shape in the success envelope', async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const body = await readJson(res);
    assert.deepEqual(body.data, {
      status: 'not_initialized',
      run_id: null,
      sim_time_utc: null,
      contract_version: '1.0.1',
    });
    assert.match(body.meta?.request_id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('x-request-id'), body.meta?.request_id);
  });
});

describe('GET /api/v1/inventory', () => {
  it('returns the seeded database records in contract shapes', async () => {
    const res = await fetch(`${base}/api/v1/inventory`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    const inv = body.data as Inventory;
    assert.match(body.meta?.request_id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(inv.rooms.length, 5);
    assert.equal(inv.devices.length, 18);
    assert.equal(inv.policies.length, 20);
    inv.rooms.forEach(assertRoom);
    inv.devices.forEach(assertDevice);
    inv.policies.forEach(assertPolicy);

    const ws = inv.devices.find((d) => d.device_id === 'dev-open-workstations');
    assert.deepEqual([ws?.quantity, ws?.nominal_power_w], [8, 960]);
    const fridge = inv.devices.find((d) => d.device_id === 'dev-pantry-fridge');
    assert.deepEqual([fridge?.always_on, fridge?.control], [true, 'always_on']);
    const fridgePolicy = inv.policies.find((p) => p.applies_to === 'device:dev-pantry-fridge');
    assert.deepEqual([fridgePolicy?.kind, fridgePolicy?.rules], ['always_on', { always_on_exception: true }]);
    const hours = inv.policies.find((p) => p.kind === 'office_hours');
    assert.deepEqual(hours?.rules, { working_days_iso: [1, 2, 3, 4, 5], open_local: '09:00', close_local: '18:00', overnight: false });
    assert.equal(inv.devices.every((d) => inv.policies.some((p) => p.applies_to === `device:${d.device_id}`)), true);
  });

  it('reflects database edits (not a static fixture)', async () => {
    db.prepare("UPDATE rooms SET capacity = 7 WHERE room_id = 'room-meeting'").run();
    const inv = (await readJson(await fetch(`${base}/api/v1/inventory`))).data as Inventory;
    assert.equal(inv.rooms.find((r) => r.room_id === 'room-meeting')?.capacity, 7);
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for unknown routes', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await readJson(res), {
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/v1/does-not-exist' },
    });
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const res = await fetch(`${base}/api/v1/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await readJson(res)).error?.code, 'VALIDATION_ERROR');
  });

  it('returns REQUEST_TOO_LARGE above the JSON body limit', async () => {
    const res = await fetch(`${base}/api/v1/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(2048) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await readJson(res)).error?.code, 'REQUEST_TOO_LARGE');
  });

  it('does not grant CORS to other origins', async () => {
    const res = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://evil.example' } });
    assert.notEqual(res.headers.get('access-control-allow-origin'), 'http://evil.example');
  });
});

describe('config', () => {
  it('uses the documented defaults', () => {
    assert.deepEqual(loadConfig({}), {
      port: 4000, host: '127.0.0.1', frontendOrigin: 'http://localhost:3000',
      jsonBodyLimit: '100kb', shutdownTimeoutMs: 10000,
      databasePath: 'data/simulation.sqlite', sqliteBusyTimeoutMs: 5000,
    });
  });

  it('rejects non-origin URLs and invalid ports', () => {
    assert.throws(() => loadConfig({ FRONTEND_ORIGIN: 'http://localhost:3000/app' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ JSON_BODY_LIMIT: 'lots' }), ConfigError);
  });
});
