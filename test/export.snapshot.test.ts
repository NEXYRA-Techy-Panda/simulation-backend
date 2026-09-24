import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDatabase, openDatabase, openReadOnlyDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { INITIAL_SIM_TIME_UTC } from '../src/engine/constants.js';
import { iterateDeviceIntervals, prepareExport } from '../src/export/dataset.js';
import { DEFAULT_EXPORT_LIMITS, type ExportSelection } from '../src/export/types.js';
import { fakeEngine, stateOf } from './engineHelpers.js';
import { makeTempDir } from './helpers.js';

const oneMinute = '2025-12-31T18:31:00Z';
const twoMinutes = '2025-12-31T18:32:00Z';

function selection(toUtc: string): ExportSelection {
  return {
    runId: '',
    format: 'json',
    fromUtc: INITIAL_SIM_TIME_UTC,
    toUtc,
    intervalSeconds: 60,
  };
}

describe('K003 consistent read snapshot', () => {
  it('keeps a WAL export snapshot stable while the engine commits another minute', () => {
    const temp = makeTempDir();
    const path = join(temp.dir, 'simulation.sqlite');
    const writer = openDatabase(path);
    let reader: ReturnType<typeof openReadOnlyDatabase> | null = null;
    try {
      runMigrations(writer);
      seedDemoInventory(writer);
      const { engine } = fakeEngine(writer);
      engine.start(1, 2026);
      engine.advanceSteps(6);
      const runId = stateOf(engine).run_id!;

      reader = openReadOnlyDatabase(path);
      reader.exec('BEGIN');
      const stable = prepareExport(reader, { ...selection(oneMinute), runId }, DEFAULT_EXPORT_LIMITS);
      assert.equal(stable.sourceDeviceRows, 18);

      // WAL permits the independent writer to commit after the reader snapshot
      // has been established. The already-started export must remain unchanged.
      engine.advanceSteps(6);
      assert.equal((writer.prepare('SELECT COUNT(*) AS n FROM device_intervals WHERE run_id = ?').get(runId) as { n: number }).n, 36);
      assert.equal(stable.sourceDeviceRows, 18);
      const streamed = Array.from(iterateDeviceIntervals(reader, stable));
      assert.equal(streamed.length, 18);
      assert.ok(streamed.every((row) => row.interval_end_utc === oneMinute));
      reader.exec('ROLLBACK');
      reader.close();
      reader = null;

      const nextReader = openReadOnlyDatabase(path);
      try {
        nextReader.exec('BEGIN');
        const next = prepareExport(nextReader, { ...selection(twoMinutes), runId }, DEFAULT_EXPORT_LIMITS);
        assert.equal(next.sourceDeviceRows, 36);
        nextReader.exec('ROLLBACK');
      } finally {
        nextReader.close();
      }
    } finally {
      if (reader?.isOpen) reader.close();
      closeDatabase(writer);
      temp.cleanup();
    }
  });
});
