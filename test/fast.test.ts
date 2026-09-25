/**
 * K004-FAST1: hourly recording and interactive "advance days". In-memory
 * databases only; the scheduler is driven by a fake clock (no real waiting).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { closeDatabase, count, memoryDb } from './helpers.js';
import { TEST_LOAD, addTestLoad, fakeEngine } from './engineHelpers.js';
import type { Database } from '../src/db/connection.js';
import { addPolicyVersion } from '../src/db/inventory.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { HistoryJobService } from '../src/history/service.js';
import { validateHistoryRequest } from '../src/history/request.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const INITIAL = '2025-12-31T18:30:00Z'; // 2026-01-01 00:00 local
const HOUR_STEPS = 360;
const DAY_STEPS = 8640;
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const state = (e: SimulationEngine): Json => e.getState() as Json;

function scheduledOffice(db: Database): void {
  addPolicyVersion(db, { policy_id: 'pol-occupancy', effective_from_utc: '2000-01-01T00:00:00Z', rules: { mode: 'scheduled', auto_allocate: true } });
}

function rows(db: Database, runId: string, deviceId?: string): Json[] {
  return db.prepare(`SELECT device_id, room_id, interval_start_utc, interval_end_utc, interval_seconds, avg_power_w, max_power_w, energy_kwh,
      cumulative_kwh, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds, policy_id, policy_version, partial
      FROM device_intervals WHERE run_id = ? ${deviceId ? 'AND device_id = ?' : ''} ORDER BY interval_start_utc, device_id`)
    .all(...(deviceId ? [runId, deviceId] : [runId])) as Json[];
}
function roomRows(db: Database, runId: string): Json[] {
  return db.prepare(`SELECT room_id, interval_start_utc, interval_end_utc, interval_seconds, occupancy_avg, occupancy_max, occupied_fraction,
      avg_temp_c, avg_rh_pct, partial FROM room_intervals WHERE run_id = ? ORDER BY interval_start_utc, room_id`).all(runId) as Json[];
}
const runConfig = (db: Database, runId: string): Json =>
  JSON.parse((db.prepare('SELECT config FROM simulation_runs WHERE run_id = ?').get(runId) as { config: string }).config) as Json;

/** Drives an active advance with the fake clock: one scheduler tick processes at most 120 steps. */
function tick(engine: SimulationEngine, advanceMs: (ms: number) => void, ms = 1000): number {
  advanceMs(ms);
  return engine.scheduler.tick();
}

describe('K004-FAST1 hourly recording: known answers', () => {
  it('1 kW for 24 simulated hours = 24 kWh in 24 hourly intervals', () => {
    const db = memoryDb();
    try {
      addTestLoad(db, 1000);
      const { engine } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.advanceSteps(DAY_STEPS);
      const r = rows(db, state(engine).run_id, TEST_LOAD);
      assert.equal(r.length, 24);
      assert.ok(r.every((x) => x.interval_seconds === 3600 && near(x.energy_kwh, 1) && x.avg_power_w === 1000 && x.partial === 0));
      assert.ok(near(r.reduce((s, x) => s + x.energy_kwh, 0), 24));
      assert.ok(near(r.at(-1)!.cumulative_kwh, 24));
      assert.equal(r[0]!.interval_start_utc, INITIAL);
    } finally { closeDatabase(db); }
  });

  it('on for 15 minutes then off for 45: 0.25 kWh, average 250 W, peak 1000 W in one hourly interval', () => {
    const db = memoryDb();
    try {
      addTestLoad(db, 1000);
      const { engine } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      engine.advanceSteps(90);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: false });
      engine.advanceSteps(270);
      const [h] = rows(db, state(engine).run_id, TEST_LOAD);
      assert.ok(near(h!.energy_kwh, 0.25));
      assert.ok(near(h!.avg_power_w, 250));
      assert.equal(h!.max_power_w, 1000);
      assert.ok(near(h!.on_fraction, 0.25));
      assert.equal(h!.override_seconds, 3600); // override active (on, then off) for the whole hour
    } finally { closeDatabase(db); }
  });
});

