import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assertDeviceInterval, assertRoomInterval } from '../src/contract/validators.js';
import { closeDatabase, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { INITIAL_SIM_TIME_UTC, SPEEDS } from '../src/engine/constants.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { kolkataLocal, scheduleWindowFor } from '../src/engine/schedule.js';
import {
  TEST_LOAD, addTestLoad, deviceIntervals, deviceOf, drain, fakeEngine, stateOf, toContractDeviceInterval,
} from './engineHelpers.js';
import { count, makeTempDir, memoryDb } from './helpers.js';

const TOL = 1e-12;
const epoch = (utc: string): number => Date.parse(utc) / 1000;
const elapsed = (engine: SimulationEngine): number => epoch(stateOf(engine).sim_time_utc!) - epoch(INITIAL_SIM_TIME_UTC);

function freshDb() {
  const db = memoryDb();
  addTestLoad(db);
  return db;
}

describe('energy', () => {
  it('a controlled 1 kW load over one simulated hour consumes exactly 1 kWh, independent of the fridge', () => {
    const db = freshDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.advanceSteps(360);
      assert.equal(elapsed(engine), 3600);
      const runId = stateOf(engine).run_id!;

      assert.ok(Math.abs(deviceOf(engine, TEST_LOAD).energy_kwh - 1) < TOL);
      const rows = deviceIntervals(db, runId, TEST_LOAD);
      assert.equal(rows.length, 60);
      assert.ok(Math.abs(rows.reduce((s, r) => s + r.energy_kwh, 0) - 1) < 60 * 1e-9);
      assert.ok(Math.abs(rows.at(-1)!.cumulative_kwh - 1) < TOL);
      assert.ok(rows.every((r) => r.avg_power_w === 1000 && r.max_power_w === 1000 && r.on_fraction === 1));

      // Unrelated constant fridge (150 W) is accounted separately: 0.15 kWh.
      assert.ok(Math.abs(deviceOf(engine, 'dev-pantry-fridge').energy_kwh - 0.15) < TOL);
      // Office = sum of devices = sum of rooms.
      const s = stateOf(engine);
      const deviceSum = s.devices.reduce((a, d) => a + d.energy_kwh, 0);
      assert.ok(Math.abs(s.office!.energy_kwh - deviceSum) < TOL);
      assert.ok(Math.abs(s.rooms.reduce((a, r) => a + r.energy_kwh, 0) - deviceSum) < TOL);
      // Standby: projector 5 + microwave 3 + 2 computers x 5 = 18 W, off all hour.
      assert.ok(Math.abs(deviceSum - (1 + 0.15 + 0.018)) < 1e-9);
    } finally {
      closeDatabase(db);
    }
  });

  it('equal processed simulated durations give equal energy at every speed', () => {
    const results = SPEEDS.map((speed) => {
      const db = freshDb();
      try {
        const { engine, advanceMs } = fakeEngine(db);
        engine.start(speed);
        engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
        advanceMs((3600 / speed) * 1000); // real time for one simulated hour at this speed
        const steps = drain(engine);
        return { speed, steps, elapsed: elapsed(engine), load: deviceOf(engine, TEST_LOAD).energy_kwh, office: stateOf(engine).office!.energy_kwh };
      } finally {
        closeDatabase(db);
      }
    });
    for (const r of results) {
      assert.equal(r.steps, 360, `speed ${r.speed}`);
      assert.equal(r.elapsed, 3600, `speed ${r.speed}`);
      assert.ok(Math.abs(r.load - 1) < TOL, `speed ${r.speed}`);
      assert.equal(r.office, results[0]!.office, `speed ${r.speed}`);
    }
  });

  it('a toggle changes subsequent power only, never already accumulated intervals', () => {
    const db = freshDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const light = 'dev-meeting-light';
      engine.advanceSteps(6); // minute 1: off
      const runId = stateOf(engine).run_id!;
      const before = deviceIntervals(db, runId, light);
      engine.commandDevice(light, { kind: 'set', on: true });
      engine.advanceSteps(6); // minute 2: on (72 W)
      engine.advanceSteps(3); // minute 3: half on …
      engine.commandDevice(light, { kind: 'set', on: false });
      engine.advanceSteps(3); // … half off
      const rows = deviceIntervals(db, runId, light);
      assert.deepEqual(rows[0], before[0]); // prior interval untouched
      [0, 72 * 60 / 3_600_000, 72 * 30 / 3_600_000].forEach((kwh, i) => assert.ok(Math.abs(rows[i]!.energy_kwh - kwh) < TOL));
      assert.deepEqual(rows.map((r) => [r.avg_power_w, r.max_power_w, r.on_fraction, r.override_seconds]),
        [[0, 0, 0, 0], [72, 72, 1, 60], [36, 72, 0.5, 60]]);
      // 00:01 IST Thursday is outside 09:00–18:00 and every room is vacant.
      assert.deepEqual(rows.map((r) => [r.vacant_on_seconds, r.offschedule_on_seconds]), [[0, 0], [60, 60], [30, 30]]);
    } finally {
      closeDatabase(db);
    }
  });

  it('minute records reconcile with cumulative counters, and room/office totals', () => {
    const db = freshDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.commandDevice('dev-open-light-a', { kind: 'set', on: true });
      engine.advanceSteps(30);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: false });
      engine.advanceSteps(30); // 10 minutes total
      const runId = stateOf(engine).run_id!;
      const s = stateOf(engine);
      for (const d of s.devices) {
        const rows = deviceIntervals(db, runId, d.device_id);
        assert.equal(rows.length, 10);
        let prev = 0;
        for (const r of rows) {
          assert.ok(Math.abs(r.cumulative_kwh - prev - r.energy_kwh) < 1e-9, d.device_id);
          prev = r.cumulative_kwh;
        }
        assert.ok(Math.abs(rows.reduce((a, r) => a + r.energy_kwh, 0) - d.energy_kwh) < 10 * 1e-9, d.device_id);
      }
      const dbTotal = (db.prepare('SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ?').get(runId) as { e: number }).e;
      assert.ok(Math.abs(dbTotal - s.office!.energy_kwh) < 190 * 1e-9);
      const byRoom = db.prepare('SELECT room_id, sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ? GROUP BY room_id').all(runId) as { room_id: string; e: number }[];
      for (const r of byRoom) assert.ok(Math.abs(r.e - s.rooms.find((x) => x.room_id === r.room_id)!.energy_kwh) < 1e-9);

      // Every emitted interval matches the contract interval shapes.
      deviceIntervals(db, runId).forEach((r) => assertDeviceInterval(toContractDeviceInterval(r)));
      const rooms = db.prepare('SELECT * FROM room_intervals WHERE run_id = ?').all(runId) as Record<string, unknown>[];
      assert.equal(rooms.length, 50);
      rooms.forEach((r) => assertRoomInterval({ ...r, partial: r.partial === 1 }));
      assert.ok(rooms.every((r) => r.occupancy_avg === 0 && r.occupied_fraction === 0 && r.avg_temp_c === 26 && r.avg_rh_pct === 55));
    } finally {
      closeDatabase(db);
    }
  });
});

