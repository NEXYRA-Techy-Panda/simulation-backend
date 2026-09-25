/**
 * Integration of K005 history jobs / K004-FAST1 hourly recording with K003 export
 * (merge into main). In-memory databases only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { closeDatabase, memoryDb } from './helpers.js';
import { fakeEngine } from './engineHelpers.js';
import { prepareExport } from '../src/export/dataset.js';
import { DEFAULT_EXPORT_LIMITS, type ExportSelection } from '../src/export/types.js';
import { HistoryJobService } from '../src/history/service.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sel = (runId: string, fromUtc: string, toUtc: string, intervalSeconds: 60 | 3600): ExportSelection =>
  ({ runId, format: 'json', fromUtc, toUtc, intervalSeconds } as ExportSelection);
const conflictOn = (field: string, re: RegExp) => (e: { status?: number; field?: string; message?: string }) =>
  e.status === 409 && e.field === field && re.test(e.message ?? '');

describe('K003 export × K005 history jobs × K004-FAST1 hourly runs', () => {
  it('exports a succeeded 60 s history run and refuses one whose job failed', async () => {
    const db = memoryDb();
    try {
      const ok = new HistoryJobService(db);
      ok.start();
      const good = ok.submit({ from: '2026-01-05T00:00:00Z', to: '2026-01-05T01:00:00Z', seed: 1 }) as Json;
      await ok.idle();
      const goodJob = ok.get(good.job_id) as Json;
      assert.equal(goodJob.status, 'succeeded');
      const exp = prepareExport(db, sel(goodJob.run_id, '2026-01-05T00:00:00Z', '2026-01-05T01:00:00Z', 3600), DEFAULT_EXPORT_LIMITS) as Json;
      assert.ok(exp);

      let chunks = 0;
      const bad = new HistoryJobService(db, { chunkSteps: 60, advance: (engine, n) => { chunks += 1; if (chunks === 3) throw new Error('boom'); engine.advanceSteps(n); } });
      bad.start();
      const b = bad.submit({ from: '2026-01-06T00:00:00Z', to: '2026-01-06T01:00:00Z', seed: 1 }) as Json;
      await bad.idle();
      const failed = bad.get(b.job_id) as Json;
      assert.equal(failed.status, 'failed');
      // Even the committed first 20 minutes are refused: failed output is not history.
      assert.throws(() => prepareExport(db, sel(failed.run_id, '2026-01-06T00:00:00Z', '2026-01-06T00:20:00Z', 60), DEFAULT_EXPORT_LIMITS),
        conflictOn('run_id', /history job that is failed/));
    } finally { closeDatabase(db); }
  });

  it('refuses hourly-recorded runs explicitly; interactive 60 s runs still export', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.advanceSteps(720);
      const hourly = (engine.getState() as Json).run_id as string;
      assert.throws(() => prepareExport(db, sel(hourly, '2025-12-31T18:30:00Z', '2025-12-31T20:30:00Z', 3600), DEFAULT_EXPORT_LIMITS),
        conflictOn('run_id', /3600 s intervals/));
      engine.reset(1);
      engine.advanceSteps(360);
      const minute = (engine.getState() as Json).run_id as string;
      assert.ok(prepareExport(db, sel(minute, '2025-12-31T18:30:00Z', '2025-12-31T19:30:00Z', 3600), DEFAULT_EXPORT_LIMITS));
    } finally { closeDatabase(db); }
  });
});