describe('K004-FAST1 hourly recording: aggregation equals minute recording', () => {
  function runFor(record: 60 | 3600, steps: number): { db: Database; run: string } {
    const db = memoryDb();
    scheduledOffice(db);
    const { engine } = fakeEngine(db);
    engine.reset(2026, record);
    engine.advanceSteps(steps);
    return { db, run: state(engine).run_id as string };
  }

  it('26 simulated hours: every hourly interval is the duration-weighted aggregate of its 60 minutes', () => {
    const m = runFor(60, 26 * HOUR_STEPS);
    const h = runFor(3600, 26 * HOUR_STEPS);
    try {
      const hourly = rows(h.db, h.run);
      assert.equal(hourly.length, 26 * 18);
      const minute = rows(m.db, m.run);
      const byKey = new Map<string, Json[]>();
      for (const x of minute) {
        const hourStart = new Date(Math.floor((Date.parse(x.interval_start_utc) / 1000 + 19_800) / 3600) * 3600 * 1000 - 19_800_000)
          .toISOString().replace(/\.\d{3}Z$/, 'Z');
        const k = `${x.device_id}|${hourStart}`;
        byKey.set(k, [...(byKey.get(k) ?? []), x]);
      }
      for (const x of hourly) {
        const g = byKey.get(`${x.device_id}|${x.interval_start_utc}`)!;
        assert.equal(g.length, 60);
        const sum = (f: string): number => g.reduce((s, y) => s + (y[f] as number), 0);
        assert.ok(near(x.energy_kwh, sum('energy_kwh')), `${x.device_id} ${x.interval_start_utc}`);
        assert.ok(near(x.avg_power_w, sum('avg_power_w') / 60, 1e-6));
        assert.equal(x.max_power_w, Math.max(...g.map((y) => y.max_power_w as number)));
        assert.ok(near(x.on_fraction, sum('on_fraction') / 60));
        for (const f of ['override_seconds', 'vacant_on_seconds', 'offschedule_on_seconds']) assert.ok(near(x[f], sum(f)), f);
        assert.ok(near(x.cumulative_kwh, g.at(-1)!.cumulative_kwh as number));
        assert.equal(`${x.policy_id}:${x.policy_version}`, `${g[0]!.policy_id}:${g[0]!.policy_version}`);
      }
      const hr = roomRows(h.db, h.run);
      const mr = roomRows(m.db, m.run);
      for (const x of hr) {
        const g = mr.filter((y) => y.room_id === x.room_id && y.interval_start_utc >= x.interval_start_utc && y.interval_start_utc < x.interval_end_utc);
        assert.equal(g.length, 60);
        assert.ok(near(x.occupancy_avg, g.reduce((s, y) => s + y.occupancy_avg, 0) / 60));
        assert.equal(x.occupancy_max, Math.max(...g.map((y) => y.occupancy_max as number)));
        assert.ok(near(x.occupied_fraction, g.reduce((s, y) => s + y.occupied_fraction, 0) / 60));
        assert.ok(near(x.avg_temp_c, 26) && near(x.avg_rh_pct, 55));
      }
      assert.ok(hr.some((x) => x.occupancy_max > 0));
      assert.equal(runConfig(h.db, h.run).interval_seconds, 3600);
      assert.equal(runConfig(m.db, m.run).interval_seconds, 60);
    } finally { closeDatabase(m.db); closeDatabase(h.db); }
  });

  it('hourly results do not depend on how steps are batched', () => {
    const results: Json[][] = [];
    for (const chunk of [1, 7, 360, 1000]) {
      const db = memoryDb();
      try {
        scheduledOffice(db);
        const { engine } = fakeEngine(db);
        engine.reset(5, 3600);
        for (let done = 0; done < 30 * HOUR_STEPS;) { const n = Math.min(chunk, 30 * HOUR_STEPS - done); engine.advanceSteps(n); done += n; }
        results.push(rows(db, state(engine).run_id));
      } finally { closeDatabase(db); }
    }
    for (const r of results.slice(1)) assert.deepEqual(r, results[0]);
  });

  it('existing 60 s runs keep 60 s intervals; interval_seconds applies only at run creation', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.reset(1);
      assert.equal(state(engine).recording_interval_seconds, 60);
      assert.equal(runConfig(db, state(engine).run_id).interval_seconds, 60);
      assert.throws(() => engine.start(undefined, undefined, 3600), (e: { status?: number }) => e.status === 409);
      assert.throws(() => engine.reset(1, 300), (e: { status?: number }) => e.status === 400);
      engine.advanceSteps(12);
      assert.equal(rows(db, state(engine).run_id)[0]!.interval_seconds, 60);
      // Recovery of an hourly run keeps its interval.
      engine.reset(2, 3600);
      engine.shutdown();
      const again = new SimulationEngine(db);
      again.recover();
      assert.equal(state(again).recording_interval_seconds, 3600);
    } finally { closeDatabase(db); }
  });

  it('a calendar change in an hourly run takes effect at the next LOCAL HOUR boundary: one policy ref per interval', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.advanceSteps(100); // 00:16:40 local
      const res = engine.setCalendar({ working_days: [1, 2, 3, 4, 5], open_local: '08:00', close_local: '17:00' }) as Json;
      assert.equal(res.effective_sim_utc, '2025-12-31T19:30:00Z'); // 01:00 local
      assert.equal(res.applied, false);
      engine.advanceSteps(2 * HOUR_STEPS);
      const ac = rows(db, state(engine).run_id, 'dev-open-ac');
      assert.deepEqual(ac.map((x) => x.policy_version), [1, 2]);
      const pin = db.prepare(`SELECT active_from_utc FROM run_policies WHERE run_id = ? AND policy_id = 'pol-open-ac' AND version = 2`)
        .get(state(engine).run_id) as { active_from_utc: string };
      assert.equal(pin.active_from_utc, '2025-12-31T19:30:00Z');
    } finally { closeDatabase(db); }
  });

  it('restart mid-hour neither loses nor double-counts the partial hour', () => {
    const ref = memoryDb();
    const db = memoryDb();
    try {
      for (const d of [ref, db]) { scheduledOffice(d); addTestLoad(d, 1000); }
      const a = fakeEngine(ref).engine;
      a.reset(9, 3600);
      a.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      a.advanceSteps(12 * HOUR_STEPS);

      const b = fakeEngine(db).engine;
      b.reset(9, 3600);
      b.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      b.advanceSteps(9 * HOUR_STEPS + 170); // mid-hour
      b.shutdown(); // graceful: checkpoints the partial accumulator
      const c = fakeEngine(db).engine;
      c.recover();
      assert.equal(state(c).partial_interval.covered_seconds, 1700);
      c.advanceSteps(3 * HOUR_STEPS - 170);
      const strip = (r: Json[]): Json[] => r.map(({ ...x }) => x);
      assert.deepEqual(strip(rows(db, state(c).run_id)), strip(rows(ref, state(a).run_id)));
      assert.deepEqual(roomRows(db, state(c).run_id), roomRows(ref, state(a).run_id));
    } finally { closeDatabase(ref); closeDatabase(db); }
  });
});