describe('lifecycle', () => {
  it('pausing adds no simulated time or energy, and keeps the partial minute', () => {
    const db = freshDb();
    try {
      const { engine, advanceMs } = fakeEngine(db);
      engine.start(60);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      advanceMs(500); // 30 simulated seconds at 60x
      drain(engine);
      engine.pause();
      const paused = stateOf(engine);
      assert.equal(paused.status, 'paused');
      assert.equal(paused.partial_interval!.covered_seconds, 30);
      advanceMs(3_600_000);
      assert.equal(engine.scheduler.tick(), 0);
      assert.deepEqual({ ...stateOf(engine), seq: 0 }, { ...paused, seq: 0 });

      // Resume completes the SAME minute: one full 60 s interval, no partial row.
      engine.resume();
      advanceMs(500);
      drain(engine);
      const rows = deviceIntervals(db, paused.run_id!, TEST_LOAD);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0]!.interval_seconds, rows[0]!.partial], [60, 0]);
      assert.ok(Math.abs(rows[0]!.energy_kwh - 1000 * 60 / 3_600_000) < TOL);
    } finally {
      closeDatabase(db);
    }
  });

  it('repeated start/resume never creates a second timer or extra advancement', () => {
    const db = freshDb();
    try {
      const { engine, advanceMs } = fakeEngine(db);
      engine.start(10);
      const seq = stateOf(engine).seq;
      engine.start(10);
      engine.start();
      engine.resume();
      engine.resume(10);
      assert.equal(stateOf(engine).seq, seq); // no-ops
      advanceMs(6000); // 60 simulated seconds at 10x
      assert.equal(drain(engine), 6);
      assert.equal(elapsed(engine), 60);
    } finally {
      closeDatabase(db);
    }
  });

  it('defines invalid transitions', () => {
    const db = freshDb();
    try {
      const { engine } = fakeEngine(db);
      assert.equal(engine.lifecycle, 'not_initialized');
      assert.throws(() => engine.pause(), { status: 409, code: 'CONFLICT' });
      assert.throws(() => engine.resume(), { status: 409, code: 'CONFLICT' });
      assert.throws(() => engine.commandDevice('dev-meeting-light', { kind: 'set', on: true }), { status: 409 });
      assert.throws(() => engine.setSpeed(5), { status: 400, code: 'VALIDATION_ERROR' });
      assert.throws(() => engine.start(3), { status: 400 });
      assert.equal(engine.lifecycle, 'not_initialized');
      engine.start();
      assert.throws(() => engine.commandDevice('dev-nope', { kind: 'set', on: true }), { status: 404, code: 'NOT_FOUND' });
      assert.throws(() => engine.commandDevice('dev-open-ac', { kind: 'set', on: true }), { status: 400, code: 'VALIDATION_ERROR' });
      assert.throws(() => engine.commandDevice('dev-pantry-fridge', { kind: 'clear' }), { status: 400 });
    } finally {
      closeDatabase(db);
    }
  });

  it('reset creates a new run and preserves the previous run and its partial data', () => {
    const db = freshDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.advanceSteps(9); // 1.5 minutes
      const oldRun = stateOf(engine).run_id!;
      engine.reset();
      const s = stateOf(engine);
      assert.notEqual(s.run_id, oldRun);
      assert.deepEqual([s.status, s.seq, s.sim_time_utc], ['paused', 0, INITIAL_SIM_TIME_UTC]);
      assert.equal(deviceOf(engine, TEST_LOAD).energy_kwh, 0);
      assert.equal(deviceOf(engine, TEST_LOAD).override, null); // new run starts from base states

      const old = deviceIntervals(db, oldRun, TEST_LOAD);
      assert.deepEqual(old.map((r) => [r.interval_start_utc, r.interval_end_utc, r.interval_seconds, r.partial]),
        [['2025-12-31T18:30:00Z', '2025-12-31T18:31:00Z', 60, 0], ['2025-12-31T18:31:00Z', '2025-12-31T18:31:30Z', 30, 1]]);
      assert.ok(Math.abs(old[1]!.energy_kwh - 1000 * 30 / 3_600_000) < TOL);
      assert.ok(Math.abs(old[1]!.cumulative_kwh - 1000 * 90 / 3_600_000) < TOL);
      assert.equal(old[1]!.avg_power_w, 1000); // averaged over the actual 30 s, not a full minute
      assertDeviceInterval(toContractDeviceInterval(old[1]!));
      const lifecycles = db.prepare('SELECT run_id, lifecycle FROM engine_checkpoints ORDER BY lifecycle').all() as { run_id: string; lifecycle: string }[];
      assert.deepEqual(lifecycles.map((l) => ({ ...l })), [{ run_id: s.run_id, lifecycle: 'active' }, { run_id: oldRun, lifecycle: 'ended' }]);
      assert.throws(() => db.prepare("UPDATE engine_checkpoints SET lifecycle = 'active' WHERE run_id = ?").run(oldRun), /ended run/);
      assert.equal(count(db, 'simulation_runs'), 2);
      assert.equal(engine.health().run_id, s.run_id);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('restart recovery', () => {
  function withFile(fn: (path: string) => void): void {
    const tmp = makeTempDir();
    try {
      fn(join(tmp.dir, 'sim.sqlite'));
    } finally {
      tmp.cleanup();
    }
  }
  const open = (path: string) => {
    const db = openDatabase(path);
    runMigrations(db);
    return db;
  };

  it('graceful shutdown → restart recovers PAUSED at the processed time without double counting', () => {
    withFile((path) => {
      let db = open(path);
      seedDemoInventory(db);
      addTestLoad(db);
      let engine = fakeEngine(db).engine;
      engine.start(1000);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.advanceSteps(15); // 2.5 minutes
      const before = stateOf(engine);
      engine.shutdown();
      closeDatabase(db);

      db = open(path);
      try {
        engine = fakeEngine(db).engine;
        assert.equal(engine.lifecycle, 'not_initialized');
        const rec = engine.recover();
        const after = stateOf(engine);
        assert.equal(rec?.run_id, before.run_id);
        assert.deepEqual([after.status, after.sim_time_utc, after.seq, after.speed], ['paused', before.sim_time_utc, before.seq, 1000]);
        assert.equal(after.partial_interval!.covered_seconds, 30);
        assert.deepEqual(deviceOf(engine, TEST_LOAD).override, { active: true, on: true });
        assert.equal(deviceOf(engine, TEST_LOAD).energy_kwh, before.devices.find((d) => d.device_id === TEST_LOAD)!.energy_kwh);
        assert.equal(deviceIntervals(db, before.run_id!, TEST_LOAD).length, 2);

        engine.resume();
        engine.advanceSteps(3); // completes minute 3 from the restored partial accumulator
        const rows = deviceIntervals(db, before.run_id!, TEST_LOAD);
        assert.equal(rows.length, 3);
        assert.deepEqual([rows[2]!.interval_seconds, rows[2]!.partial], [60, 0]);
        assert.ok(Math.abs(rows[2]!.energy_kwh - 1000 * 60 / 3_600_000) < TOL);
        assert.ok(Math.abs(rows[2]!.cumulative_kwh - 1000 * 180 / 3_600_000) < TOL);
      } finally {
        closeDatabase(db);
      }
    });
  });

  it('abrupt stop loses only steps after the last checkpoint and never duplicates intervals', () => {
    withFile((path) => {
      let db = open(path);
      seedDemoInventory(db);
      addTestLoad(db);
      const engine = fakeEngine(db).engine;
      engine.start();
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true }); // checkpoint at t=0
      engine.advanceSteps(15); // minute checkpoints at 1:00 and 2:00; 30 s uncheckpointed
      const runId = stateOf(engine).run_id!;
      closeDatabase(db); // no shutdown(): simulates a crash

      db = open(path);
      try {
        const recovered = fakeEngine(db).engine;
        recovered.recover();
        const s = stateOf(recovered);
        assert.equal(s.status, 'paused');
        assert.equal(s.sim_time_utc, '2025-12-31T18:32:00Z'); // last minute checkpoint
        const rows = deviceIntervals(db, runId, TEST_LOAD);
        assert.equal(rows.length, 2);
        assert.equal(deviceOf(recovered, TEST_LOAD).energy_kwh, rows[1]!.cumulative_kwh);
        recovered.advanceSteps(6);
        assert.equal(deviceIntervals(db, runId, TEST_LOAD).length, 3); // continues, no duplicate key
      } finally {
        closeDatabase(db);
      }
    });
  });
});

