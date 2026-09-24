import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Database } from '../src/db/connection.js';
import { createRun } from '../src/db/runs.js';
import { AC_POWER_MODEL_ID, acPowerW, type AcDeviceRating } from '../src/environment/index.js';
import { INITIAL_SIM_TIME_UTC, RUN_CONFIG, STEP_SECONDS } from '../src/engine/constants.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { deviceIntervals, deviceOf, fakeEngine, stateOf } from './engineHelpers.js';
import { closeDatabase, memoryDb } from './helpers.js';

const AC = 'dev-open-ac';
const AC_ROOM = 'room-open-workspace';
const FLOOR_W = 1500 * 0.2; // 300 W demo part-load floor
const TOL = 1e-9;

interface RoomIntervalRow {
  room_id: string; interval_start_utc: string; interval_end_utc: string; interval_seconds: number;
  occupancy_avg: number; occupancy_max: number; occupied_fraction: number;
  avg_temp_c: number; avg_rh_pct: number; partial: number;
}

const roomIntervals = (db: Database, runId: string, roomId = AC_ROOM): RoomIntervalRow[] =>
  db.prepare(`SELECT room_id, interval_start_utc, interval_end_utc, interval_seconds, occupancy_avg, occupancy_max,
      occupied_fraction, avg_temp_c, avg_rh_pct, partial FROM room_intervals
      WHERE run_id = ? AND room_id = ? ORDER BY interval_start_utc`).all(runId, roomId) as unknown as RoomIntervalRow[];

/** The demo inventory AC as the module sees it, taken from the engine state. */
const acRating = (engine: SimulationEngine): AcDeviceRating => {
  const d = deviceOf(engine, AC);
  return { device_id: d.device_id, device_type: 'ac', quantity: 1, nominal_power_w: 1500 };
};

const acIsOn = (engine: SimulationEngine): void => {
  engine.commandDevice(AC, { kind: 'set', on: true });
};