describe('K004-FAST1 advance days (interactive run)', () => {
  it('advances exactly to the target, reports only processed time, then pauses', () => {
    const db = memoryDb();
    try {
      const { engine, advanceMs } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.advanceDays(1);
      assert.equal(state(engine).status, 'running');
      tick(engine, advanceMs);
      const mid = state(engine);
      assert.equal(mid.sim_time_utc, '2025-12-31T18:50:00Z'); // 120 processed steps, not the target
      assert.equal(mid.advance.active, true);
      assert.equal(mid.advance.target_sim_utc, '2026-01-01T18:30:00Z');
      assert.equal(mid.advance.processed_steps, 120);
      assert.equal(mid.advance.expected_steps, DAY_STEPS);
      let guard = 0;
      while (state(engine).advance.active && guard++ < 1000) tick(engine, advanceMs);
      const end = state(engine);
      assert.equal(end.status, 'paused');
      assert.equal(end.sim_time_utc, '2026-01-01T18:30:00Z');
      assert.deepEqual([end.advance.active, end.advance.last.outcome, end.advance.last.processed_steps], [false, 'completed', DAY_STEPS]);
      assert.equal(count(db, 'device_intervals'), 24 * 18);
      tick(engine, advanceMs, 60_000); // no further time while paused
      assert.equal(state(engine).sim_time_utc, '2026-01-01T18:30:00Z');
    } finally { closeDatabase(db); }
  });

  it('a device command during the advance applies at the processed step boundary and affects that hour', () => {
    const db = memoryDb();
    try {
      addTestLoad(db, 1000);
      const { engine, advanceMs } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.advanceDays(1);
      tick(engine, advanceMs);
      tick(engine, advanceMs); // 240 steps = 40 min processed
      const res = engine.commandDevice(TEST_LOAD, { kind: 'set', on: true }) as Json;
      assert.equal(res.sim_time_utc, '2025-12-31T19:10:00Z');
      let guard = 0;
      while (state(engine).advance.active && guard++ < 1000) tick(engine, advanceMs);
      const r = rows(db, state(engine).run_id, TEST_LOAD);
      assert.ok(near(r[0]!.energy_kwh, 1 / 3)); // on for the last 20 minutes of hour 1
      assert.ok(near(r[0]!.on_fraction, 1 / 3));
      assert.equal(r[0]!.max_power_w, 1000);
      assert.ok(near(r[1]!.energy_kwh, 1));
      assert.ok(near(r.reduce((s, x) => s + x.energy_kwh, 0), 1 / 3 + 23));
    } finally { closeDatabase(db); }
  });

  it('stop and pause freeze time and energy; runners cannot overlap; bad day counts are rejected', () => {
    const db = memoryDb();
    try {
      addTestLoad(db, 1000);
      const { engine, advanceMs } = fakeEngine(db);
      engine.reset(1, 3600);
      engine.commandDevice(TEST_LOAD, { kind: 'set', on: true });
      for (const bad of [0, 32, 1.5, '7']) assert.throws(() => engine.advanceDays(bad), (e: { status?: number }) => e.status === 400);
      engine.advanceDays(7);
      assert.throws(() => engine.advanceDays(1), (e: { status?: number }) => e.status === 409);
      assert.throws(() => engine.start(), (e: { status?: number }) => e.status === 409);
      assert.throws(() => engine.resume(), (e: { status?: number }) => e.status === 409);
      assert.throws(() => engine.reset(), (e: { status?: number }) => e.status === 409);
      tick(engine, advanceMs);
      engine.stopAdvance();
      const frozen = state(engine);
      tick(engine, advanceMs, 5000);
      assert.deepEqual(state(engine), frozen);
      assert.equal(frozen.status, 'paused');
      assert.equal(frozen.advance.last.outcome, 'stopped');
      assert.equal(frozen.sim_time_utc, '2025-12-31T18:50:00Z');

      engine.advanceDays(1);
      tick(engine, advanceMs);
      engine.pause(); // pause also stops an advance
      const p = state(engine);
      tick(engine, advanceMs, 5000);
      assert.deepEqual(state(engine), p);
      assert.equal(p.advance.last.outcome, 'stopped');

      engine.start(); // normal clock again; advance refused while it runs
      assert.throws(() => engine.advanceDays(1), (e: { status?: number }) => e.status === 409);
      engine.pause();
      engine.setSpeed(60); // user speed survives an advance
      engine.advanceDays(1);
      engine.stopAdvance();
      assert.equal(state(engine).speed, 60);
    } finally { closeDatabase(db); }
  });

  it('a batch history engine refuses advance', () => {
    const db = memoryDb();
    try {
      const engine = new SimulationEngine(db, { batch: { onCommit: () => undefined } });
      assert.throws(() => engine.advanceDays(1), (e: { status?: number }) => e.status === 409);
    } finally { closeDatabase(db); }
  });
});

