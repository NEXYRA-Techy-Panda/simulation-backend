import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertDataset } from '../src/contract/validators.js';
import { addPolicyVersion } from '../src/db/inventory.js';
import { createRun } from '../src/db/runs.js';
import { closeDatabase, memoryDb } from './helpers.js';
import { MEMORY, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations/index.js';
import { INITIAL_SIM_TIME_UTC } from '../src/engine/constants.js';
import { fakeEngine, stateOf } from './engineHelpers.js';
import {
  listRuns,
  prepareExport,
} from '../src/export/dataset.js';
import { iterateCsvChunks, iterateJsonChunks } from '../src/export/serialize.js';
import { DEFAULT_EXPORT_LIMITS, EXPORT_INTERVALS, type ExportSelection } from '../src/export/types.js';
import { ApiError } from '../src/http/errors.js';
import type { Database } from '../src/db/connection.js';

const START = '2026-09-21T03:30:00Z';
const END = '2026-09-21T03:32:00Z';
const LEGACY_END = '2026-09-21T03:31:00Z';
const CREATED = '2026-09-21T03:29:00Z';

interface Fixture {
  db: Database;
  runId: string;
}

function addFixtureRun(db: Database, runId = 'run-export', includeEmptyRoom = false): Fixture {
  db.prepare(`INSERT INTO buildings (building_id, name, timezone, created_utc)
      VALUES ('b-office', ?, 'Asia/Kolkata', ?)`).run('Ops "Central", Zürich', CREATED);
  db.prepare(`INSERT INTO rooms (room_id, building_id, name, room_type, capacity, created_utc, updated_utc)
      VALUES ('room-a', 'b-office', ?, 'office', 4, ?, ?)`).run('Ops "Central", Zürich', CREATED, CREATED);
  if (includeEmptyRoom) {
    db.prepare(`INSERT INTO rooms (room_id, building_id, name, room_type, capacity, created_utc, updated_utc)
        VALUES ('room-empty', 'b-office', 'Empty room', 'office', 1, ?, ?)`).run(CREATED, CREATED);
  }
  const devices = [
    ['dev-light', 'room-a', 'Lighting', 'lighting', 600, 0.9, 0, 'scheduled', '["switch"]', 'pol-light', 'lighting_schedule'],
    ['dev-fridge', 'room-a', 'Refrigerator', 'refrigerator', 300, 1, 1, 'always_on', '[]', 'pol-fridge', 'always_on'],
  ] as const;
  for (const [id, roomId, name, type, watts, pf, alwaysOn, control, controls, policyId, kind] of devices) {
    db.prepare(`INSERT INTO devices (device_id, room_id, name, device_type, quantity, nominal_power_w,
        power_factor, always_on, control, controls, created_utc, updated_utc)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roomId, name, type, watts, pf, alwaysOn, control, controls, CREATED, CREATED);
    db.prepare(`INSERT INTO policies (policy_id, kind, device_id, created_utc) VALUES (?, ?, ?, ?)`)
      .run(policyId, kind, id, CREATED);
  }
  db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
      VALUES ('pol-light', 1, '2000-01-01T00:00:00Z', ?, ?)`)
    .run(JSON.stringify({ on_during_hours: true, vacancy_grace_seconds: 0 }), CREATED);
  db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
      VALUES ('pol-fridge', 1, '2000-01-01T00:00:00Z', ?, ?)`)
    .run(JSON.stringify({ always_on_exception: true }), CREATED);

  createRun(db, {
    run_id: runId,
    building_id: 'b-office',
    scenario_id: 'original',
    comparison_id: null,
    run_start_utc: START,
    config: { synthetic: true },
  }, new Date(CREATED));

  for (let minute = 0; minute < 2; minute += 1) {
    const start = new Date(Date.parse(START) + minute * 60_000).toISOString().replace('.000Z', 'Z');
    const end = new Date(Date.parse(START) + (minute + 1) * 60_000).toISOString().replace('.000Z', 'Z');
    db.prepare(`INSERT INTO room_intervals (run_id, room_id, interval_start_utc, interval_end_utc,
        interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
        VALUES (?, 'room-a', ?, ?, 60, 2, 2, 1, 24.5, 45, 0)`).run(runId, start, end);
    for (const [id, watts, pf, policyRef, cumulative] of [
      ['dev-light', 600, 0.9, 'pol-light:1', 0.01 * (minute + 1)],
      ['dev-fridge', 300, 1, 'pol-fridge:1', 0.005 * (minute + 1)],
    ] as const) {
      db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc, interval_end_utc,
          interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
          power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds,
          policy_id, policy_version, partial)
          VALUES (?, ?, 'room-a', ?, ?, 60, ?, ?, ?, ?, NULL, NULL, ?, 1, 0, 0, 0,
            ?, ?, 0)`)
        .run(runId, id, start, end, watts, watts, watts * 60 / 3_600_000, cumulative, pf,
          policyRef.slice(0, policyRef.indexOf(':')), Number(policyRef.split(':')[1]));
    }
  }
  return { db, runId };
}