describe('environment integration — engine', () => {
  it('records the model id in the immutable run configuration of new runs', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const row = db.prepare('SELECT config FROM simulation_runs WHERE run_id = ?')
        .get(stateOf(engine).run_id) as { config: string };
      const cfg = JSON.parse(row.config) as { devices?: { ac_power_model?: string; ac_power_model_assumptions?: unknown } };
      assert.equal(cfg.devices?.ac_power_model, AC_POWER_MODEL_ID);
      assert.deepEqual(cfg.devices?.ac_power_model_assumptions, RUN_CONFIG.devices.ac_power_model_assumptions);
      assert.equal(stateOf(engine).ac_power_model, AC_POWER_MODEL_ID);
      assert.deepEqual(stateOf(engine).rooms.find((r) => r.room_id === AC_ROOM)?.climate, { temp_c: 26, rh_pct: 55 });
    } finally {
      closeDatabase(db);
    }
  });

  it('accepts a valid environment command and rejects invalid ones without mutating state', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const before = stateOf(engine);

      const ok = engine.setEnvironment({ room_id: AC_ROOM, temp_c: 31, rh_pct: 40 });
      assert.deepEqual(
        { room_id: ok.room_id, temp_c: ok.temp_c, rh_pct: ok.rh_pct, applies_from: ok.applies_from },
        { room_id: AC_ROOM, temp_c: 31, rh_pct: 40, applies_from: 'next_step' },
      );
      const after = stateOf(engine);
      assert.deepEqual(after.rooms.find((r) => r.room_id === AC_ROOM)?.climate, { temp_c: 31, rh_pct: 40 });
      assert.equal(after.sim_time_utc, before.sim_time_utc); // no time advanced
      assert.equal(after.office?.energy_kwh, before.office?.energy_kwh);

      const rejected: [Record<string, unknown>, number, string, string][] = [
        [{ room_id: AC_ROOM, temp_c: 71, rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
        [{ room_id: AC_ROOM, temp_c: 30, rh_pct: -1 }, 400, 'VALIDATION_ERROR', 'rh_pct'],
        [{ room_id: AC_ROOM, temp_c: Number.NaN, rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
        [{ room_id: AC_ROOM, temp_c: '30', rh_pct: 40 }, 400, 'VALIDATION_ERROR', 'temp_c'],
        [{ room_id: AC_ROOM, temp_c: 30 }, 400, 'VALIDATION_ERROR', 'rh_pct'],
        [{ room_id: 'room-does-not-exist', temp_c: 30, rh_pct: 40 }, 404, 'NOT_FOUND', 'room_id'],
      ];
      for (const [body, status, code, field] of rejected) {
        let thrown: { status?: number; code?: string; field?: string } | null = null;
        try {
          engine.setEnvironment(body as { room_id: unknown; temp_c: unknown; rh_pct: unknown });
        } catch (err) {
          thrown = err as { status?: number; code?: string; field?: string };
        }
        assert.deepEqual([thrown?.status, thrown?.code, thrown?.field], [status, code, field], JSON.stringify(body));
        const unchanged = stateOf(engine);
        assert.deepEqual(unchanged.rooms, after.rooms, 'a rejected command must not change any room');
        assert.equal(unchanged.seq, after.seq, 'a rejected command must not change the sequence');
        assert.equal(unchanged.ac_power_model, after.ac_power_model);
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('changes only the addressed room and accepts a paused command without time or energy', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      engine.pause();
      const before = stateOf(engine);
      const others = before.rooms.filter((r) => r.room_id !== AC_ROOM).map((r) => ({ room_id: r.room_id, climate: r.climate }));

      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 19, rh_pct: 70 });
      const after = stateOf(engine);
      assert.equal(after.sim_time_utc, before.sim_time_utc);
      assert.equal(after.office?.energy_kwh, before.office?.energy_kwh);
      assert.equal(after.status, 'paused');
      assert.deepEqual(after.rooms.filter((r) => r.room_id !== AC_ROOM).map((r) => ({ room_id: r.room_id, climate: r.climate })), others);
      assert.equal(deviceOf(engine, AC).energy_kwh, 0);
    } finally {
      closeDatabase(db);
    }
  });

  it('duration-weights a mid-minute climate change instead of copying the final value', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const runId = stateOf(engine).run_id!;
      engine.advanceSteps(3); // 30 s at the configured 26 °C / 55 % RH
      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 32, rh_pct: 45 });
      engine.advanceSteps(3); // remaining 30 s at 32 °C / 45 % RH -> publishes the minute

      const rows = roomIntervals(db, runId);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.interval_seconds, 60);
      assert.equal(row.partial, 0);
      assert.ok(Math.abs(row.avg_temp_c - (26 * 30 + 32 * 30) / 60) < TOL, `weighted temp, got ${row.avg_temp_c}`);
      assert.ok(Math.abs(row.avg_rh_pct - (55 * 30 + 45 * 30) / 60) < TOL, `weighted rh, got ${row.avg_rh_pct}`);
      assert.notEqual(row.avg_temp_c, 32); // not simply the final value
      assert.notEqual(row.avg_temp_c, 26);
    } finally {
      closeDatabase(db);
    }
  });

  it('uses the same power in the step loop and in the exposed state, and only changes AC power', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 27, rh_pct: 55 });
      engine.advanceSteps(3);
      acIsOn(engine);

      const ac = deviceOf(engine, AC);
      assert.equal(ac.on, true);
      assert.ok(Math.abs(ac.power_w - 900) < TOL, `27 °C with no occupants -> 900 W (0.2 + 0.8 x 0.5), got ${ac.power_w}`);
      assert.equal(ac.power_w, acPowerW({ device: acRating(engine), on: true, temp_c: 27, rh_pct: 55, occupancy: 0 }));

      // One 10-second step must accumulate exactly power x 10 s of energy.
      const energyBefore = ac.energy_kwh;
      engine.advanceSteps(1);
      assert.ok(Math.abs(deviceOf(engine, AC).energy_kwh - energyBefore - (ac.power_w * STEP_SECONDS) / 3_600_000) < TOL);

      // Non-AC devices keep flat-rated behaviour.
      assert.equal(deviceOf(engine, 'dev-pantry-fridge').power_w, 150);
      engine.commandDevice('dev-open-workstations', { kind: 'set', on: true });
      assert.equal(deviceOf(engine, 'dev-open-workstations').power_w, 960); // quantity 8 is never multiplied in
      assert.equal(deviceOf(engine, 'dev-open-light-a').power_w + deviceOf(engine, 'dev-open-light-b').power_w, 0);
    } finally {
      closeDatabase(db);
    }
  });

  it('lets occupancy context raise AC power and humidity change readings without changing power', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const runId = stateOf(engine).run_id!;
      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 24, rh_pct: 55 }); // at the setpoint: no temperature demand
      engine.advanceSteps(2);
      acIsOn(engine);

      engine.setOccupancy({ mode: 'manual', total: 0 });
      const empty = deviceOf(engine, AC).power_w;
      assert.ok(Math.abs(empty - FLOOR_W) < TOL, `no cooling demand -> part-load floor, got ${empty}`);

      engine.setOccupancy({ mode: 'manual', total: 20 });
      const room = stateOf(engine).rooms.find((r) => r.room_id === AC_ROOM)!;
      const occupied = room.occupancy;
      assert.ok(occupied > 0, 'the open workspace holds occupants at manual total 20');
      const busy = deviceOf(engine, AC).power_w;
      assert.equal(busy, acPowerW({
        device: acRating(engine), on: true, temp_c: room.climate!.temp_c, rh_pct: room.climate!.rh_pct, occupancy: occupied,
      }));
      assert.ok(busy > empty, `occupancy internal gain must not reduce cooling power (${empty} -> ${busy})`);

      // Humidity is recorded faithfully but never moves the AC power.
      engine.setOccupancy({ mode: 'manual', total: 0 });
      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 24, rh_pct: 90 });
      assert.equal(deviceOf(engine, AC).power_w, empty);
      engine.advanceSteps(4); // 2 + 4 steps of 10 s complete the minute that started at 24 C / 55 % RH
      const rows = roomIntervals(db, runId);
      assert.equal(rows.length, 1);
      assert.ok(Math.abs(rows[0]!.avg_temp_c - 24) < TOL);
      assert.ok(Math.abs(rows[0]!.avg_rh_pct - (55 * 20 + 90 * 40) / 60) < TOL, `weighted rh, got ${rows[0]!.avg_rh_pct}`);
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps a legacy run on the flat model, rejects climate commands and leaves stored readings untouched', () => {
    const db = memoryDb();
    try {
      const building = db.prepare('SELECT building_id FROM buildings LIMIT 1').get() as { building_id: string };
      const startEpoch = Date.parse(INITIAL_SIM_TIME_UTC) / 1000;
      const legacyConfig = {
        mode: 'policy_control', layer: 'K3-K4', contract_version: '1.0.1',
        step_seconds: STEP_SECONDS, interval_seconds: 60, initial_sim_time_utc: INITIAL_SIM_TIME_UTC,
        environment: { synthetic: true, avg_temp_c: 26.0, avg_rh_pct: 55.0 },
        devices: {
          power_model: 'on => nominal_power_w (whole device/group); off => standby_power_w or 0. quantity is never multiplied in.',
        },
        occupancy_seed: 4242,
      };
      createRun(db, {
        run_id: 'run-legacy-k004', building_id: building.building_id, scenario_id: 'original',
        run_start_utc: INITIAL_SIM_TIME_UTC, config: legacyConfig,
      });
      db.prepare(`INSERT INTO engine_checkpoints (run_id, lifecycle, seq, sim_time_utc, speed, state, updated_utc)
          VALUES ('run-legacy-k004', 'active', 0, ?, 1, ?, 't')`).run(INITIAL_SIM_TIME_UTC, JSON.stringify({
        format: 2, devices: {}, rooms: {}, partial: { start_epoch: startEpoch, covered_seconds: 0, devices: {}, rooms: {} },
      }));

      const engine = new SimulationEngine(db);
      assert.ok(engine.recover());
      assert.equal(stateOf(engine).ac_power_model, null);
      assert.equal(stateOf(engine).rooms.find((r) => r.room_id === AC_ROOM)?.climate, null);
      assert.throws(() => engine.setEnvironment({ room_id: AC_ROOM, temp_c: 30, rh_pct: 40 }),
        (err: unknown) => (err as { status?: number }).status === 409);

      engine.advanceSteps(2);
      acIsOn(engine);
      assert.equal(deviceOf(engine, AC).power_w, 1500); // flat-rated legacy behaviour
      engine.advanceSteps(4); // completes the legacy minute
      const rows = roomIntervals(db, 'run-legacy-k004');
      assert.equal(rows[0]!.avg_temp_c, 26); // legacy constant run-level climate, unchanged
      assert.equal(rows[0]!.avg_rh_pct, 55);

      // A restart of the same legacy run keeps the legacy model and readings.
      engine.shutdown();
      const restarted = new SimulationEngine(db);
      assert.ok(restarted.recover());
      assert.equal(stateOf(restarted).ac_power_model, null);
      assert.equal(deviceOf(restarted, AC).power_w, 1500);
      assert.deepEqual(roomIntervals(db, 'run-legacy-k004'), rows);
    } finally {
      closeDatabase(db);
    }
  });

  it('restores the model, per-room climate and prior readings across a restart of a model run', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start();
      const runId = stateOf(engine).run_id!;
      engine.setEnvironment({ room_id: AC_ROOM, temp_c: 33, rh_pct: 30 });
      engine.setEnvironment({ room_id: 'room-meeting', temp_c: 21, rh_pct: 65 });
      engine.advanceSteps(3);
      acIsOn(engine);
      const beforeRestart = { rooms: roomIntervals(db, runId), devices: deviceIntervals(db, runId) };
      const powerBefore = deviceOf(engine, AC).power_w;
      engine.shutdown();

      const restarted = new SimulationEngine(db);
      assert.ok(restarted.recover());
      const state = stateOf(restarted);
      assert.equal(state.run_id, runId);
      assert.equal(state.ac_power_model, AC_POWER_MODEL_ID);
      assert.deepEqual(state.rooms.find((r) => r.room_id === AC_ROOM)?.climate, { temp_c: 33, rh_pct: 30 });
      assert.deepEqual(state.rooms.find((r) => r.room_id === 'room-meeting')?.climate, { temp_c: 21, rh_pct: 65 });
      assert.equal(deviceOf(restarted, AC).power_w, powerBefore);
      assert.deepEqual({ rooms: roomIntervals(db, runId, 'room-open-workspace'), devices: deviceIntervals(db, runId) }, beforeRestart);

      // Continuing after the restart keeps the weighted accumulation of the interrupted minute.
      restarted.advanceSteps(3);
      const rows = roomIntervals(db, runId, AC_ROOM);
      assert.equal(rows[0]!.interval_seconds, 60);
      assert.ok(Math.abs(rows[0]!.avg_temp_c - 33) < TOL, `climate was set before the minute started, got ${rows[0]!.avg_temp_c}`);
    } finally {
      closeDatabase(db);
    }
  });
});
