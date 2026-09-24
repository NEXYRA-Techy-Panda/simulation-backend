import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { INITIAL_SIM_TIME_UTC } from '../src/engine/constants.js';
import { closeDatabase, memoryDb } from './helpers.js';
import { fakeEngine, stateOf } from './engineHelpers.js';

const db = memoryDb();
const { engine } = fakeEngine(db);
engine.start(1, 2026);
engine.advanceSteps(12);
const runId = stateOf(engine).run_id!;
const from = INITIAL_SIM_TIME_UTC;
const to = new Date(Date.parse(INITIAL_SIM_TIME_UTC) + 120_000).toISOString().replace('.000Z', 'Z');
const config = loadConfig({ JSON_BODY_LIMIT: '10kb' });

let server: Server;
let base: string;

before(async () => {
  server = createApp(config, { db, engine }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())).then(() => closeDatabase(db)));

function exportQuery(format: 'json' | 'csv'): string {
  return new URLSearchParams({
    run_id: runId,
    format,
    from,
    to,
    interval_seconds: '60',
  }).toString();
}

describe('K003 export HTTP surface', () => {
  it('lists committed historical coverage without using live simulated time', async () => {
    const response = await fetch(`${base}/api/v1/runs?page=1&page_size=50`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { runs: Array<{ run_id: string; committed_start_utc: string; committed_end_utc: string; committed_interval_count: number; exportable: boolean }> };
      meta: { request_id: string; pagination: { total_items: number } };
    };
    const run = body.data.runs.find((item) => item.run_id === runId);
    assert.equal(run?.committed_start_utc, from);
    assert.equal(run?.committed_end_utc, to);
    assert.equal(run?.committed_interval_count, 36);
    assert.equal(run?.exportable, true);
    assert.equal(body.meta.pagination.total_items, 1);
  });

  it('serves GET JSON and POST CSV with one identity, equal energy, and safe headers', async () => {
    const beforeState = stateOf(engine);
    const beforeRows = db.prepare('SELECT COUNT(*) AS n FROM device_intervals WHERE run_id = ?').get(runId) as { n: number };

    const jsonResponse = await fetch(`${base}/api/v1/export?${exportQuery('json')}`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(jsonResponse.status, 200);
    assert.match(jsonResponse.headers.get('content-type') ?? '', /^application\/json/);
    assert.match(jsonResponse.headers.get('content-disposition') ?? '', /^attachment; filename="nexyra-.*\.json"$/);
    assert.match(jsonResponse.headers.get('access-control-expose-headers') ?? '', /Content-Disposition/i);
    const json = await jsonResponse.json() as {
      export: { export_id: string };
      device_intervals: Array<{ energy_kwh: number }>;
    };

    const csvResponse = await fetch(`${base}/api/v1/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({
        run_id: runId,
        format: 'csv',
        from,
        to,
        interval_seconds: 60,
      }),
    });
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type') ?? '', /^text\/csv/);
    const csv = await csvResponse.text();
    const lines = csv.trimEnd().split('\n');
    const marker = ',"{""schema_version""';
    const metadataStart = lines[1]!.indexOf(marker);
    assert.ok(metadataStart >= 0);
    const metadata = lines[1]!.slice(metadataStart + 2);
    const jsonMetadata = metadata.slice(0, -1).replaceAll('""', '"');
    const envelope = JSON.parse(jsonMetadata) as { export: { export_id: string } };

    assert.equal(envelope.export.export_id, json.export.export_id);
    const sourceEnergy = (db.prepare('SELECT SUM(energy_kwh) AS e FROM device_intervals WHERE run_id = ?').get(runId) as { e: number }).e;
    const jsonEnergy = json.device_intervals.reduce((sum, row) => sum + row.energy_kwh, 0);
    assert.ok(Math.abs(jsonEnergy - sourceEnergy) < 1e-9);
    assert.equal(lines.length - 1, 36);
    assert.equal(lines.slice(1).filter((line) => line.includes('""schema_version""')).length, 1);

    const afterState = stateOf(engine);
    const afterRows = db.prepare('SELECT COUNT(*) AS n FROM device_intervals WHERE run_id = ?').get(runId) as { n: number };
    assert.deepEqual([afterState.seq, afterState.sim_time_utc], [beforeState.seq, beforeState.sim_time_utc]);
    assert.equal(afterRows.n, beforeRows.n);
  });

  it('releases export capacity when the read-only provider fails to open', async () => {
    let attempts = 0;
    const flaky = createApp(config, {
      db,
      engine,
      exportDatabase: {
        open: () => {
          attempts += 1;
          if (attempts <= 2) throw new Error('synthetic reader-open failure');
          return db;
        },
      },
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => flaky.once('listening', resolve));
    const flakyBase = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const first = await fetch(`${flakyBase}/api/v1/export?${exportQuery('json')}`);
      const second = await fetch(`${flakyBase}/api/v1/export?${exportQuery('json')}`);
      assert.equal(first.status, 500);
      assert.equal(second.status, 500);
      const third = await fetch(`${flakyBase}/api/v1/export?${exportQuery('json')}`);
      assert.equal(third.status, 200);
    } finally {
      console.error = originalConsoleError;
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
    }
  });

  it('rejects unknown fields, invalid resolutions, and unknown runs before sending a file', async () => {
    const unknown = await fetch(`${base}/api/v1/export?${exportQuery('json')}&fault=true`);
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'VALIDATION_ERROR');

    const badResolution = await fetch(`${base}/api/v1/export?${exportQuery('json').replace('interval_seconds=60', 'interval_seconds=120')}`);
    assert.equal(badResolution.status, 400);

    const missing = await fetch(`${base}/api/v1/export?${exportQuery('json').replace(runId, 'run-does-not-exist')}`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');

    const contractValidButMissing = await fetch(`${base}/api/v1/export?${exportQuery('json').replace(runId, 'missing%20run')}`);
    assert.equal(contractValidButMissing.status, 404);
    assert.equal(((await contractValidButMissing.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});