function collect(chunks: Iterable<string>): string {
  return Array.from(chunks).join('');
}

function selection(format: 'json' | 'csv', intervalSeconds: 60 | 300 | 600 | 900 | 1800 | 3600 = 60, from = START, to = END): ExportSelection {
  return { runId: 'run-export', format, fromUtc: from, toUtc: to, intervalSeconds };
}

function datasetFromJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('K003 production export builder', () => {
  it('produces a schema-valid 0.03 kWh known total at every supported resolution', () => {
    const db = memoryDb({ seed: false });
    try {
      addFixtureRun(db);
      for (const intervalSeconds of EXPORT_INTERVALS) {
        const prepared = prepareExport(db, selection('json', intervalSeconds), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
        const dataset = datasetFromJson(collect(iterateJsonChunks(db, prepared)));
        assertDataset(dataset);
        assert.equal(dataset.synthetic, true);
        assert.equal(dataset.source, 'simulation');
        const devices = dataset.device_intervals as Record<string, unknown>[];
        const total = devices.reduce((sum, row) => sum + Number(row.energy_kwh), 0);
        assert.ok(Math.abs(total - 0.03) < 1e-12, `${intervalSeconds}: ${total}`);
        if (intervalSeconds > 60) assert.ok(devices.every((row) => row.partial === true));
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('applies contract aggregation fields and keeps high-precision JSON/CSV semantics identical', () => {
    const db = memoryDb({ seed: false });
    try {
      const { runId } = addFixtureRun(db);
      db.prepare(`UPDATE device_intervals SET power_factor = 0.123456789012345,
          avg_voltage_v = 230, avg_current_a = 1.3
          WHERE run_id = ? AND device_id = 'dev-light'`).run(runId);
      db.prepare(`UPDATE device_intervals SET avg_power_w = 300, max_power_w = 900,
          energy_kwh = 0.005, cumulative_kwh = 0.015, avg_voltage_v = 230,
          avg_current_a = 1.3, on_fraction = 0.5, override_seconds = 30,
          vacant_on_seconds = 20, offschedule_on_seconds = 10
          WHERE run_id = ? AND device_id = 'dev-light' AND interval_start_utc = '2026-09-21T03:31:00Z'`)
        .run(runId);

      const jsonPrepared = prepareExport(db, selection('json', 300), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const csvPrepared = prepareExport(db, selection('csv', 300), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const json = datasetFromJson(collect(iterateJsonChunks(db, jsonPrepared)));
      assertDataset(json);
      const light = (json.device_intervals as Record<string, unknown>[]).find((row) => row.device_id === 'dev-light')!;
      assert.deepEqual(
        [light.avg_power_w, light.max_power_w, light.energy_kwh, light.cumulative_kwh, light.on_fraction,
          light.override_seconds, light.vacant_on_seconds, light.offschedule_on_seconds,
          light.avg_voltage_v, light.avg_current_a, light.power_factor, light.partial],
        [450, 900, 0.015, 0.015, 0.75, 30, 20, 10, 230, 1.3, 0.123456789012, true],
      );

      const csv = collect(iterateCsvChunks(db, csvPrepared));
      const line = csv.trimEnd().split('\n').find((value) => value.startsWith(`${runId},`)
        && value.includes(',dev-light,') && !value.includes('""schema_version""'))!;
      assert.equal(Number(line.split(',')[19]), light.power_factor);
      assert.equal(jsonPrepared.metadata.export.export_id, csvPrepared.metadata.export.export_id);
    } finally {
      closeDatabase(db);
    }
  });

  it('preserves exact 60-second arithmetic and marks a historical first row partial', () => {
    const db = memoryDb({ seed: false });
    try {
      addFixtureRun(db);
      const first = '2026-09-21T03:31:00Z';
      const prepared = prepareExport(db, selection('json', 60, first, END), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const dataset = datasetFromJson(collect(iterateJsonChunks(db, prepared)));
      assertDataset(dataset);
      const rows = dataset.device_intervals as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.partial === true));
      const light = rows.find((row) => row.device_id === 'dev-light')!;
      assert.equal(light.cumulative_kwh, 0.02);
      assert.equal(light.energy_kwh, 0.01);
    } finally {
      closeDatabase(db);
    }
  });

  it('preserves a committed short final edge and does not publish the active checkpoint accumulator', () => {
    const db = memoryDb({ seed: false });
    try {
      const { runId } = addFixtureRun(db);
      const start = END;
      const end = '2026-09-21T03:32:30Z';
      db.prepare(`INSERT INTO room_intervals (run_id, room_id, interval_start_utc, interval_end_utc,
          interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
          VALUES (?, 'room-a', ?, ?, 30, 2, 2, 1, 24.5, 45, 1)`).run(runId, start, end);
      for (const [id, watts, pf, policyRef, cumulative, energy] of [
        ['dev-light', 600, 0.9, 'pol-light:1', 0.025, 0.005],
        ['dev-fridge', 300, 1, 'pol-fridge:1', 0.0125, 0.0025],
      ] as const) {
        db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc, interval_end_utc,
            interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
            power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds,
            policy_id, policy_version, partial)
            VALUES (?, ?, 'room-a', ?, ?, 30, ?, ?, ?, ?, NULL, NULL, ?, 1, 0, 0, 0, ?, ?, 1)`)
          .run(runId, id, start, end, watts, watts, energy, cumulative, pf,
            policyRef.slice(0, policyRef.indexOf(':')), Number(policyRef.split(':')[1]));
      }
      const prepared = prepareExport(db, { ...selection('json'), toUtc: end }, DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const dataset = datasetFromJson(collect(iterateJsonChunks(db, prepared)));
      assertDataset(dataset);
      const rows = dataset.device_intervals as Record<string, unknown>[];
      assert.equal(rows.length, 6);
      assert.deepEqual(rows.filter((row) => row.partial === true).map((row) => row.interval_start_utc), [start, start]);
      assert.ok(Math.abs(rows.reduce((sum, row) => sum + Number(row.energy_kwh), 0) - 0.0375) < 1e-12);
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps JSON/CSV semantics and export identity while changing identity for selection changes', () => {
    const db = memoryDb({ seed: false });
    try {
      addFixtureRun(db);
      const jsonPrepared = prepareExport(db, selection('json'), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const csvPrepared = prepareExport(db, selection('csv'), DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const jsonText = collect(iterateJsonChunks(db, jsonPrepared));
      const csvText = collect(iterateCsvChunks(db, csvPrepared));
      const json = datasetFromJson(jsonText);
      assertDataset(json);
      assert.equal(jsonPrepared.metadata.export.export_id, csvPrepared.metadata.export.export_id);
      assert.notEqual(
        prepareExport(db, selection('json', 300), DEFAULT_EXPORT_LIMITS, new Date(CREATED)).metadata.export.export_id,
        jsonPrepared.metadata.export.export_id,
      );
      assert.notEqual(
        prepareExport(db, selection('json', 60, START, '2026-09-21T03:31:00Z'), DEFAULT_EXPORT_LIMITS, new Date(CREATED)).metadata.export.export_id,
        jsonPrepared.metadata.export.export_id,
      );
      const lines = csvText.trimEnd().split('\n');
      assert.equal(lines[0], 'run_id,building_id,scenario_id,interval_start_utc,interval_end_utc,interval_seconds,room_id,room_occupancy_avg,room_occupancy_max,room_occupied_fraction,room_temp_c,room_rh_pct,device_id,avg_power_w,max_power_w,energy_kwh,cumulative_kwh,avg_voltage_v,avg_current_a,power_factor,on_fraction,override_seconds,vacant_on_seconds,offschedule_on_seconds,policy_ref,partial,meta_run');
      assert.equal(lines.length, 5);
      assert.ok(csvText.includes('Central'));
      assert.ok(csvText.includes('Zürich'));
      const metaCells = lines.slice(1).filter((line) => line.includes('""schema_version""'));
      assert.equal(metaCells.length, 1);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects a device-less room rather than silently dropping it from standalone CSV', () => {
    const db = memoryDb({ seed: false });
    try {
      addFixtureRun(db, 'run-empty-room', true);
      assert.throws(
        () => prepareExport(db, { ...selection('json'), runId: 'run-empty-room' }, DEFAULT_EXPORT_LIMITS),
        (error: unknown) => error instanceof ApiError && error.status === 409 && /standalone CSV/.test(error.message),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects gaps and mixed policy transitions in coarse buckets', () => {
    const gapDb = memoryDb({ seed: false });
    try {
      const { runId } = addFixtureRun(gapDb);
      gapDb.prepare(`DELETE FROM room_intervals WHERE run_id = ? AND interval_start_utc = '2026-09-21T03:31:00Z'`).run(runId);
      assert.throws(
        () => prepareExport(gapDb, selection('json'), DEFAULT_EXPORT_LIMITS),
        (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 422),
      );
    } finally {
      closeDatabase(gapDb);
    }

    const policyDb = memoryDb({ seed: false });
    try {
      const { runId } = addFixtureRun(policyDb);
      addPolicyVersion(policyDb, {
        policy_id: 'pol-light',
        effective_from_utc: '2026-09-21T03:31:00Z',
        rules: { on_during_hours: false, vacancy_grace_seconds: 0 },
      });
      policyDb.prepare(`INSERT INTO run_policies (run_id, policy_id, version, active_from_utc)
          VALUES (?, 'pol-light', 2, '2026-09-21T03:31:00Z')`).run(runId);
      policyDb.prepare(`UPDATE device_intervals SET policy_id = 'pol-light', policy_version = 2
          WHERE run_id = ? AND device_id = 'dev-light' AND interval_start_utc = '2026-09-21T03:31:00Z'`).run(runId);
      assert.throws(
        () => prepareExport(policyDb, selection('json', 300), DEFAULT_EXPORT_LIMITS),
        (error: unknown) => error instanceof ApiError && error.status === 409 && /mixes policy/.test(error.message),
      );
      const fine = prepareExport(policyDb, selection('json', 60), DEFAULT_EXPORT_LIMITS);
      assert.equal(fine.outputDeviceRows, 4);
    } finally {
      closeDatabase(policyDb);
    }
  });

  it('exports a post-calendar reset with run-scoped activation at the new run start', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start(1, 2026);
      engine.advanceSteps(6);
      const change = engine.setCalendar({
        working_days: [1, 2, 3, 4, 5],
        open_local: '08:30',
        close_local: '17:30',
      });
      engine.advanceSteps(6);
      const globalActivation = String(change.effective_sim_utc);
      engine.reset();
      const runId = stateOf(engine).run_id!;
      engine.advanceSteps(6);
      const end = '2025-12-31T18:31:00Z';
      const prepared = prepareExport(db, {
        runId,
        format: 'json',
        fromUtc: INITIAL_SIM_TIME_UTC,
        toUtc: end,
        intervalSeconds: 60,
      }, DEFAULT_EXPORT_LIMITS, new Date(CREATED));
      const dataset = datasetFromJson(collect(iterateJsonChunks(db, prepared)));
      assertDataset(dataset);
      const office = (dataset.policies as Record<string, unknown>[]).find((policy) => policy.kind === 'office_hours')!;
      assert.equal(office.effective_from_utc, INITIAL_SIM_TIME_UTC);
      assert.notEqual(office.effective_from_utc, globalActivation);
      const ac = (dataset.device_intervals as Record<string, unknown>[]).find((row) => row.device_id === 'dev-open-ac')!;
      assert.match(String(ac.policy_ref), /:2$/);
      assert.equal(ac.interval_start_utc, INITIAL_SIM_TIME_UTC);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects a legacy-unrecorded run whose global policy time is historically invalid without repairing it', () => {
    const db = openDatabase(MEMORY);
    try {
      runMigrations(db, migrations.slice(0, 2));
      db.prepare(`INSERT INTO buildings (building_id, name, timezone, created_utc)
          VALUES ('b', 'Legacy', 'Asia/Kolkata', ?)`).run(CREATED);
      db.prepare(`INSERT INTO rooms (room_id, building_id, name, room_type, capacity, created_utc, updated_utc)
          VALUES ('r', 'b', 'Legacy room', 'office', 2, ?, ?)`).run(CREATED, CREATED);
      db.prepare(`INSERT INTO devices (device_id, room_id, name, device_type, quantity, nominal_power_w,
          power_factor, always_on, control, controls, created_utc, updated_utc)
          VALUES ('d', 'r', 'Legacy light', 'lighting', 1, 600, 0.9, 0, 'scheduled', '[]', ?, ?)`)
        .run(CREATED, CREATED);
      db.prepare(`INSERT INTO policies (policy_id, kind, device_id, created_utc)
          VALUES ('p', 'lighting_schedule', 'd', ?)`).run(CREATED);
      db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
          VALUES ('p', 1, '2026-09-21T03:31:00Z', ?, ?)`)
        .run(JSON.stringify({ on_during_hours: true, vacancy_grace_seconds: 0 }), CREATED);
      db.prepare(`INSERT INTO simulation_runs (run_id, building_id, building_name, timezone, scenario_id,
          comparison_id, run_start_utc, config, created_utc)
          VALUES ('run-legacy', 'b', 'Legacy', 'Asia/Kolkata', 'original', NULL, ?, '{}', ?)`)
        .run(START, CREATED);
      // Copy the one current snapshot explicitly (schema v2 has no K002 helper).
      db.prepare(`INSERT INTO run_rooms (run_id, room_id, name, room_type, capacity, floor_area_m2)
          VALUES ('run-legacy', 'r', 'Legacy room', 'office', 2, NULL)`).run();
      db.prepare(`INSERT INTO run_devices (run_id, device_id, room_id, name, device_type, quantity,
          nominal_power_w, power_factor, always_on, control, controls)
          VALUES ('run-legacy', 'd', 'r', 'Legacy light', 'lighting', 1, 600, 0.9, 0, 'scheduled', '[]')`).run();
      db.prepare(`INSERT INTO run_policies (run_id, policy_id, version) VALUES ('run-legacy', 'p', 1)`).run();
      db.prepare(`INSERT INTO room_intervals (run_id, room_id, interval_start_utc, interval_end_utc,
          interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
          VALUES ('run-legacy', 'r', ?, ?, 60, 0, 0, 0, 24, 40, 0)`).run(START, LEGACY_END);
      db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc, interval_end_utc,
          interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
          power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds,
          policy_id, policy_version, partial)
          VALUES ('run-legacy', 'd', 'r', ?, ?, 60, 600, 600, 0.01, 0.01, NULL, NULL, 0.9, 1, 0, 0, 0, 'p', 1, 0)`)
        .run(START, LEGACY_END);
      runMigrations(db, migrations);

      assert.throws(
        () => prepareExport(db, { ...selection('json'), runId: 'run-legacy', toUtc: LEGACY_END }, DEFAULT_EXPORT_LIMITS),
        (error: unknown) => error instanceof ApiError && error.status === 409 && /Legacy run/.test(error.message),
      );
      const pin = db.prepare(`SELECT active_from_utc FROM run_policies
          WHERE run_id = 'run-legacy' AND policy_id = 'p'`).get() as { active_from_utc: string | null };
      assert.equal(pin.active_from_utc, null);
    } finally {
      closeDatabase(db);
    }
  });

  it('does not label a run with a missing middle device row as exportable', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start(1, 2026);
      engine.advanceSteps(18);
      const runId = stateOf(engine).run_id!;
      db.prepare(`DELETE FROM device_intervals WHERE run_id = ? AND device_id = 'dev-pantry-fridge'
          AND interval_start_utc = '2025-12-31T18:32:00Z'`).run(runId);
      const run = listRuns(db, 1, 50).runs.find((item) => item.run_id === runId)!;
      assert.equal(run.committed_interval_count, 53);
      assert.equal(run.exportable, false);
      assert.equal(run.unavailable_reason, 'HISTORY_COVERAGE_INCONSISTENT');
    } finally {
      closeDatabase(db);
    }
  });

  it('lists committed coverage separately from run creation and excludes empty history', () => {
    const db = memoryDb({ seed: false });
    try {
      addFixtureRun(db);
      const listed = listRuns(db, 1, 50);
      assert.equal(listed.runs[0]?.committed_start_utc, START);
      assert.equal(listed.runs[0]?.committed_end_utc, END);
      assert.equal(listed.runs[0]?.committed_interval_count, 4);
      assert.equal(listed.runs[0]?.exportable, true);
      assert.equal(listed.runs[0]?.activation_mode, 'run_scoped');
    } finally {
      closeDatabase(db);
    }
  });
});