describe('K004-FAST1 hourly history jobs (K005 generation)', () => {
  it('validates local-hour alignment and keeps calendar-month semantics for 3600 s jobs', () => {
    const db = memoryDb();
    try {
      const jan = validateHistoryRequest(db, { month: '2026-01', interval_seconds: 3600, seed: 1 }, () => 0);
      assert.deepEqual([jan.from_utc, jan.to_utc, jan.expected_intervals, jan.expected_steps], ['2025-12-31T18:30:00Z', '2026-01-31T18:30:00Z', 744, 31 * DAY_STEPS]);
      assert.equal(validateHistoryRequest(db, { month: '2028-02', interval_seconds: 3600, seed: 1 }, () => 0).expected_intervals, 29 * 24);
      assert.throws(() => validateHistoryRequest(db, { from: '2026-01-05T03:00:00Z', to: '2026-01-05T05:00:00Z', interval_seconds: 3600 }, () => 0),
        (e: { field?: string }) => e.field === 'from');
      assert.throws(() => validateHistoryRequest(db, { month: '2026-01', interval_seconds: 1800 }, () => 0), (e: { field?: string }) => e.field === 'interval_seconds');
    } finally { closeDatabase(db); }
  });

  it('an hourly job produces verified hourly history in its own run and never touches the interactive run', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const { engine } = fakeEngine(db);
      engine.reset(3, 3600);
      engine.advanceSteps(100);
      engine.pause();
      const before = { state: state(engine), cp: db.prepare('SELECT * FROM engine_checkpoints').all() };
      const service = new HistoryJobService(db);
      service.start();
      const job = service.submit({ from: '2026-01-04T18:30:00Z', to: '2026-01-06T18:30:00Z', interval_seconds: 3600, seed: 3 }) as Json;
      await service.idle();
      const done = service.get(job.job_id) as Json;
      assert.equal(done.status, 'succeeded');
      assert.deepEqual([done.progress.completed_intervals, done.progress.expected_intervals, done.requested.interval_seconds], [48, 48, 3600]);
      const r = rows(db, done.run_id);
      assert.equal(r.length, 48 * 18);
      assert.ok(r.every((x) => x.interval_seconds === 3600 && x.partial === 0));
      assert.equal(runConfig(db, done.run_id).interval_seconds, 3600);
      assert.deepEqual(state(engine), before.state);
      assert.deepEqual(db.prepare('SELECT * FROM engine_checkpoints').all(), before.cp);
      assert.equal(new SimulationEngine(db).recover()?.run_id, before.state.run_id);
    } finally { closeDatabase(db); }
  });
});