describe('schedule measurement helper', () => {
  it('evaluates office hours in Asia/Kolkata', () => {
    const hours = { working_days_iso: [1, 2, 3, 4, 5], open_local: '09:00', close_local: '18:00', overnight: false };
    const w = scheduleWindowFor('device_schedule', { office_hours_ref: 'pol-office-hours:1', on_windows: [] }, () => hours);
    assert.deepEqual(kolkataLocal(epoch('2026-01-01T03:30:00Z')), { isoDay: 4, minute: 540 }); // Thu 09:00 IST
    assert.equal(w(epoch('2026-01-01T03:30:00Z')), true);
    assert.equal(w(epoch('2026-01-01T03:29:50Z')), false);
    assert.equal(w(epoch('2026-01-01T12:30:00Z')), false); // 18:00 exclusive
    assert.equal(w(epoch('2026-01-03T05:00:00Z')), false); // Saturday
    const night = scheduleWindowFor('device_schedule', { office_hours_ref: 'x:1', on_windows: [] },
      () => ({ working_days_iso: [5], open_local: '22:00', close_local: '06:00', overnight: true }));
    assert.equal(night(epoch('2026-01-02T17:00:00Z')), true); // Fri 22:30 IST
    assert.equal(night(epoch('2026-01-02T23:00:00Z')), true); // Sat 04:30 IST
    assert.equal(night(epoch('2026-01-03T17:00:00Z')), false); // Sat 22:30 IST
    assert.equal(scheduleWindowFor('always_on', {}, () => null)(0), true);
  });
});
